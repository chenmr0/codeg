/** Include-reachable evidence for declaration recovery, not a C preprocessor. */
import * as path from 'node:path';
import { selectUnambiguousCppMacroDefinitions, type CppMacroDefinition } from './declaration-macros';

export interface MacroFileEvidence {
  definitions: CppMacroDefinition[];
  includes: string[];
}
export type MacroProjectEvidence = Record<string, MacroFileEvidence>;

/** Ignore comments without treating quoted include names as comment text. */
export function scanLiteralIncludes(source: string): Array<{ name: string; start: number }> {
  // Walk the same lexical exclusions without allocating two masked copies of
  // every source file. Keep physical newlines and UTF-16 offsets unchanged.
  const tokens = /(?:u8|u|U|L)?R"([^ ()\\\t\r\n]{0,16})\([\s\S]*?\)\1"|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*|#/g;
  const includes = [];
  let cursor = 0, trivia = true, quotedPrefix = false;
  for (let token; (token = tokens.exec(source));) {
    const gap = source.slice(cursor, token.index);
    const newline = gap.lastIndexOf('\n');
    if (newline >= 0) quotedPrefix = false;
    trivia = newline < 0 ? trivia && /^[ \t]*$/.test(gap) : /^[ \t]*$/.test(gap.slice(newline + 1));
    if (token[0] === '#') {
      if (trivia) {
        const end = source.indexOf('\n', token.index);
        const directive = source.slice(token.index, end < 0 ? source.length : end);
        const match = /^#[ \t]*(?:\/\*[^\n]*?\*\/[ \t]*)*include[ \t]*(?:\/\*[^\n]*?\*\/[ \t]*)*(["<])([^">\r\n]+)[">]/.exec(directive);
        // Preserve the existing masking semantics even for unusual header names.
        if (match && match[1] === '<') {
          if (match[2]!.includes('//')) { cursor = tokens.lastIndex; trivia = false; continue; }
          match[2] = match[2]!.replace(/\/\*[^\n]*?\*\//g, comment => ' '.repeat(comment.length));
        }
        if (match && !(quotedPrefix && match[1] === '"')) includes.push({ name: match[2]!, start: source.lastIndexOf('\n', token.index - 1) + 1 });
      }
      trivia = false;
    } else {
      if (token[0].includes('\n')) { trivia = true; quotedPrefix = false; }
      // The former first pass kept quoted tokens: a quoted header after such
      // a same-line prefix was not retained by the second pass.
      if (token[0].startsWith('"') || token[0].startsWith("'")) quotedPrefix = true;
    }
    cursor = tokens.lastIndex;
  }
  return includes;
}

const suffixIndexes = new WeakMap<MacroProjectEvidence, Map<string, string | null>>();
function suffixIndex(project: MacroProjectEvidence): Map<string, string | null> {
  const cached = suffixIndexes.get(project);
  if (cached) return cached;
  const index = new Map<string, string | null>();
  for (const file of Object.keys(project)) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) {
      const suffix = parts.slice(i).join('/');
      index.set(suffix, index.has(suffix) ? null : file);
    }
  }
  suffixIndexes.set(project, index);
  return index;
}

/** Exact local/root matches first; a unique project suffix supports -I roots.
 * Ambiguous suffixes and computed includes provide no expansion evidence. */
function resolveInclude(project: MacroProjectEvidence, from: string, name: string): string | undefined {
  const normalized = name.replace(/\\/g, '/');
  for (const candidate of [path.posix.normalize(path.posix.join(path.posix.dirname(from), normalized)), normalized]) {
    if (Object.hasOwn(project, candidate)) return candidate;
  }
  return suffixIndex(project).get(normalized) ?? undefined;
}

const closureCaches = new WeakMap<MacroProjectEvidence, Map<string, CppMacroDefinition[]>>();
/** Cache each header closure once per context/worker, not once per translation unit. */
function headerDefinitions(project: MacroProjectEvidence, file: string): CppMacroDefinition[] {
  let cache = closureCaches.get(project);
  if (!cache) { cache = new Map(); closureCaches.set(project, cache); }
  const cached = cache.get(file);
  if (cached) return cached;
  const seen = new Set<string>(), pending = [file], definitions: CppMacroDefinition[] = [];
  while (pending.length) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    definitions.push(...project[current]!.definitions);
    for (const name of project[current]!.includes) {
      const target = resolveInclude(project, current, name);
      if (target) pending.push(target);
    }
  }
  const selected = selectUnambiguousCppMacroDefinitions(definitions);
  cache.set(file, selected);
  return selected;
}

const recoveryCaches = new WeakMap<MacroProjectEvidence, Map<string, CppMacroDefinition>>();
function recoveryDefinitions(project: MacroProjectEvidence): Map<string, CppMacroDefinition> {
  const cached = recoveryCaches.get(project);
  if (cached) return cached;
  const origins = new Map<string, string[]>();
  const all: CppMacroDefinition[] = [];
  for (const [file, evidence] of Object.entries(project)) {
    for (const definition of evidence.definitions) {
      all.push(definition);
      const files = origins.get(definition.name) ?? [];
      files.push(file); origins.set(definition.name, files);
    }
  }
  const result = new Map(selectUnambiguousCppMacroDefinitions(all).map(definition => [definition.name, {
    ...definition, recoveryOnly: true, recoveryOrigins: origins.get(definition.name),
  }]));
  recoveryCaches.set(project, result);
  return result;
}

export function visibleMacroDefinitions(
  project: MacroProjectEvidence,
  file: string,
  source: string,
): CppMacroDefinition[] {
  const definitions: CppMacroDefinition[] = [];
  const positions = new Map<string, number[]>();
  for (const include of scanLiteralIncludes(source)) {
    const target = resolveInclude(project, file, include.name);
    if (!target || target === file) continue;
    for (const definition of headerDefinitions(project, target)) {
      definitions.push(definition);
      const offsets = positions.get(definition.name) ?? [];
      offsets.push(include.start); positions.set(definition.name, offsets);
    }
  }
  const selected: CppMacroDefinition[] = selectUnambiguousCppMacroDefinitions(definitions).map(definition => ({
    ...definition, visibleAfter: positions.get(definition.name)![0],
    includeOffsets: positions.get(definition.name),
  }));
  const includedNames = new Set(definitions.map(definition => definition.name));
  const globals = recoveryDefinitions(project);
  // Preserve the pre-existing declaration-entry recovery contract for forced,
  // computed and external includes. These are candidates, NOT visible macros:
  // recursive argument expansion cannot consult this project-wide fallback.
  for (const name of new Set(source.match(/[A-Za-z_]\w*/g) ?? [])) {
    if (includedNames.has(name)) continue;
    const definition = globals.get(name);
    if (!definition) continue;
    if (!definition.recoveryScope) {
      const scope = selectUnambiguousCppMacroDefinitions((definition.recoveryOrigins ?? [])
        .flatMap(origin => headerDefinitions(project, origin)));
      definition.recoveryScope = Object.fromEntries(scope.map(item => [item.name, item]));
    }
    selected.push(definition);
  }
  return selected;
}
