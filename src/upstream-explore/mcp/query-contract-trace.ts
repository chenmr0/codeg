import type { Node } from '../types';
import type { ExploreQueryIntent } from '../search/query-intent';

type Range = { start: number; end: number };
type FileDecision = { path: string; rank: number; allowance: number | null; render?: string | null; skipped?: string | null; clipped: boolean; finalChars: number };
interface EntityTrace {
  id: string; name: string; qualifiedName: string; path: string; kind: string;
  declaration: boolean; start: number; end: number;
  gathered: boolean; admitted: boolean; named: boolean; exact: boolean; flow: boolean;
  canonicalId?: string; clues: string[];
}
const MAX_ENTITIES = 512, MAX_CLUES = 128, MAX_CANDIDATES = 8, MAX_RANGES = 128;
const clip = (text: string, max = 512) => text.slice(0, max);
const now = () => performance.now();

/** Observational, bounded state only. No graph/DB access and no rendering feedback. */
export class QueryContractTrace {
  private readonly started = now();
  private last = this.started;
  private readonly timings: Array<{ stage: string; milliseconds: number }> = [];
  private readonly entities = new Map<string, EntityTrace>();
  private readonly resolutions: Array<{ token: string; rawCount: number; eligibleCount: number; pickedCount: number; rawIds: string[]; pickedIds: string[]; omittedCandidates: number }> = [];
  private readonly counts = { entityLimit: 0, clueLimit: 0, candidateLimit: 0, rangeLimit: 0 };
  private pins: string[] = [];
  private unresolvedPaths: string[] = [];
  constructor(private intent: ExploreQueryIntent) {}
  updateIntent(intent: ExploreQueryIntent): void { this.intent = intent; }

  /** Non-overlapping wall intervals; includes awaited work, not nested method sums. */
  checkpoint(stage: string): void {
    const end = now();
    if (this.timings.length < 32) this.timings.push({ stage: clip(stage, 80), milliseconds: end - this.last });
    this.last = end;
  }
  paths(pins: readonly string[], unresolved: readonly string[]): void {
    this.pins = pins.slice(0, MAX_CLUES).map(p => clip(p));
    this.unresolvedPaths = unresolved.slice(0, MAX_CLUES).map(p => clip(p));
  }
  private entity(n: Node): EntityTrace | undefined {
    let item = this.entities.get(n.id);
    if (!item) {
      if (this.entities.size >= MAX_ENTITIES) { this.counts.entityLimit++; return; }
      item = { id: clip(n.id), name: clip(n.name, 160), qualifiedName: clip(n.qualifiedName || n.name, 320),
        path: clip(n.filePath, 4096), kind: n.kind, declaration: n.isDeclaration === true,
        start: n.startLine, end: Math.max(n.startLine, n.endLine), gathered: false,
        admitted: false, named: false, exact: false, flow: false, clues: [] };
      this.entities.set(n.id, item);
    }
    return item;
  }
  gather(nodes: Iterable<Node>): void {
    for (const node of nodes) { const item = this.entity(node); if (item) item.gathered = true; }
  }
  candidates(token: string, raw: readonly Node[], eligible: readonly Node[], picked: readonly Node[]): void {
    if (this.resolutions.length >= MAX_CLUES) { this.counts.clueLimit++; return; }
    // Inspect bounded prefixes as well as keeping bounded state. In a giant
    // same-name family, diagnostics must not materialize another full Map/Set
    // (or scan every duplicate just to fill a unique sample).
    const selected = new Set<string>(), seen = new Set<string>(), sample: Node[] = [];
    for (const [source, isPicked] of [[picked, true], [raw, false]] as const) {
      for (let i = 0; i < Math.min(source.length, MAX_CANDIDATES) && sample.length < MAX_CANDIDATES; i++) {
        const n = source[i]!;
        if (seen.has(n.id)) continue;
        seen.add(n.id); sample.push(n);
        if (isPicked) selected.add(n.id);
      }
    }
    // Counts observations left out, including repeated IDs. Exact global
    // uniqueness would require the unbounded Set this trace deliberately avoids.
    const omitted = raw.length + picked.length - sample.length;
    this.counts.candidateLimit += omitted;
    this.resolutions.push({ token: clip(token, 160), rawCount: raw.length, eligibleCount: eligible.length,
      pickedCount: picked.length, rawIds: raw.slice(0, MAX_CANDIDATES).map(n => clip(n.id)),
      pickedIds: picked.slice(0, MAX_CANDIDATES).map(n => clip(n.id)), omittedCandidates: omitted });
    for (const n of sample) {
      const item = this.entity(n); if (!item) continue;
      if (item.clues.length < 8 && !item.clues.includes(token)) item.clues.push(clip(token, 160));
      if (selected.has(n.id)) item.admitted = true;
    }
  }
  selection(nodes: Iterable<Node>, aliases: ReadonlyMap<string, string>, named: ReadonlySet<string>, exact: ReadonlySet<string>, flow: ReadonlySet<string>): void {
    for (const n of nodes) {
      const item = this.entity(n); if (!item) continue;
      item.admitted = true; item.named = named.has(n.id); item.exact = exact.has(n.id); item.flow = flow.has(n.id);
      item.canonicalId = aliases.get(n.id);
    }
    for (const [id, to] of aliases) { const item = this.entities.get(id); if (item) item.canonicalId = clip(to); }
  }
  finish(finalText: string, files: readonly FileDecision[], recordedRanges: ReadonlyMap<string, readonly Range[]>): Record<string, unknown> {
    this.checkpoint('render-and-finalize');
    const fileMap = new Map(files.map(f => [f.path, f]));
    const shown = numberedRanges(finalText);
    const ranges = (path: string): { ranges: Range[]; evidence: string } => {
      const numbers = shown.get(path);
      if (numbers) return { ranges: numbers, evidence: 'final-numbered-source' };
      const file = fileMap.get(path);
      // No line numbers: render records are useful but must not be represented
      // as independently reconstructed final source coverage.
      const recorded = file && file.finalChars > 0 && !file.clipped ? [...(recordedRanges.get(path) ?? [])] : [];
      return { ranges: recorded, evidence: recorded.length ? 'render-records-unclipped-file' : 'coverage-unavailable' };
    };
    const rows = [...this.entities.values()].map(entity => {
      const file = fileMap.get(entity.path), delivery = ranges(entity.path);
      const covered = merge(delivery.ranges.map(r => ({ start: Math.max(r.start, entity.start), end: Math.min(r.end, entity.end) })).filter(r => r.end >= r.start));
      this.counts.rangeLimit += Math.max(0, covered.length - MAX_RANGES);
      const coverageKnown = delivery.evidence !== 'coverage-unavailable';
      const lines = covered.reduce((sum, r) => sum + r.end - r.start + 1, 0);
      const complete = coverageKnown && lines === entity.end - entity.start + 1;
      const reason = !file ? 'file-not-ranked'
        : file.skipped ? 'file-' + file.skipped
        : file.render === 'stale-omitted' ? 'source-stale'
        : file.render === 'backref' ? 'session-backreference'
        : !file.finalChars ? 'no-source-in-final-output'
        : !coverageKnown ? 'coverage-unavailable'
        : !lines ? 'outside-selected-source-ranges'
        : !complete ? 'partial-source-window' : 'indexed-range-covered';
      return { ...entity, fileRank: file?.rank ?? null, fileAllowance: file?.allowance ?? null,
        renderMode: file?.render ?? null, sourceEvidence: delivery.evidence,
        shownRanges: covered.slice(0, MAX_RANGES), shownLines: coverageKnown ? lines : null,
        indexedRangeCovered: coverageKnown ? complete : null,
        semanticEvidenceAssessed: false, // indexed extents do not prove behavioral sufficiency
        selectionReason: entity.canonicalId ? 'paired-declaration' : entity.admitted ? 'admitted' : 'not-admitted-after-resolution',
        reason, identityStatus: entity.canonicalId ? 'paired-in-gather'
          : entity.declaration ? 'no-confirmed-definition-in-gather' : 'not-a-declaration' };
    });
    return { version: 2, methodology: 'Lexical mentions and observations from existing lookups only; no existing/proposed status inferred from prose. Named tokens retain first-occurrence order. Indexed-range coverage is not semantic body sufficiency. Timings are successive non-overlapping wall intervals from post-parse diagnostics attachment, excluding emission of this report.',
      mentions: this.intent.mentions.slice(0, MAX_CLUES).map(m => ({ ...m, raw: clip(m.raw, 160), normalized: clip(m.normalized, 320) })),
      omitted: this.intent.omitted.slice(0, MAX_CLUES).map(item => ({ ...item, normalized: clip(item.normalized, 320) })),
      namedTokens: this.intent.symbolTokens.slice(0, MAX_CLUES).map(token => clip(token, 160)),
      quotedPrecisionTokens: this.intent.mentions.filter(m => m.kind === 'symbol' && m.quoted).slice(0, MAX_CLUES).map(m => clip(m.normalized, 160)),
      pinnedFiles: this.pins, unresolvedPaths: this.unresolvedPaths,
      resolutions: this.resolutions, entities: rows,
      timings: this.timings, timedMilliseconds: this.timings.reduce((sum, t) => sum + t.milliseconds, 0),
      limits: { maxEntities: MAX_ENTITIES, maxClues: MAX_CLUES, maxCandidatesPerClue: MAX_CANDIDATES, maxRangesPerEntity: MAX_RANGES },
      truncationCountUnit: 'discarded observations, not necessarily distinct entities',
      truncated: { ...this.counts, mentions: Math.max(0, this.intent.mentions.length - MAX_CLUES), omitted: Math.max(0, this.intent.omitted.length - MAX_CLUES), namedTokens: Math.max(0, this.intent.symbolTokens.length - MAX_CLUES) } };
  }
}

function merge(input: readonly Range[]): Range[] {
  const sorted = [...input].sort((a, b) => a.start - b.start || a.end - b.end), out: Range[] = [];
  for (const r of sorted) { const last = out[out.length - 1]; if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end); else out.push({ ...r }); }
  return out;
}
function numberedRanges(text: string): Map<string, Range[]> {
  const map = new Map<string, Range[]>(); let file = '', fence = false;
  for (const line of text.split('\n')) {
    if (!fence) { const header = /^\*\*`([^`]+)`\*\*/.exec(line); if (header) file = header[1]!; else if (file && line.startsWith('```')) fence = true; }
    else if (line === '```') fence = false;
    else { const number = /^(\d+)\t/.exec(line); if (number) { const n = Number(number[1]); if (Number.isSafeInteger(n) && n > 0) { const list = map.get(file) ?? []; list.push({ start: n, end: n }); map.set(file, list); } } }
  }
  for (const [file, spans] of map) map.set(file, merge(spans));
  return map;
}
