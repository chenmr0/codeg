import type { Node } from '../types';

const CALLABLES = new Set(['method', 'function', 'constructor', 'component']);
const CONTAINERS = new Set(['class', 'struct', 'interface', 'trait', 'protocol', 'enum', 'module']);
const GAP = '\n\n... (gap) ...\n\n';

export interface ExploreSourceFile {
  path: string;
  content: string;
  nodes: Node[];
  /** Lower is better: explicit callable, named type member, connected, peripheral. */
  priority: (node: Node) => number;
  /** Structural tie breaker within a tier, never a domain-specific symbol list. */
  connectivity: (node: Node) => number;
  skeleton: boolean;
  bodyAllowed: (node: Node) => boolean;
}
interface Unit { node: Node; start: number; end: number; full: boolean; priority: number; connectivity: number }
interface Plan { file: ExploreSourceFile; lines: string[]; units: Unit[]; selected: Unit[]; rank: number }
export interface ExploreSelectionOptions {
  maxOutputChars: number;
  maxCharsPerFile: number;
  maxFiles: number;
  lineNumbers: boolean;
  headerSymbols: number;
}

/** Select function bodies before presentation. No adjacency clustering or tail slicing. */
export function renderExploreSources(prefix: string, files: ExploreSourceFile[], options: ExploreSelectionOptions): string {
  const renderLines = (p: Plan, start: number, end: number) => p.lines.slice(start - 1, end)
    .map((line, i) => options.lineNumbers ? `${start + i}\t${line}` : line).join('\n');
  const plans: Plan[] = files.map((file, rank) => {
    const lines = file.content.replace(/\r\n/g, '\n').split('\n');
    const seen = new Set<string>();
    const units: Unit[] = [];
    for (const node of file.nodes) {
      if (node.startLine < 1 || node.endLine < node.startLine || node.endLine > lines.length) continue;
      if (['file', 'import', 'export', 'namespace', 'parameter'].includes(node.kind)) continue;
      const callable = CALLABLES.has(node.kind) && !node.isDeclaration;
      const full = callable && file.bodyAllowed(node);
      // A container is an outline, never an envelope swallowing its members.
      const outline = CONTAINERS.has(node.kind) || (CALLABLES.has(node.kind) && !full);
      const end = outline ? node.startLine : node.endLine;
      const key = `${node.startLine}:${end}:${full}`;
      if (seen.has(key)) continue;
      seen.add(key);
      units.push({ node, start: node.startLine, end, full,
        priority: full ? file.priority(node) : outline ? 10 : 5,
        connectivity: file.connectivity(node) });
    }
    units.sort((a, b) => a.priority - b.priority || b.connectivity - a.connectivity
      || a.start - b.start || a.end - b.end || a.node.id.localeCompare(b.node.id));
    return { file, lines, units, selected: [], rank };
  }).filter(p => p.units.length > 0);

  // Definitions beat declaration-only files, even when the named type is in a header.
  plans.sort((a, b) => a.units[0]!.priority - b.units[0]!.priority || a.rank - b.rank);
  const admitted = plans.slice(0, options.maxFiles);
  const ranges = (units: Unit[]) => {
    const result: Array<{ start: number; end: number }> = [];
    for (const u of [...units].sort((a, b) => a.start - b.start || b.end - a.end)) {
      const prev = result.at(-1);
      // Only overlapping/adjacent selected spans merge, never unselected gaps.
      if (prev && u.start <= prev.end + 1) prev.end = Math.max(prev.end, u.end);
      else result.push({ start: u.start, end: u.end });
    }
    return result;
  };
  const section = (p: Plan, units = p.selected): string => {
    if (units.length === 0) return '';
    const names = [...new Set(units.map(u => u.node.name))].slice(0, options.headerSymbols).join(', ');
    const tag = p.file.skeleton && !units.some(u => u.full)
      ? 'skeleton (signatures only; bodies are not included)'
      : 'focused (complete selected bodies and source ranges; types are outlines)';
    return `#### ${p.file.path} — ${names} · ${tag}\n\n\`\`\`${p.file.nodes[0]?.language ?? ''}\n`
      + ranges(units).map(r => renderLines(p, r.start, r.end)).join(GAP) + '\n```\n\n';
  };
  // All reservations and fit tests charge actual headers, fences, gaps and line numbers.
  const footerReserve = Math.min(1000, Math.floor(options.maxOutputChars * 0.06));
  const pool = Math.max(0, options.maxOutputChars - prefix.length - footerReserve);
  const cost = (p: Plan) => section(p).length;
  let spent = 0;
  const add = (p: Plan, u: Unit, ceiling: number): boolean => {
    if (p.selected.includes(u)) return true;
    const before = cost(p);
    const after = section(p, [...p.selected, u]).length;
    const delta = after - before;
    if (after > ceiling || spent + delta > pool) return false;
    p.selected.push(u); spent += delta; return true;
  };

  // Reserve a compact complete unit for each anchored file. Ordinary neighbors
  // are not entitled to consume an explicit target's funding before selection.
  // Within the best tier choose the cheapest unit, not a giant first method.
  for (const p of admitted) {
    const best = p.units[0]!.priority;
    if (best > 2) continue;
    const initial = p.units.filter(u => u.priority === best)
      .map(u => ({ u, size: section(p, [u]).length }))
      .sort((a, b) => a.size - b.size || b.u.connectivity - a.u.connectivity || a.u.start - b.u.start);
    for (const { u } of initial) {
      if (add(p, u, options.maxCharsPerFile)) break;
    }
  }
  const candidates = admitted.flatMap(p => p.units.map(u => ({ p, u })))
    .sort((a, b) => a.u.priority - b.u.priority || b.u.connectivity - a.u.connectivity
      || a.p.rank - b.p.rank || a.u.start - b.u.start);
  // Reclaim capacity tier by tier: lower-priority filler cannot spend bytes
  // before an explicit target has had a chance to borrow unused capacity.
  // Other files' funded first units remain protected throughout.
  for (const priority of [...new Set(candidates.map(c => c.u.priority))]) {
    const tier = candidates.filter(c => c.u.priority === priority);
    const demands = new Map(admitted.map(p => [p,
      section(p, [...p.selected, ...p.units.filter(u => u.priority === priority)]).length]));
    // Compact member groups get their ordinary allowance before large groups
    // borrow. Otherwise newly admitted implementation files can erase all
    // inline predicates in a named type's header merely by being longer.
    const ordinary = priority >= 2 ? [...tier].sort((a, b) => {
      return demands.get(a.p)! - demands.get(b.p)! || a.p.rank - b.p.rank
        || b.u.connectivity - a.u.connectivity || a.u.start - b.u.start;
    }) : tier;
    for (const { p, u } of ordinary) add(p, u, options.maxCharsPerFile);
    for (const { p, u } of tier) {
      if (u.full) add(p, u, pool);
    }
  }

  // If a single required body cannot fit, expose a bounded whole-line prefix with
  // an explicit incomplete range. Do not mislabel its first line as a full body.
  const partials = new Map<Plan, { start: number; end: number; wantedEnd: number; text: string }>();
  for (const p of admitted) {
    if (p.selected.some(u => u.full) || p.file.skeleton) continue;
    const u = p.units.find(u => u.full);
    if (!u) continue;
    const available = Math.min(options.maxCharsPerFile, pool - spent);
    const header = `#### ${p.file.path} — ${u.node.name} · partial body (required ${u.start}-${u.end})\n\n`;
    let end = u.start - 1, body = '';
    for (let line = u.start; line <= u.end; line++) {
      const next = renderLines(p, line, line);
      if (header.length + body.length + next.length + 100 > available) break;
      body += (body ? '\n' : '') + next; end = line;
    }
    if (end < u.start) continue;
    const text = header + `Shown ${u.start}-${end}; remaining body is omitted.\n\n\`\`\`${p.file.nodes[0]?.language ?? ''}\n${body}\n\`\`\`\n\n`;
    if (spent + text.length > pool) continue;
    spent += text.length;
    partials.set(p, { start: u.start, end, wantedEnd: u.end, text });
  }
  let output = prefix;
  for (const p of admitted) output += section(p) + (partials.get(p)?.text ?? '');
  // Coverage is derived from emitted ranges. A parent body can cover an inner
  // function, but an outline, Flow mention or partial body cannot establish it.
  const missing = plans.flatMap(p => {
    const shown = ranges(p.selected);
    return p.units.filter(u => u.full && !shown.some(r => r.start <= u.start && r.end >= u.end))
      .map(u => `${p.file.path}:${u.start}-${u.end} ${u.node.name}`);
  });
  if (missing.length) {
    const lead = `> ${missing.length} candidate function bodies not fully shown; outlines and Flow are not body coverage.\n`;
    if (output.length + lead.length <= options.maxOutputChars) output += lead;
    for (const target of missing.slice(0, 8)) {
      const line = `- Omitted body: ${target}\n`;
      if (output.length + line.length > options.maxOutputChars) break;
      output += line;
    }
  }
  return output;
}
