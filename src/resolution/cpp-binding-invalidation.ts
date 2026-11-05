import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { QueryBuilder } from '../db/queries';
import type { FileRecord } from '../types';
import { CCppSourceScope } from '../extraction/c-cpp-source-scope';
import { cppIdentityTokens } from '../extraction/c-cpp-macro-types';
import { maskCStyleCommentsAndLiterals } from '../extraction/grammars';

const SNAPSHOT = 'resolution:cpp-binding-file-v1:';
const INVENTORY = 'resolution:cpp-binding-inventory-v1';
const JOURNAL = 'resolution:cpp-binding-job-v1';
const REFRESH = 'resolution:cpp-binding-refresh-v1:';
const MAX_SCOPE_SOURCE = 8 * 1024 * 1024;
const hash = (source: string) => createHash('sha256').update(source).digest('hex');
const cpp = (file: FileRecord) => file.language === 'c' || file.language === 'cpp';
interface Snapshot {
  contentHash: string;
  digest: string;
  names: string[];
  includes: string[];
  opaqueInclude: boolean;
}
interface Job {
  version: 1;
  updates: Record<string, Snapshot | null>;
  inventory: Record<string, string>;
  files: string[];
}
export interface CppBindingInvalidationResult { files: string[]; refreshFiles: string[] }

function balancedSource(source: string, scope: CCppSourceScope): boolean {
  if (!scope.isBalanced()) return false;
  const code = maskCStyleCommentsAndLiterals(source), stack: string[] = [];
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  for (let at = 0; at < code.length; at++) {
    if (scope.isDirective(at)) continue;
    const token = code[at]!;
    if (pairs[token]) stack.push(pairs[token]!);
    else if ([')', ']', '}'].includes(token) && stack.pop() !== token) return false;
  }
  return stack.length === 0;
}

function sourceFacts(source: string): Pick<Snapshot, 'digest' | 'includes' | 'opaqueInclude'> {
  const scope = source.length <= MAX_SCOPE_SOURCE ? new CCppSourceScope(source) : null;
  const includes = new Set<string>();
  let opaqueInclude = !scope;
  for (const match of source.matchAll(/^[ \t]*#[ \t]*include\b([^\r\n]*)/gm)) {
    const at = match.index! + match[0].indexOf('#');
    if (scope && !scope.isDirective(at)) continue;
    const literal = /^\s*[<"]([^>"\r\n]+)[>"]\s*(?:\/\/.*|\/\*.*\*\/\s*)?$/.exec(match[1]!);
    if (literal) includes.add(literal[1]!.replace(/\\/g, '/'));
    else opaqueInclude = true;
  }
  // Damaged scopes, token splicing, raw strings and exotic preprocessing are
  // not a safe body-retention proof. Hash their complete source conservatively.
  // A bare invocation followed by a body may expand to a type container.
  // Without a return/type declaration witness it is not safe to erase that
  // body. This also conservatively covers uncertain constructor spellings.
  const macroContainer = scope !== null && [...maskCStyleCommentsAndLiterals(source).matchAll(
    /(?:^|[;{}])\s*([A-Za-z_]\w*(?:::\w+)*)\s*\([^;{}]*\)\s*\{/gm,
  )].some(match => {
    const at = match.index! + match[0].indexOf(match[1]!);
    return !scope.isExecutable(at) && !scope.isDirective(at);
  });
  if (!scope || !balancedSource(source, scope) || macroContainer || /R"|\\\r?\n|\?\?|<%|%>|%:/.test(source)) {
    return { digest: 'full:' + hash(source), includes: [...includes].sort(), opaqueInclude };
  }
  const parts: Array<[string, string | string[]]> = [];
  let ordinary = '';
  const flush = () => {
    const tokens = cppIdentityTokens(ordinary);
    if (tokens.length) parts.push(['declaration', tokens]);
    ordinary = '';
  };
  for (let at = 0; at < source.length;) {
    if (scope.isDirective(at)) {
      flush();
      const start = at++;
      while (at < source.length && scope.isDirective(at)) at++;
      // Exact directive spelling matters: macro whitespace and quoted include
      // names cannot be normalized like ordinary declaration token boundaries.
      parts.push(['directive', source.slice(start, at)]);
    } else if (scope.isExecutable(at)) {
      flush();
      do { at++; } while (at < source.length && scope.isExecutable(at) && !scope.isDirective(at));
    } else ordinary += source[at++];
  }
  flush();
  return { digest: 'scope:' + hash(JSON.stringify(parts)), includes: [...includes].sort(), opaqueInclude };
}

/** Only a balanced, non-executable declaration/directive projection proves retention. */
export function cppBindingEvidenceDigest(source: string): string { return sourceFacts(source).digest; }

function snapshot(root: string, file: FileRecord, queries: QueryBuilder): Snapshot {
  const source = fs.readFileSync(path.join(root, file.path), 'utf8');
  if (hash(source) !== file.contentHash) {
    throw new Error(`C/C++ binding evidence changed while indexing ${file.path}; retry sync before publishing its snapshot`);
  }
  const facts = sourceFacts(source);
  return { contentHash: file.contentHash, ...facts, digest: file.language + ':' + facts.digest,
    names: queries.getNodeNamesByFiles([file.path]).sort() };
}

function decode<T>(raw: string | null, label: string): T | null {
  if (raw === null) return null;
  try { return JSON.parse(raw) as T; }
  catch { throw new Error(`Cannot decode ${label}; a complete index is required to rebuild binding evidence`); }
}

/** Called only after a successful complete index, when all old bindings were rebuilt. */
export async function establishCppBindingBaseline(root: string, queries: QueryBuilder): Promise<void> {
  const changes: Record<string, string | null> = {};
  const inventory: Record<string, string> = {};
  for (const { key } of queries.getMetadataByPrefix(SNAPSHOT)) changes[key] = null;
  let visited = 0;
  for (const file of queries.getAllFiles().filter(cpp)) {
    const next = snapshot(root, file, queries);
    changes[SNAPSHOT + file.path] = JSON.stringify(next);
    inventory[file.path] = file.contentHash;
    if (++visited % 32 === 0) await new Promise<void>(resolve => setImmediate(resolve));
  }
  for (const { key } of queries.getMetadataByPrefix(REFRESH)) changes[key] = null;
  changes[INVENTORY] = JSON.stringify(inventory);
  changes[JOURNAL] = null;
  queries.applyMetadataChanges(changes);
}

/** Acknowledgment belongs after the returned callers were successfully re-extracted. */
export function acknowledgeCppBindingRefresh(queries: QueryBuilder, files: readonly string[], root?: string): void {
  const changes: Record<string, null> = Object.fromEntries(files.map(file => [REFRESH + file, null]));
  if (root) {
    const project = path.resolve(root);
    for (const { key } of queries.getMetadataByPrefix(REFRESH)) {
      const file = key.slice(REFRESH.length);
      if (queries.getFileByPath(file)) continue;
      const absolute = path.resolve(project, file), relative = path.relative(project, absolute);
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
      try {
        // A missing DB row can be an interrupted replacement. Keep any source
        // entry (including a dangling symlink), and unknown filesystem errors.
        fs.lstatSync(absolute);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') changes[key] = null;
      }
    }
  }
  queries.applyMetadataChanges(changes);
}

function reverseIncludes(snapshots: Map<string, Snapshot>, paths: readonly string[]): Map<string, Set<string>> {
  const known = new Set(paths), byLeaf = new Map<string, string[]>();
  for (const file of paths) {
    const leaf = path.posix.basename(file);
    const list = byLeaf.get(leaf) ?? []; list.push(file); byLeaf.set(leaf, list);
  }
  const reverse = new Map<string, Set<string>>();
  for (const [from, facts] of snapshots) for (const name of facts.includes) {
    const normalized = path.posix.normalize(name);
    const possible = new Set([path.posix.normalize(path.posix.join(path.posix.dirname(from), normalized)), normalized]);
    for (const candidate of byLeaf.get(path.posix.basename(normalized)) ?? []) {
      if (candidate === normalized || candidate.endsWith('/' + normalized)) possible.add(candidate);
    }
    for (const target of possible) {
      if (!known.has(target)) continue;
      const sources = reverse.get(target) ?? new Set<string>(); sources.add(from); reverse.set(target, sources);
    }
  }
  return reverse;
}

async function replayJob(job: Job, queries: QueryBuilder): Promise<string[]> {
  for (const file of job.files) {
    const result = await queries.requeueCppBindingEdges(file);
    if (result.requiresRefresh) queries.setMetadata(REFRESH + file, '1');
  }
  // Every removed edge already has its original reference durably pending.
  // Publication and journal removal are one transaction; interruption before
  // this point leaves the old snapshot and complete replay plan available.
  const changes: Record<string, string | null> = { [INVENTORY]: JSON.stringify(job.inventory), [JOURNAL]: null };
  for (const [file, next] of Object.entries(job.updates)) changes[SNAPSHOT + file] = next ? JSON.stringify(next) : null;
  queries.applyMetadataChanges(changes);
  return job.files;
}

/**
 * Run after extraction and before resolution on sync. Stored hashes select only
 * files actually written by this sync, so an unrelated on-disk edit outside a
 * scoped sync cannot donate evidence. No-op/body-only edits never probe edges.
 */
export async function invalidateCppBindingChanges(root: string, queries: QueryBuilder): Promise<CppBindingInvalidationResult> {
  const files = new Set<string>();
  const previousJob = decode<Job>(queries.getMetadata(JOURNAL), 'C/C++ binding invalidation journal');
  if (previousJob) {
    if (previousJob.version !== 1 || !Array.isArray(previousJob.files) || !previousJob.updates || !previousJob.inventory) {
      throw new Error('Invalid C/C++ binding invalidation journal; complete indexing must rebuild it');
    }
    for (const file of await replayJob(previousJob, queries)) files.add(file);
  }
  const before = decode<Record<string, string>>(queries.getMetadata(INVENTORY), 'C/C++ binding inventory') ?? {};
  const currentFiles = queries.getAllFiles().filter(cpp), current = new Map(currentFiles.map(file => [file.path, file]));
  const inventory = Object.fromEntries(currentFiles.map(file => [file.path, file.contentHash]));
  const changed = [...new Set([...Object.keys(before), ...current.keys()])].filter(file => before[file] !== inventory[file]);
  const updates: Record<string, Snapshot | null> = {}, evidenceChanged: string[] = [], names = new Set<string>();
  for (const file of changed) {
    const prior = decode<Snapshot>(queries.getMetadata(SNAPSHOT + file), `C/C++ binding snapshot for ${file}`);
    const record = current.get(file), next = record ? snapshot(root, record, queries) : null;
    updates[file] = next;
    if (prior?.digest === next?.digest && prior && next) continue;
    evidenceChanged.push(file);
    for (const name of [...(prior?.names ?? []), ...(next?.names ?? [])]) names.add(name);
  }
  if (evidenceChanged.length) {
    const old = new Map<string, Snapshot>();
    for (const { key, value } of queries.getMetadataByPrefix(SNAPSHOT)) {
      const facts = decode<Snapshot>(value, `C/C++ binding snapshot for ${key.slice(SNAPSHOT.length)}`);
      if (facts) old.set(key.slice(SNAPSHOT.length), facts);
    }
    const next = new Map(old);
    for (const [file, facts] of Object.entries(updates)) { if (facts) next.set(file, facts); else next.delete(file); }
    const allPaths = [...new Set([...old.keys(), ...current.keys()])];
    const oldReverse = reverseIncludes(old, allPaths), newReverse = reverseIncludes(next, allPaths);
    const affected = new Set(evidenceChanged);
    for (const [file, facts] of [...old, ...next]) if (facts.opaqueInclude) affected.add(file);
    const queue = [...affected];
    for (let at = 0; at < queue.length; at++) {
      for (const source of [...(oldReverse.get(queue[at]!) ?? []), ...(newReverse.get(queue[at]!) ?? [])]) {
        if (!affected.has(source)) { affected.add(source); queue.push(source); }
      }
    }
    for (const file of evidenceChanged) for (const source of queries.getDependentFilePaths(file)) affected.add(source);
    for (const file of queries.getCppBindingSourceFilesForNames([...names])) affected.add(file);
    // Missing/removed files have no owned references left. Their callers were
    // collected from the old include graph or the existing resurrection path.
    const job: Job = { version: 1, updates, inventory, files: [...affected].filter(file => current.has(file)).sort() };
    queries.setMetadata(JOURNAL, JSON.stringify(job));
    for (const file of await replayJob(job, queries)) files.add(file);
  } else if (changed.length) {
    const changes: Record<string, string | null> = { [INVENTORY]: JSON.stringify(inventory) };
    for (const [file, next] of Object.entries(updates)) changes[SNAPSHOT + file] = next ? JSON.stringify(next) : null;
    queries.applyMetadataChanges(changes);
  }
  const refreshFiles = queries.getMetadataByPrefix(REFRESH).map(row => row.key.slice(REFRESH.length)).filter(file => current.has(file));
  return { files: [...files].sort(), refreshFiles: refreshFiles.sort() };
}
