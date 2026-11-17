import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDefaults, Lexer, type Token } from 'marked';
import type CodeGraph from './index';
import type { SqliteDatabase } from './db/sqlite-adapter';
import { scanDesignDocuments } from './extraction';
import { isWithinExistingDirectory, sameExistingPath } from './path-identity';
import { validatePathWithinRoot } from './utils';
import { randomUUID } from 'node:crypto';
import { MAX_DESIGN_SEEDS } from './design-recall';
import { MAX_MAPPING_BYTES, parseTermMappings, TERM_MAPPINGS_FILE, type TermMappingRule } from './term-mappings';

interface Definition { name: string; qualifiedName: string; kind: string; file: string; line: number }
interface DesignEntry {
  document: string;
  documentLine: number;
  description: string;
  heading: string;
  evidence: string;
  reference: string;
  definitions: Definition[];
}

const MAX_DOC_BYTES = 1024 * 1024;
interface Fragment { text: string; symbols: string[]; files: string[]; direct: boolean }
const identifierPattern = /^[A-Za-z_]\w*(?:(?:::|\.)[A-Za-z_]\w*)*\*?$/;
const filenamePattern = /^[\w./-]+\.(?:h|hpp|c|cpp|cc|py|ts|js)$/i;

// Positive, local evidence is required even when every mentioned symbol exists.
function uncertain(text: string): boolean {
  return /(?:不要|不应|不能|不可|禁止|请勿|不再|避免|不推荐|不使用|弃用|废弃|旧版|反例|误用|迁移|替代)|(?:deprecated|instead of|do not use)/i.test(text);
}

// Markdown supplies the boundaries. Keep explicit identifiers separate from the words used for recall.
function fragment(tokens: Token[]): Fragment {
  const parts: string[] = [], symbols: string[] = [], files: string[] = [];
  const anchor = '\u0000';
  function visit(token: Token): void {
    if (token.type === 'codespan' || token.type === 'strong') {
      const word = String(token.text).trim();
      if (filenamePattern.test(word)) { files.push(word); return; }
      const labeled = token.type === 'strong' && /^(.+?)[(（]([A-Za-z_]\w*)[)）]$/.exec(word);
      if (labeled && /\p{Script=Han}/u.test(labeled[1]!) && /_|[a-z][A-Z]/.test(labeled[2]!)) {
        parts.push(labeled[1]!, anchor);
        symbols.push(labeled[2]!);
        return;
      }
      const identifier = word.replace(/\(\)$/, '');
      if (identifierPattern.test(identifier) &&
          (token.type === 'codespan' || /^[A-Z][A-Z\d_]+$/.test(identifier))) {
        parts.push(anchor);
        symbols.push(identifier);
        return;
      }
    }
    if (token.type === 'list' || token.type === 'code' || token.type === 'html') return;
    if ('tokens' in token && token.tokens) token.tokens.forEach(visit);
    else if ('text' in token) {
      const value = String(token.text);
      const trailingFile = /^\s*[-–—]\s*(\S+)\s*$/.exec(value);
      if (trailingFile && filenamePattern.test(trailingFile[1]!)) files.push(trailingFile[1]!);
      else parts.push(value);
    }
  }
  tokens.forEach(visit);
  const [before, after] = parts.join('').split(anchor).map(part => part.trim());
  // Accept a definition delimiter or a short label followed by its identifier.
  // Narrative co-occurrence, multiple references and negative examples abstain.
  const direct = symbols.length === 1 && ((!before && /^[:：—–-]/.test(after ?? '')) ||
    (!after && !!before && before.length <= 80 && !/[。；;！？!?]/.test(before)));
  return { text: parts.join('').replaceAll(anchor, ' ').trim(), symbols, files, direct };
}

// Marked consumes some blocks (e.g. link definitions) without emitting a token.
// Observe its source cursor so omitted blocks and repeated wording keep their
// actual positions. Nested list items have their own de-indented token stream.
function lexWithLines(content: string) {
  const cursors = new WeakMap<Token[], { rest: string; line: number; starts: number[] }>();
  const tokens = Lexer.lex(content, {
    ...getDefaults(),
    extensions: { renderers: {}, childTokens: {}, block: [(rest, blocks) => {
      let cursor = cursors.get(blocks);
      if (!cursor) {
        cursor = { rest, line: 1, starts: [] };
        cursors.set(blocks, cursor);
      } else {
        const consumed = cursor.rest.length - rest.length;
        cursor.line += cursor.rest.slice(0, consumed).split('\n').length - 1;
        cursor.rest = rest;
      }
      cursor.starts[blocks.length] = cursor.line;
      return undefined; // Let Marked tokenize the block normally.
    }] },
  });
  return { tokens, lineOf: (blocks: Token[], index: number) => cursors.get(blocks)!.starts[index]! };
}

function extract(document: string, content: string, db: SqliteDatabase, module = path.posix.dirname(document)): DesignEntry[] {
  const entries: DesignEntry[] = [];
  const prefix = module === '.' ? '' : module + '/';
  const scope = " AND substr(file_path,1,length(?)) = ? " +
    "AND (? = '' OR file_path = ? OR substr(file_path, -length(?) - 1) = '/' || ?)";
  const columns = 'SELECT name,qualified_name AS qualifiedName,kind,file_path AS file,start_line AS line';
  const exact = db.prepare(columns + " FROM nodes WHERE (name = ? OR qualified_name = ?) AND kind NOT IN ('file','import')" + scope + ' LIMIT 2');
  const macroFilter = " FROM nodes WHERE name GLOB ? AND kind = 'macro'";
  const familyFiles = db.prepare('SELECT DISTINCT file_path' + macroFilter + scope + ' LIMIT 2');
  const family = db.prepare(columns + macroFilter + ' AND file_path = ? ORDER BY start_line,id LIMIT ?');
  let heading = '', label = '', source = '';
  const markdown = lexWithLines(content);
  function add(item: Fragment, evidence: string, documentLine: number): void {
    if (!item.direct || item.symbols.length !== 1 || !/\p{Script=Han}/u.test(item.text) ||
        uncertain(evidence) || uncertain(label) || uncertain(heading) || item.files.length > 1) return;
    const file = item.files[0] ?? source;
    const params = [prefix, prefix, file, file, file, file];
    const symbol = item.symbols[0]!;
    const wildcard = symbol.endsWith('*');
    let rows: Definition[];
    if (wildcard) {
      // Prove the file is unambiguous before truncating a large macro family.
      const files = familyFiles.all(symbol, ...params);
      if (files.length !== 1) return;
      rows = family.all(symbol, files[0].file_path, MAX_DESIGN_SEEDS);
    } else {
      rows = exact.all(symbol, symbol, ...params);
      if (rows.length !== 1) return;
    }
    // The saved rule can identify a symbol only by its module and name.
    // A header hint narrows extraction but cannot disambiguate later lookups.
    if (file || wildcard) {
      rows = rows.filter(row => {
        const name = row.qualifiedName || row.name;
        return exact.all(name, name, prefix, prefix, '', '', '', '').length === 1;
      });
    }
    if (!rows.length) return;
    entries.push({ document, documentLine, heading: [heading, label].filter(Boolean).join(' '), description: item.text,
      evidence: evidence.trim(), reference: symbol, definitions: rows });
  }

  function list(items: { raw: string; tokens: Token[] }[], line: number, definition?: Fragment, title = ''): void {
    for (const item of items) {
      const row = fragment(item.tokens);
      if (!row.symbols.length && definition && /^(定义|表示|用于|描述|包含)/.test(row.text)) {
        add({ ...definition, text: definition.text + ' ' + row.text }, title + '\n' + item.raw, line);
      } else add(row, title ? title + '\n' + item.raw : item.raw, line);
      for (const [index, token] of item.tokens.entries()) {
        if (token.type === 'list') list(token.items, line + markdown.lineOf(item.tokens, index) - 1, undefined, title);
      }
      line += item.raw.split('\n').length - 1;
    }
  }
  let definition: Fragment | undefined, title = '';
  for (const [index, token] of markdown.tokens.entries()) {
    if (token.type === 'space') continue;
    const line = markdown.lineOf(markdown.tokens, index);
    if (token.type === 'list') {
      list(token.items, line, definition, title);
      definition = undefined;
      title = '';
      continue;
    }
    definition = undefined;
    title = '';
    source = '';
    label = '';
    if (token.type === 'heading' || token.type === 'paragraph') {
      const item = fragment(token.tokens ?? []);
      if (token.type === 'heading') heading = item.text;
      source = item.files.length === 1 ? item.files[0]! : '';
      label = token.type === 'paragraph' && /[:：]\s*$/.test(item.text) && !item.files.length ? item.text : '';
      add(item, token.raw, line);
      title = token.raw.trim();
      if (item.direct) definition = item;
    } else if (token.type === 'table') {
      const header = token.header.map((cell: { text: string }) => cell.text.trim().toLowerCase());
      const symbolColumn = header.findIndex((name: string) => /^(符号|宏|接口|函数|类型|symbol|function)$/.test(name));
      const description = header.findIndex((name: string) => /^(说明|含义|用途|描述|业务术语|description)$/.test(name));
      if (symbolColumn < 0 || description < 0) continue;
      for (const [rowIndex, row] of token.rows.entries()) {
        const ref = fragment(row[symbolColumn].tokens);
        const body = fragment(row[description].tokens);
        if (!body.symbols.length) add({ ...ref, text: body.text, direct: true },
          row.map((cell: { text: string }) => cell.text).join(' | '), line + 2 + rowIndex);
      }
    }
  }
  return entries;
}

function readDocument(root: string, file: string): string | undefined {
  const entry = fs.lstatSync(path.join(root, file), { throwIfNoEntry: false });
  if (!entry?.isFile()) return;
  const target = validatePathWithinRoot(root, file, true);
  if (!target) return;
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return;
    if (st.size > MAX_DOC_BYTES) throw new Error('Design document exceeds 1 MiB: ' + file);
    const bytes = Buffer.alloc(st.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = fs.readSync(fd, bytes, count, bytes.length - count, null);
      if (!read) break;
      count += read;
    }
    if (count !== st.size) throw new Error('Document changed during indexing: ' + file);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)); }
    catch { throw new Error('Expected a UTF-8 design document: ' + file); }
  } finally { fs.closeSync(fd); }
}

/** Preview the file on disk, using the same bindings explicit regeneration computes
 * for a module document. For an external draft, the selected directory scopes SQL. */
export function previewDesignDocument(input: string, project: string, selected: string | undefined, db: SqliteDatabase) {
  const document = path.resolve(input);
  const content = readDocument(path.dirname(document), path.basename(document));
  if (content === undefined) throw new Error('Expected a regular UTF-8 Markdown file of at most 1 MiB: ' + document);
  const root = fs.realpathSync(project);
  const parent = fs.realpathSync(path.dirname(document));
  const selectedDir = selected ? fs.realpathSync(selected) : root;
  if (!fs.statSync(selectedDir).isDirectory()) throw new Error('Expected a project or module directory: ' + selectedDir);
  const insideProject = isWithinExistingDirectory(parent, root, true);
  const useDocumentParent = sameExistingPath(selectedDir, root) && insideProject;
  const scope = useDocumentParent ? parent : selectedDir;
  if (!isWithinExistingDirectory(scope, root, true)) throw new Error('Module directory is outside the indexed project: ' + scope);
  const module = path.relative(root, scope).split(path.sep).join('/') || '.';

  const sourcePath = insideProject ? path.relative(root, path.join(parent, path.basename(document))).split(path.sep).join('/') : document;
  const mappings = db.transaction(() => extract(sourcePath, content, db, module))();
  return { document, project: root, module, mappings };
}

export function designRules(entries: DesignEntry[]): TermMappingRule[] {
  return entries.map(entry => ({
    terms: [entry.description.replace(/^[\s:：—–-]+/, '').replace(/\s+/g, ' ').trim()],
    symbols: [...new Set(entry.definitions.map(node => node.qualifiedName || node.name))],
    design: { document: entry.document, documentLine: entry.documentLine },
  }));
}

export function serializeDesignRules(rules: TermMappingRule[]): string {
  return JSON.stringify({ rules }, null, 2) + '\n';
}

/** Build against a single published or private candidate index. No writes until
 * the whole document inventory and the loadable configuration have been verified. */
export function buildTermMappings(root: string, db: SqliteDatabase): string {
  const rules: TermMappingRule[] = [];
  for (const document of scanDesignDocuments(root)) {
    const content = readDocument(root, document);
    if (content) rules.push(...designRules(extract(document, content, db)));
  }
  const json = serializeDesignRules(rules);
  if (Buffer.byteLength(json) > MAX_MAPPING_BYTES) throw new Error('Generated term mappings exceed 256 KiB');
  const { errors } = parseTermMappings(json);
  if (errors.length) throw new Error('Invalid generated term mappings: ' + errors.join('; '));
  return json;
}

export function writeTermMappings(dataDir: string, content: string): void {
  const file = path.join(dataDir, TERM_MAPPINGS_FILE);
  const previous = fs.lstatSync(file, { throwIfNoEntry: false });
  if (previous && !previous.isFile()) throw new Error('Expected a regular term mappings file: ' + file);
  const temporary = path.join(dataDir, randomUUID() + '.tmp');
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

/** Caller holds the writer fence and has pinned the current graph through the rename. */
export function regenerateTermMappings(graph: CodeGraph): void {
  const coverage = graph.getIndexCompleteness();
  if (coverage.status !== 'complete' || coverage.legacyUnverified || coverage.diagnostics.length || graph.getPortableCatchup()) {
    throw new Error('Term mappings require a complete, reconciled index');
  }
  const content = buildTermMappings(graph.getProjectRoot(), graph.getExploreQueryConnection());
  writeTermMappings(graph.getDataDirectory(), content);
}
