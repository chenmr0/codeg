import type { SqliteDatabase } from './db/sqlite-adapter';
import type { DesignEvidence, MappingSymbolMatch } from './term-mappings';
import type { ExploreQueryIntent } from './upstream-explore/search/query-intent';

type ExplainedMatch =
  | { terms: string[]; symbols: string[]; design?: undefined }
  | { terms: string[]; ids: string[]; design: DesignEvidence };

/** One CLI invocation, using the same parsed query and admitted seed IDs as Explore. */
export class ExploreExplanation {
  private mentioned = new Set<string>();
  private unconfirmed = new Set<string>();
  private mentionsTruncated = false;
  private matches: ExplainedMatch[] = [];
  private admitted = new Map<string, string>();
  mappingErrors: string[] = [];

  recordMentions(db: SqliteDatabase, intent: ExploreQueryIntent): void {
    const pathSpans = new Set(intent.mentions.filter(m => m.kind === 'path').map(m => m.start));
    const consumed = new Set(intent.omitted.filter(o => o.reason === 'path-consumed').map(o => o.normalized));
    const found = db.prepare("SELECT 1 FROM nodes WHERE (name = ? OR qualified_name IN (?, ?, ?)) AND kind NOT IN ('file','import') LIMIT 1");
    const checked = new Map<string, boolean>();
    for (const m of intent.mentions) {
      if (m.kind !== 'symbol' || pathSpans.has(m.start) || consumed.has(m.normalized) || consumed.has(m.raw)) continue;
      const name = m.normalized;
      if (!checked.has(name)) checked.set(name, !!found.get(name, name, name.replaceAll('::', '.'), name.replaceAll('.', '::')));
      if (checked.get(name)) this.mentioned.add(name);
      else if (m.quoted || /[._$]|::|[a-z][A-Z]|^[A-Z]/.test(name) || m.raw.includes(name + '(')) {
        this.unconfirmed.add(name);
      }
    }
    this.mentionsTruncated = intent.omitted.some(o => o.reason === 'mention-limit');
  }

  recordManualMatch(terms: string[], names: string[], lookups: ReadonlyMap<string, MappingSymbolMatch>, admitted: ReadonlySet<string>): void {
    const symbols = new Set<string>();
    for (const name of names) {
      const match = lookups.get(name);
      if (!match) continue;
      const candidates = match.candidates.filter(node => admitted.has(node.id));
      if (!candidates.length) continue;
      if (match.count > 1) {
        const locations = candidates.map(node => node.filePath + ':' + node.startLine);
        symbols.add(name + '（同名候选 ' + candidates.length + '/' + match.count + '：' + locations.join('、') + '）');
      } else {
        const node = candidates[0]!;
        symbols.add(node.qualifiedName || node.name);
      }
    }
    this.matches.push({ terms, symbols: [...symbols] });
  }

  recordDesignMatch(terms: string[], ids: string[], design: DesignEvidence): void {
    this.matches.push({ terms, ids, design });
  }

  recordCandidates(nodes: readonly { id: string; qualifiedName?: string; name: string }[]): void {
    for (const node of nodes) this.admitted.set(node.id, node.qualifiedName || node.name);
  }

  format(): string {
    const lines = ['**Explore 召回说明**', '', '原文提到的符号（索引已确认）：' + ([...this.mentioned].join('、') || '无')];
    if (this.unconfirmed.size) lines.push('原文中的标识符（索引未确认）：' + [...this.unconfirmed].join('、'));
    if (this.mentionsTruncated) lines.push('原文较长，符号识别已达到 Explore 的解析上限。');
    lines.push('', '命中的术语 → 召回候选符号');
    for (const match of this.matches) {
      const { terms, design } = match;
      const symbols = design
        ? [...new Set(match.ids.map(id => this.admitted.get(id)).filter((name): name is string => name !== undefined))]
        : match.symbols;
      const source = design ? '文档相似匹配，' + design.document + ':' + design.documentLine : '手工短语匹配';
      lines.push('- ' + terms.join(' / ') + '（' + source + '） → ' + (symbols.join('、') || '无候选'));
    }
    if (!this.matches.length) lines.push('无');
    for (const error of this.mappingErrors) lines.push('术语映射检查提示：' + error);
    return lines.join('\n');
  }
}
