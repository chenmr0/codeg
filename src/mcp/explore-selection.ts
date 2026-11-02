import type { Node } from '../types';
import { allocateExploreFiles } from './explore-allocation';
import { selectExploreWindow } from './explore-windows';

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
  /** File relevance and expected source value, independent of presentation order. */
  relevance?: number;
  worth?: number;
  named?: boolean;
  spine?: boolean;
  /** Source-proven call sites keyed by the canonical caller ID. */
  focusLines?: ReadonlyMap<string, readonly number[]>;
}
interface Unit { node: Node; start: number; end: number; full: boolean; priority: number; connectivity: number; partial?: boolean }
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
  const limit = Math.max(0, Math.floor(options.maxOutputChars));
  if (prefix.length >= limit) return prefix.slice(0, limit);
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
    const tag = p.file.skeleton && !units.some(u => u.full || u.partial)
      ? 'skeleton (signatures only; bodies are not included)'
      : units.some(u => u.partial) ? 'partial body windows (remaining body is omitted; coverage below)'
      : 'focused (complete selected bodies and source ranges; types are outlines)';
    return `#### ${p.file.path} — ${names} · ${tag}\n\n\`\`\`${p.file.nodes[0]?.language ?? ''}\n`
      + ranges(units).map(r => renderLines(p, r.start, r.end)).join(GAP) + '\n```\n\n';
  };
  // Allocate complete section envelopes, after charging the prefix and ledger.
  // A compact anchored mechanism is a useful minimum, not one arbitrary method.
  const footerReserve = Math.min(1000, Math.max(Math.floor(limit * 0.06), Math.min(240, Math.floor(limit * 0.35))));
  const pool = Math.max(0, limit - prefix.length - footerReserve);
  const anchored = (p: Plan) => p.units.filter(u => u.full && u.priority <= 2);
  const compact = (p: Plan) => {
    const units = anchored(p);
    return units.length && section(p, units).length <= options.maxCharsPerFile ? units : [];
  };
  const allocation = allocateExploreFiles(plans.map(p => ({
    path: p.file.path, score: p.file.relevance ?? 1, worth: p.file.worth ?? 1,
    spine: p.file.spine ?? false,
    named: p.file.named || anchored(p).length > 0,
    // Direct graph evidence survives lexical cliffs regardless of file size.
    // Compact callable evidence also retains the historical zero-score caller
    // case, without promoting its relevance or exempting the ordinary cap.
    graphEvidence: p.units.some(u => u.full && u.priority <= 3)
      || p.units.some(u => u.full) && section(p, p.units).length <= options.maxCharsPerFile,
    demandChars: section(p, p.units).length,
    minimumChars: compact(p).length ? section(p, compact(p)).length : undefined,
  })), pool, options.maxFiles);
  const admitted = plans.filter(p => (allocation.allowances.get(p.file.path) ?? 0) > 0);
  // Preserve affordable independent mechanisms as complete groups. If generic
  // minimum floors compete in a small envelope, shrink large-file windows first
  // rather than turn an already affordable group into several partial methods.
  const compactPlans = admitted.filter(p => compact(p).length);
  const compactCost = compactPlans.reduce((sum, p) => sum + section(p, compact(p)).length, 0);
  if (compactCost <= pool && compactPlans.length) {
    const flexible = admitted.filter(p => !compactPlans.includes(p));
    const previous = flexible.reduce((sum, p) => sum + (allocation.allowances.get(p.file.path) ?? 0), 0);
    for (const p of compactPlans) allocation.allowances.set(p.file.path, section(p, compact(p)).length);
    for (const p of flexible) allocation.allowances.set(p.file.path,
      previous ? Math.floor((pool - compactCost) * allocation.allowances.get(p.file.path)! / previous) : 0);
  }
  const cost = (p: Plan) => section(p).length;
  const covered = (p: Plan, u: Unit) => ranges(p.selected).some(r => r.start <= u.start && r.end >= u.end);
  let spent = 0;
  const replace = (p: Plan, selected: Unit[], ceiling: number): boolean => {
    const before = cost(p), after = section(p, selected).length;
    if (after > ceiling || spent + after - before > pool) return false;
    p.selected = selected; spent += after - before; return true;
  };
  const add = (p: Plan, u: Unit, ceiling: number): boolean => {
    if (covered(p, u)) return true;
    return replace(p, [...p.selected.filter(item => !(item.partial && item.node.id === u.node.id)), u], ceiling);
  };
  const window = (p: Plan, u: Unit, ceiling: number): boolean => {
    if (!u.full || covered(p, u)) return false;
    const retained = p.selected.filter(item => !(item.partial && item.node.id === u.node.id));
    const first = { ...u, end: u.start, full: false, partial: true };
    const overhead = section(p, [first]).length - renderLines(p, first.start, first.end).length;
    const bound = Math.min(ceiling, cost(p) + pool - spent);
    // Price the final union, not a guessed fixed header or character slice.
    let room = Math.max(0, bound - overhead);
    for (let retry = 0; room > 0 && retry < 24; retry++) {
      const selection = selectExploreWindow({ lines: p.lines, start: u.start, end: u.end,
        maxChars: room, focusLines: p.file.focusLines?.get(u.node.id), lineNumbers: options.lineNumbers, gap: GAP });
      if (!selection.ranges.length) return false;
      const units = selection.ranges.map(span => ({ ...u, ...span,
        full: selection.complete, partial: !selection.complete }));
      const proposed = [...retained, ...units];
      const after = section(p, proposed).length;
      if (after <= bound) return replace(p, proposed, bound);
      room -= Math.max(1, after - bound);
    }
    return false;
  };
  const allowance = (p: Plan) => allocation.allowances.get(p.file.path) ?? 0;
  const candidates = admitted.flatMap(p => p.units.map(u => ({ p, u })))
    .sort((a, b) => a.u.priority - b.u.priority || b.u.connectivity - a.u.connectivity
      || a.p.rank - b.p.rank || a.u.start - b.u.start);

  // Every important file first receives its own reserved evidence. Do not spend
  // another file's unused share until all important reservations were attempted.
  for (const p of admitted) {
    const important = anchored(p);
    if (!important.length) continue;
    const ceiling = allowance(p);
    const group = compact(p);
    if (group.length && replace(p, group, ceiling)) continue;
    const best = important[0]!.priority;
    const processingTier = best > 1 && best < 2;
    const initial = important.filter(u => u.priority === best)
      .sort((a, b) => processingTier ? b.connectivity - a.connectivity || a.start - b.start
        : section(p, [a]).length - section(p, [b]).length || b.connectivity - a.connectivity || a.start - b.start);
    for (const u of processingTier ? initial.slice(0, 1) : initial) if (add(p, u, ceiling)) break;
    // A short completed helper is not evidence for an omitted larger target.
    // Reserve a head/call-site window before further complete helpers can fill it.
    const omitted = important.find(u => !covered(p, u));
    if (omitted) window(p, omitted, Math.min(ceiling, cost(p) + 700));
  }
  // All reservations have now had a turn. Reclaim unused capacity by semantic
  // tier, completing bodies first and funding missing windows before lower-tier
  // ordinary neighbors. A giant body cannot borrow its peers' spent evidence.
  for (const priority of [...new Set(candidates.map(c => c.u.priority))]) {
    const tier = candidates.filter(c => c.u.priority === priority);
    if (priority >= 2) {
      // Group related small bodies at their own semantic tier. This reservation
      // occurs after higher-priority exact/entry bodies, not before them.
      const groups = admitted.map(p => ({ p, units: tier.filter(item => item.p === p && item.u.full).map(item => item.u) }))
        .filter(group => group.units.length && section(group.p, group.units).length <= options.maxCharsPerFile)
        .sort((a, b) => (b.p.file.relevance ?? 1) * (b.p.file.worth ?? 1)
          - (a.p.file.relevance ?? 1) * (a.p.file.worth ?? 1) || a.p.rank - b.p.rank);
      for (const { p, units } of groups) {
        const wanted = [...p.selected.filter(item => !item.partial || !units.some(u => u.node.id === item.node.id)), ...units];
        replace(p, wanted, pool);
      }
    }
    // Entry-processing order carries directed structural evidence. Do not let
    // a later small helper buy the room needed to complete its earlier caller.
    if (!(priority > 1 && priority < 2)) for (const { p, u } of tier) add(p, u, allowance(p));
    for (const { p, u } of tier) add(p, u, pool);
    const pending = tier.filter(({ p, u }) => u.full && !covered(p, u));
    for (let index = 0; index < pending.length; index++) {
      const { p, u } = pending[index]!;
      const share = Math.floor((pool - spent) / (pending.length - index));
      if (share > 0) window(p, u, cost(p) + Math.min(share, Math.max(700, options.maxCharsPerFile - cost(p))));
    }
  }
  // A relevance cliff defers weak lexical neighbors; it does not erase them.
  // Only after all admitted evidence has had its turn may an unused file slot
  // and otherwise idle source budget fund one. Existing selections never move.
  let openFiles = Math.max(0, options.maxFiles - admitted.filter(p => p.selected.length).length);
  for (const p of plans.filter(plan => !admitted.includes(plan))) {
    if (openFiles <= 0 || spent >= pool) break;
    for (const u of p.units.filter(unit => unit.full)) add(p, u, pool);
    const omitted = p.units.find(u => u.full && !covered(p, u));
    if (omitted) window(p, omitted, cost(p) + Math.min(options.maxCharsPerFile, pool - spent));
    for (const u of p.units.filter(unit => !unit.full)) add(p, u, pool);
    if (p.selected.length) { admitted.push(p); openFiles--; }
  }
  let output = prefix + admitted.map(p => section(p)).join('');
  // Coverage is derived from emitted ranges. A parent body can cover an inner
  // function, but an outline, Flow mention or partial body cannot establish it.
  const missing = plans.flatMap(p => {
    const shown = ranges(p.selected);
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
    const lead = `> ${missing.length} candidate function bodies not fully shown; highest-priority gaps below (not exhaustive).\n`;
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

/** Explicit source spans keep their own coverage contract while sharing the
 * same file allocation and whole-line window machinery as ordinary exploration. */
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
  const window = (plan: TargetPlan, unit: TargetUnit, ceiling: number): boolean => {
    if (unit.outline || !missing(plan.selected, unit).length) return false;
    const end = Math.min(unit.end, plan.lines.length);
    if (unit.start > end) return false;
    const bound = Math.min(ceiling, section(plan).length + pool - spent);
    const first = { start: unit.start, end: unit.start };
    const overhead = section(plan, [first]).length - sourceText(plan, first).length;
    let room = Math.max(0, bound - overhead);
    for (let retry = 0; room > 0 && retry < 24; retry++) {
      const selection = selectExploreWindow({ lines: plan.lines, start: unit.start, end,
        maxChars: room, lineNumbers: options.lineNumbers, gap: GAP,
        focusLines: unit.node ? plan.file.focusLines?.get(unit.node.id) : undefined });
      if (!selection.ranges.length) return false;
      const selected = merge([...plan.selected, ...selection.ranges]);
      const before = section(plan).length, after = section(plan, selected).length;
      if (after <= bound) { plan.selected = selected; spent += after - before; return true; }
      room -= Math.max(1, after - bound);
    }
    return false;
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
  const allocation = allocateExploreFiles(admitted.map(plan => {
    const compact = plan.ordinary.filter(unit => unit.body && unit.priority <= 2);
    const compactCost = compact.length ? section(plan, compact).length : 0;
    return { path: plan.file.path, score: plan.file.relevance ?? 1, worth: plan.file.worth ?? 1,
      named: plan.file.named || compact.length > 0, spine: plan.file.spine ?? false,
      pinned: plan.file.pinned, protected: plan.targets.length > 0,
      graphEvidence: plan.ordinary.some(unit => unit.body && unit.priority <= 3)
        || compactCost > 0 && compactCost <= options.maxCharsPerFile,
      demandChars: section(plan, [...plan.targets.map(selectable), ...plan.ordinary]).length,
      minimumChars: combinedMinimum.has(plan) ? section(plan, merge(combinedMinimum.get(plan)!)).length
        : compactCost <= options.maxCharsPerFile ? compactCost : undefined };
  }), pool, options.maxFiles);
  const allowance = (plan: TargetPlan) => allocation.allowances.get(plan.file.path) ?? 0;
  if (minimumCost <= pool) {
    for (const { plan, span } of minima) change(plan, span, pool);
  } else {
    const share = Math.floor(pool / Math.max(1, required.length));
    for (const { plan, span } of minima) change(plan, span, section(plan).length + share);
    // A long signature that cannot fit its equal share must not consume a later
    // target's minimum. Reclaim only after every target has had its turn.
    for (const { plan, span } of minima) change(plan, span, pool);
  }
  // Fulfil independent anchored-file reservations before exact bodies borrow
  // unused shares. A path/type target never buys an enclosing class envelope.
  for (const plan of admitted) {
    if (plan.targets.length) continue;
    const important = plan.ordinary.filter(unit => unit.body && unit.priority <= 2);
    if (!important.length && !plan.file.pinned) continue;
    const groupCost = important.length ? section(plan, important).length : Infinity;
    if (groupCost <= options.maxCharsPerFile && groupCost <= allowance(plan)) {
      for (const unit of important) change(plan, unit, allowance(plan));
    } else {
      const first = important[0] ?? plan.ordinary[0];
      if (first && !change(plan, first, allowance(plan))) window(plan, first, Math.min(700, allowance(plan)));
    }
  }
  const byCost = [...required].sort((a, b) => section(a.plan, [...a.plan.selected, selectable(a.unit)]).length - section(a.plan).length
    - (section(b.plan, [...b.plan.selected, selectable(b.unit)]).length - section(b.plan).length)
    || a.plan.rank - b.plan.rank || a.unit.start - b.unit.start);
  for (const { plan, unit } of byCost) change(plan, selectable(unit), allowance(plan));
  for (const { plan, unit } of byCost) change(plan, selectable(unit), pool);
  // Incomplete exact bodies retain a head and proven call-site windows even
  // when another body in the same file is already complete. Literal ranges use
  // the same whole-line budget but never expand outside the requested span.
  for (const { plan, unit } of required) {
    if (unit.outline || !missing(plan.selected, unit).length) continue;
    const used = section(plan).length;
    window(plan, unit, used + Math.min(pool - spent,
      Math.max(700, Math.min(options.maxCharsPerFile, allowance(plan)) - used)));
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
      window(plan, unit, Math.min(options.maxCharsPerFile, allowance(plan)));
    }
  }
  const ordinary = admitted.flatMap(plan => plan.ordinary.map(unit => ({ plan, unit })))
    .sort((a, b) => a.unit.priority - b.unit.priority || b.unit.connectivity - a.unit.connectivity
      || a.plan.rank - b.plan.rank || a.unit.start - b.unit.start);
  for (const priority of [...new Set(ordinary.map(item => item.unit.priority))]) {
    const tier = ordinary.filter(item => item.unit.priority === priority);
    if (priority >= 2) {
      const groups = admitted.map(plan => ({ plan, units: tier.filter(item => item.plan === plan && item.unit.body).map(item => item.unit) }))
        .filter(group => group.units.length && section(group.plan, group.units).length <= options.maxCharsPerFile)
        .sort((a, b) => (b.plan.file.relevance ?? 1) * (b.plan.file.worth ?? 1)
          - (a.plan.file.relevance ?? 1) * (a.plan.file.worth ?? 1) || a.plan.rank - b.plan.rank);
      for (const { plan, units } of groups) {
        const selected = merge([...plan.selected, ...units]);
        const before = section(plan).length, after = section(plan, selected).length;
        if (spent + after - before <= pool) { plan.selected = selected; spent += after - before; }
      }
    }
    if (!(priority > 1 && priority < 2)) for (const { plan, unit } of tier) change(plan, unit, allowance(plan));
    for (const { plan, unit } of tier) change(plan, unit, pool);
    for (const { plan, unit } of tier) if (unit.body && missing(plan.selected, unit).length) {
      const used = section(plan).length;
      window(plan, unit, used + Math.min(pool - spent,
        Math.max(700, Math.min(options.maxCharsPerFile, allowance(plan)) - used)));
    }
  }
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
