import type { Node } from '../types';

const CALLABLES = new Set(['method', 'function', 'constructor', 'component']);
const CONTAINERS = new Set(['class', 'struct', 'interface', 'trait', 'protocol', 'enum', 'module']);
const GAP = '\n\n... (gap) ...\n\n';

export interface ExploreSourceFile {
  path: string;
  content: string;
  nodes: Node[];
  /** Lower is better: explicit/flow, contract/entry processing, member, neighbor. */
  priority: (node: Node) => number;
  /** Structural tie breaker within a tier, never a domain-specific symbol list. */
  connectivity: (node: Node) => number;
  skeleton: boolean;
  bodyAllowed: (node: Node) => boolean;
  /** Explicit file-path match, not an ordinary retrieval seed. */
  pinned?: boolean;
  /** Canonical exact targets (including declaration-to-definition resolution). */
  protectedNodeIds?: ReadonlySet<string>;
  /** Literal requested source spans; these must not expand to enclosing functions. */
  requestedRanges?: ReadonlyArray<{ start: number; end: number }>;
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
  if (files.some(f => f.pinned || f.nodes.some(node => f.protectedNodeIds?.has(node.id)) || f.requestedRanges?.length)) {
    return renderTargetedExploreSources(prefix, files, options);
  }
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
  const ranges = (units: ReadonlyArray<Pick<Unit, 'start' | 'end'>>) => {
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
  // Keep compact anchored mechanisms together before large entry chains borrow
  // globally. Otherwise a broad query can gain one task body by losing several
  // already affordable bodies belonging to another independent query anchor.
  for (const p of admitted) {
    const anchored = p.units.filter(u => u.full && u.priority <= 2);
    if (!anchored.length || section(p, anchored).length > options.maxCharsPerFile) continue;
    for (const u of anchored) add(p, u, options.maxCharsPerFile);
  }
  const candidates = admitted.flatMap(p => p.units.map(u => ({ p, u })))
    .sort((a, b) => a.u.priority - b.u.priority || b.u.connectivity - a.u.connectivity
      || a.p.rank - b.p.rank || a.u.start - b.u.start);
  // Reclaim capacity tier by tier: lower-priority filler cannot spend bytes
  // before an explicit target has had a chance to borrow unused capacity.
  // Other files' funded first units remain protected throughout.
  for (const priority of [...new Set(candidates.map(c => c.u.priority))]) {
    const tier = candidates.filter(c => c.u.priority === priority);
    // An entry's processing chain must get a chance to fit as complete bodies
    // before smaller helpers in that chain spend the remaining capacity.
    // Other anchored files retain their funded first units.
    if (priority > 1 && priority < 2) {
      for (const { p, u } of tier) add(p, u, pool);
      continue;
    }
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
    const partial = partials.get(p);
    const shown = ranges([...p.selected, ...(partial ? [{ start: partial.start, end: partial.end }] : [])]);
    return p.units.filter(u => u.full).flatMap(u => {
      const covered = shown.map(r => ({ start: Math.max(r.start, u.start), end: Math.min(r.end, u.end) }))
        .filter(r => r.start <= r.end);
      const gaps: Array<{ start: number; end: number }> = [];
      let next = u.start;
      for (const r of covered) {
        if (next < r.start) gaps.push({ start: next, end: r.start - 1 });
        next = r.end + 1;
      }
      if (next <= u.end) gaps.push({ start: next, end: u.end });
      return gaps.length ? [{ p, u, covered, gaps }] : [];
    });
  }).sort((a, b) => a.u.priority - b.u.priority || b.u.connectivity - a.u.connectivity
    || a.p.rank - b.p.rank || a.u.start - b.u.start);
  if (missing.length) {
    const lead = `> ${missing.length} candidate function bodies not fully shown; highest-priority gaps below (not exhaustive). Outlines and Flow are not body coverage.\n`;
    if (output.length + lead.length <= options.maxOutputChars) output += lead;
    const spans = (rs: Array<{ start: number; end: number }>) => rs.length
      ? rs.slice(0, 3).map(r => r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`).join(',')
        + (rs.length > 3 ? `,... (+${rs.length - 3} ranges)` : '') : 'none';
    for (const { p, u, covered, gaps } of missing.slice(0, 8)) {
      const line = `- Omitted body: ${p.file.path}:${u.start}-${u.end} ${u.node.name}; shown ${spans(covered)}; missing ${spans(gaps)}\n`;
      if (output.length + line.length > options.maxOutputChars) break;
      output += line;
    }
  }
  return output;
}

interface SourceSpan { start: number; end: number }
interface TargetUnit extends SourceSpan {
  name: string;
  node?: Node;
  body: boolean;
  explicit: boolean;
  /** Retain the original target range without treating an outline as body coverage. */
  outline?: 'type' | 'declaration' | 'signature';
  priority: number;
  connectivity: number;
}
interface TargetPlan {
  file: ExploreSourceFile;
  lines: string[];
  rank: number;
  admission: number;
  targets: TargetUnit[];
  ordinary: TargetUnit[];
  selected: SourceSpan[];
}

/** Explicit targets have a separate reservation pass. The historical allocator
 * remains unchanged for queries without path, range or qualified-member intent. */
function renderTargetedExploreSources(prefix: string, files: ExploreSourceFile[], options: ExploreSelectionOptions): string {
  const limit = Math.max(0, Math.floor(options.maxOutputChars));
  if (prefix.length >= limit) return prefix.slice(0, limit);
  const merge = (spans: ReadonlyArray<SourceSpan>): SourceSpan[] => {
    const result: SourceSpan[] = [];
    for (const span of [...spans].sort((a, b) => a.start - b.start || a.end - b.end)) {
      const previous = result.at(-1);
      if (previous && span.start <= previous.end + 1) previous.end = Math.max(previous.end, span.end);
      else result.push({ ...span });
    }
    return result;
  };
  const intersect = (spans: ReadonlyArray<SourceSpan>, target: SourceSpan) => merge(spans.map(span => ({
    start: Math.max(span.start, target.start), end: Math.min(span.end, target.end),
  })).filter(span => span.start <= span.end));
  const missing = (spans: ReadonlyArray<SourceSpan>, target: SourceSpan): SourceSpan[] => {
    const gaps: SourceSpan[] = [];
    let next = target.start;
    for (const span of intersect(spans, target)) {
      if (next < span.start) gaps.push({ start: next, end: span.start - 1 });
      next = Math.max(next, span.end + 1);
    }
    if (next <= target.end) gaps.push({ start: next, end: target.end });
    return gaps;
  };
  const plans: TargetPlan[] = files.map((file, rank) => {
    const lines = file.content.replace(/\r\n/g, '\n').split('\n');
    const targets: TargetUnit[] = [];
    const ordinary: TargetUnit[] = [];
    const seen = new Set<string>();
    for (const node of file.nodes) {
      if (node.startLine < 1 || node.endLine < node.startLine || node.endLine > lines.length) continue;
      if (['file', 'import', 'export', 'namespace', 'parameter'].includes(node.kind)) continue;
      const explicit = file.protectedNodeIds?.has(node.id) ?? false;
      // Exact source targets outrank relevance/skeleton gates. Freshness is
      // validated by the source loader before any file reaches this renderer.
      const body = CALLABLES.has(node.kind) && !node.isDeclaration && (explicit || file.bodyAllowed(node));
      const outline = CONTAINERS.has(node.kind) || (CALLABLES.has(node.kind) && !body);
      const targetOutline: TargetUnit['outline'] = explicit && outline
        ? CONTAINERS.has(node.kind) ? 'type' : node.isDeclaration ? 'declaration' : 'signature'
        : undefined;
      const unit: TargetUnit = { start: node.startLine, end: targetOutline ? node.endLine : outline ? node.startLine : node.endLine,
        name: node.name, node, body, explicit, outline: targetOutline,
        priority: body ? file.priority(node) : outline ? 10 : 5, connectivity: file.connectivity(node) };
      const key = `${unit.start}:${unit.end}:${body}`;
      // Explicit evidence wins if declaration aliases share a source range.
      if (seen.has(key) && !explicit) continue;
      seen.add(key);
      if (explicit) targets.push(unit);
      else if (!file.requestedRanges?.some(range => range.end > range.start)
        && !file.requestedRanges?.some(range => range.start <= unit.end && range.end >= unit.start)) ordinary.push(unit);
    }
    for (const range of file.requestedRanges ?? []) {
      if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 1 || range.end < range.start) continue;
      targets.push({ ...range, name: 'requested source range', body: false, explicit: true, priority: -1, connectivity: 0 });
    }
    ordinary.sort((a, b) => a.priority - b.priority || b.connectivity - a.connectivity || a.start - b.start);
    // A path-only request to an unindexed file still has useful source evidence.
    if (file.pinned && !targets.length && !ordinary.length) targets.push({ start: 1, end: lines.length,
      name: 'requested file', body: false, explicit: true, priority: 0, connectivity: 0 });
    const admission = file.requestedRanges?.some(range => range.end > range.start) ? 0
      : targets.some(unit => unit.body) ? 1 : targets.length ? 2 : file.pinned ? 3 : 4;
    return { file, lines, rank, admission, targets, ordinary, selected: [] };
  }).filter(plan => plan.targets.length || plan.ordinary.length);
  plans.sort((a, b) => a.admission - b.admission
    || (a.admission === 4 ? (a.ordinary[0]?.priority ?? 10) - (b.ordinary[0]?.priority ?? 10) : 0)
    || a.rank - b.rank);
  const admitted = plans.slice(0, Math.max(0, options.maxFiles));
  const admittedSet = new Set(admitted);
  const sourceText = (plan: TargetPlan, span: SourceSpan) => plan.lines.slice(span.start - 1, span.end)
    .map((line, i) => options.lineNumbers ? `${span.start + i}\t${line}` : line).join('\n');
  const section = (plan: TargetPlan, selection = plan.selected): string => {
    if (!selection.length) return '';
    const spans = merge(selection);
    const represented = [...plan.targets, ...plan.ordinary].filter(unit => intersect(spans, unit).length);
    const names = [...new Set(represented.map(unit => unit.name))].slice(0, options.headerSymbols).join(', ');
    // Completeness is stated only in the range ledger, never inferred from a heading.
    return `#### ${plan.file.path} — ${names} · focused source ranges (coverage below)\n\n\`\`\`${plan.file.nodes[0]?.language ?? ''}\n`
      + spans.map(span => sourceText(plan, span)).join(GAP) + '\n```\n\n';
  };
  const formatSpans = (spans: SourceSpan[]) => spans.length ? spans.map(span => span.start === span.end
    ? `${span.start}` : `${span.start}-${span.end}`).join(',') : 'none';
  const ledgerLine = (plan: TargetPlan, unit: TargetUnit): string => {
    const shown = intersect(plan.selected, unit);
    const gaps = missing(plan.selected, unit);
    const state = unit.outline === 'type' ? 'Outline only'
      : unit.outline === 'declaration' ? 'Declaration only'
      : unit.outline === 'signature' ? 'Signature only'
      : gaps.length ? 'Omitted target' : 'Complete target';
    const reason = !admittedSet.has(plan) ? '; file omitted by maxFiles' : '';
    const bodyNote = unit.outline ? '; body not included' : '';
    return `- ${state}: ${plan.file.path}:${unit.start}-${unit.end} ${unit.name}; shown ${formatSpans(shown)}; missing ${formatSpans(gaps)}${bodyNote}${reason}\n`;
  };
  const explicit = plans.flatMap(plan => plan.targets.map(unit => ({ plan, unit })));
  const ledgerHeading = '> Explicit target coverage (source ranges actually emitted):\n';
  // Reserve the target ledger before spending on source. Large query lists are
  // summarized rather than allowing diagnostics to exceed the output contract.
  const estimatedLedger = ledgerHeading.length + explicit.slice(0, 12)
    .reduce((size, { plan, unit }) => size + ledgerLine(plan, unit).length + 24, 0) + 100;
  const reserve = Math.min(Math.floor((limit - prefix.length) * 0.3), Math.max(300, estimatedLedger));
  const pool = Math.max(0, limit - prefix.length - reserve);
  let spent = 0;
  const change = (plan: TargetPlan, span: SourceSpan, ceiling: number): boolean => {
    const clipped = { start: Math.max(1, span.start), end: Math.min(plan.lines.length, span.end) };
    if (clipped.start > clipped.end) return false;
    const selected = merge([...plan.selected, clipped]);
    const before = section(plan).length;
    const after = section(plan, selected).length;
    if (after > ceiling || spent + after - before > pool) return false;
    plan.selected = selected;
    spent += after - before;
    return true;
  };
  const minimum = (plan: TargetPlan, unit: TargetUnit): SourceSpan => {
    let end = unit.start;
    if (unit.body && unit.end > unit.start) {
      // Include executable body lines, not just a possibly multiline signature.
      const opening = plan.lines.slice(unit.start - 1, unit.end).findIndex(line => line.includes('{'));
      end = opening >= 0 ? unit.start + opening + 2 : unit.start + 5;
    }
    return { start: unit.start, end: Math.min(unit.end, plan.lines.length, end) };
  };
  const required = explicit.filter(({ plan }) => admittedSet.has(plan));
  const selectable = (unit: TargetUnit): SourceSpan => ({ start: unit.start, end: unit.outline ? unit.start : unit.end });
  const minima = required.map(({ plan, unit }) => ({ plan, unit, span: minimum(plan, unit) }));
  const combinedMinimum = new Map<TargetPlan, SourceSpan[]>();
  for (const { plan, span } of minima) combinedMinimum.set(plan, [...(combinedMinimum.get(plan) ?? []), span]);
  const minimumCost = [...combinedMinimum].reduce((size, [plan, spans]) => size + section(plan, merge(spans)).length, 0);
  if (minimumCost <= pool) {
    for (const { plan, span } of minima) change(plan, span, pool);
  } else {
    const share = Math.floor(pool / Math.max(1, required.length));
    for (const { plan, span } of minima) change(plan, span, section(plan).length + share);
    // A long signature that cannot fit its equal share must not consume a later
    // target's minimum. Reclaim only after every target has had its turn.
    for (const { plan, span } of minima) change(plan, span, pool);
  }
  const byCost = [...required].sort((a, b) => section(a.plan, [...a.plan.selected, selectable(a.unit)]).length - section(a.plan).length
    - (section(b.plan, [...b.plan.selected, selectable(b.unit)]).length - section(b.plan).length)
    || a.plan.rank - b.plan.rank || a.unit.start - b.unit.start);
  for (const { plan, unit } of byCost) change(plan, selectable(unit), options.maxCharsPerFile);
  for (const { plan, unit } of byCost) change(plan, selectable(unit), pool);
  // Extend incomplete explicit evidence even when another body in the same file
  // is already complete. Every extension ends on a whole source line.
  for (const { plan, unit } of required) {
    if (unit.outline || !missing(plan.selected, unit).length) continue;
    const first = minimum(plan, unit);
    if (missing(plan.selected, first).length && !change(plan, first, options.maxCharsPerFile)) continue;
    for (let end = first.end + 1; end <= Math.min(unit.end, plan.lines.length); end++) {
      if (!change(plan, { start: unit.start, end }, options.maxCharsPerFile)) break;
    }
  }
  // Path-only files get a compact unit before ordinary neighboring files. Exact
  // targets have already reserved evidence and cannot be displaced by this pass.
  for (const plan of admitted) {
    if (plan.targets.length || (!plan.file.pinned && (plan.ordinary[0]?.priority ?? 10) > 2)) continue;
    const best = plan.ordinary[0]?.priority;
    for (const unit of plan.ordinary.filter(unit => unit.priority === best)
      .sort((a, b) => section(plan, [a]).length - section(plan, [b]).length)) {
      if (change(plan, unit, options.maxCharsPerFile)) break;
    }
    if (plan.file.pinned && !plan.selected.length) {
      const unit = plan.ordinary.find(candidate => candidate.body);
      if (!unit) continue;
      const first = minimum(plan, unit);
      if (!change(plan, first, options.maxCharsPerFile)) continue;
      for (let end = first.end + 1; end <= unit.end; end++) {
        if (!change(plan, { start: unit.start, end }, options.maxCharsPerFile)) break;
      }
    }
  }
  const ordinary = admitted.flatMap(plan => plan.ordinary.map(unit => ({ plan, unit })))
    .sort((a, b) => a.unit.priority - b.unit.priority || b.unit.connectivity - a.unit.connectivity
      || a.plan.rank - b.plan.rank || a.unit.start - b.unit.start);
  for (const { plan, unit } of ordinary) change(plan, unit, options.maxCharsPerFile);
  for (const { plan, unit } of ordinary) if (unit.body) change(plan, unit, pool);
  let output = prefix + admitted.map(plan => section(plan)).join('');
  const append = (text: string): boolean => {
    if (output.length + text.length > limit) return false;
    output += text; return true;
  };
  if (explicit.length) {
    append(ledgerHeading);
    // Omitted explicit targets come first, including files excluded by maxFiles.
    const ordered = [...explicit].sort((a, b) => Number(!!missing(b.plan.selected, b.unit).length)
      - Number(!!missing(a.plan.selected, a.unit).length) || a.plan.rank - b.plan.rank || a.unit.start - b.unit.start);
    let listed = 0;
    for (const { plan, unit } of ordered) {
      if (!append(ledgerLine(plan, unit))) break;
      listed++;
    }
    if (listed < explicit.length) append(`> ${explicit.length - listed} additional explicit targets are not listed; do not assume their coverage.\n`);
  }
  const ordinaryGaps = plans.flatMap(plan => plan.ordinary.filter(unit => unit.body && missing(plan.selected, unit).length)
    .map(unit => ({ plan, unit })));
  if (ordinaryGaps.length) {
    append(`> ${ordinaryGaps.length} other candidate function bodies not fully shown; outlines and Flow are not body coverage.\n`);
    for (const { plan, unit } of ordinaryGaps.slice(0, 8)) {
      const line = `- Omitted body: ${plan.file.path}:${unit.start}-${unit.end} ${unit.name}; shown ${formatSpans(intersect(plan.selected, unit))}; missing ${formatSpans(missing(plan.selected, unit))}\n`;
      if (!append(line)) break;
    }
  }
  return output;
}
