import * as fs from 'node:fs';
import * as path from 'node:path';
import { Lexer, type Token } from 'marked';
import type { SqliteDatabase } from './db/sqlite-adapter';
import { scanDesignDocuments } from './extraction';
import { isWithinExistingDirectory, sameExistingPath } from './path-identity';
import { validatePathWithinRoot } from './utils';
import { logWarn } from './errors';
import { randomUUID } from 'node:crypto';
import { MAX_DESIGN_SEEDS } from './design-recall';
import { designDraftPath, type TermMappingRule } from './term-mappings';

interface Definition { name: string; qualifiedName: string; kind: string; file: string; line: number }
interface DesignEntry {
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
  function add(item: Fragment, evidence: string): void {
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
    if (!rows.length) return;
    entries.push({ heading: [heading, label].filter(Boolean).join(' '), description: item.text,
      evidence: evidence.trim(), reference: symbol, definitions: rows });
  }

  function list(items: { raw: string; tokens: Token[] }[], definition?: Fragment, title = ''): void {
    for (const item of items) {
      const row = fragment(item.tokens);
      if (!row.symbols.length && definition && /^(定义|表示|用于|描述|包含)/.test(row.text)) {
        add({ ...definition, text: definition.text + ' ' + row.text }, title + '\n' + item.raw);
      } else add(row, title ? title + '\n' + item.raw : item.raw);
      for (const token of item.tokens) if (token.type === 'list') list(token.items, undefined, title);
    }
  }
  let definition: Fragment | undefined, title = '';
  for (const token of Lexer.lex(content)) {
    if (token.type === 'space') continue;
    if (token.type === 'list') {
      list(token.items, definition, title);
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
      add(item, token.raw);
      title = token.raw.trim();
      if (item.direct) definition = item;
    } else if (token.type === 'table') {
      const header = token.header.map((cell: { text: string }) => cell.text.trim().toLowerCase());
      const symbolColumn = header.findIndex((name: string) => /^(符号|宏|接口|函数|类型|symbol|function)$/.test(name));
      const description = header.findIndex((name: string) => /^(说明|含义|用途|描述|业务术语|description)$/.test(name));
      if (symbolColumn < 0 || description < 0) continue;
      for (const row of token.rows) {
        const ref = fragment(row[symbolColumn].tokens);
        const body = fragment(row[description].tokens);
        if (!body.symbols.length) add({ ...ref, text: body.text, direct: true },
          row.map((cell: { text: string }) => cell.text).join(' | '));
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
    if (!st.isFile() || st.size > MAX_DOC_BYTES) return;
    const bytes = Buffer.alloc(st.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = fs.readSync(fd, bytes, count, bytes.length - count, null);
      if (!read) break;
      count += read;
    }
    if (count !== st.size) throw new Error('Document changed during indexing: ' + file);
    return bytes.toString('utf8', 0, count);
  } finally { fs.closeSync(fd); }
}

/** Preview the file on disk, using the very same bindings init/sync would compute
 * for a module document. For an external draft, the selected directory scopes SQL. */
export function previewDesignDocument(input: string, project: string, selected: string | undefined, db: SqliteDatabase) {
  const document = path.resolve(input);
  const content = readDocument(path.dirname(document), path.basename(document));
  if (content === undefined) throw new Error('Expected a regular UTF-8 Markdown file of at most 1 MiB: ' + document);
  const root = fs.realpathSync(project);
  const parent = fs.realpathSync(path.dirname(document));
  const selectedDir = selected ? fs.realpathSync(selected) : root;
  if (!fs.statSync(selectedDir).isDirectory()) throw new Error('Expected a project or module directory: ' + selectedDir);
  const useDocumentParent = sameExistingPath(selectedDir, root) && isWithinExistingDirectory(parent, root, true);
  const scope = useDocumentParent ? parent : selectedDir;
  if (!isWithinExistingDirectory(scope, root, true)) throw new Error('Module directory is outside the indexed project: ' + scope);
  const module = path.relative(root, scope).split(path.sep).join('/') || '.';

  const mappings = db.transaction(() => extract(document, content, db, module))();
  return { document, project: root, module, mappings };
}

export function designRules(document: string, entries: DesignEntry[]): TermMappingRule[] {
  return entries.map(entry => ({
    terms: [entry.description.replace(/^[\s:：—–-]+/, '').replace(/\s+/g, ' ').trim()],
    symbols: [...new Set(entry.definitions.map(node => node.qualifiedName || node.name))],
    design: { document, heading: entry.heading, reference: entry.reference, file: entry.definitions[0]!.file, evidence: entry.evidence },
  }));
}

export function serializeDesignRules(rules: TermMappingRule[]): string {
  return JSON.stringify({ rules }, null, 2) + '\n';
}

/** Only ancestors of indexed source files can contain module-local definitions.
 * Avoid running an additional inventory in projects without module documents. */
export function buildDesignDraft(root: string, db: SqliteDatabase, sources: readonly {path: string}[]): string | null | undefined {
  try {
    const dirs = new Set<string>();
    let found = false;
    for (const file of sources) {
      let dir = path.posix.dirname(file.path);
      while (!dirs.has(dir)) {
        dirs.add(dir);
        if (['Design.md', 'design.md'].some(name => fs.lstatSync(path.join(root, dir, name), { throwIfNoEntry: false })?.isFile())) { found = true; break; }
        if (dir === '.') break;
        dir = path.posix.dirname(dir);
      }
      if (found) break;
    }
    if (!found) return null;
    const rules: TermMappingRule[] = [];
    for (const document of scanDesignDocuments(root)) {
      const content = readDocument(root, document);
      if (content) rules.push(...designRules(document, extract(document, content, db)));
    }
    return serializeDesignRules(rules);
  } catch (error) {
    logWarn('Could not extract the Design.md review draft', { error: String(error) });
    return undefined;
  }
}

/** Publish only a completely scanned draft. A missing corpus clears an existing
 * draft; failed scans and unpublished candidates leave the last draft intact. */
export function publishDesignDraft(dataDir: string, content: string | null | undefined): void {
  if (content === undefined) return;
  try {
    const file = designDraftPath(dataDir);
    const directory = path.dirname(file);
    const directoryStat = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (content === null && !directoryStat) return;
    if (directoryStat && !directoryStat.isDirectory()) throw new Error('Expected a regular review directory: ' + directory);
    const previous = fs.lstatSync(file, { throwIfNoEntry: false });
    if (previous && !previous.isFile()) throw new Error('Expected a regular draft file: ' + file);

    if (content === null && !previous) return;
    const draft = content ?? serializeDesignRules([]);
    if (previous?.size === Buffer.byteLength(draft) && fs.readFileSync(file, 'utf8') === draft) return;
    fs.mkdirSync(directory, { recursive: true });
    const temporary = path.join(directory, randomUUID() + '.tmp');
    try {
      fs.writeFileSync(temporary, draft, { flag: 'wx' });
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
  } catch (error) {
    logWarn('Could not refresh the Design.md review draft', { error: String(error) });
  }
}
