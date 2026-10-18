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
  // Remove comments first, preserving quoted tokens; the second pass can then
  // recognize #include/**/"file.h" without consulting an unclean prefix.
  const uncommented = source.replace(/(?:u8|u|U|L)?R"([^ ()\\\t\r\n]{0,16})\([\s\S]*?\)\1"|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    token => token.startsWith('"') || token.startsWith("'") ? token : token.replace(/[^\n]/g, ' '));
  const clean = uncommented.replace(/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g,
    (token: string, offset: number) => {
      const prefix = uncommented.slice(uncommented.lastIndexOf('\n', offset - 1) + 1, offset);
      return token.startsWith('"') && /^[ \t]*#[ \t]*include[ \t]*$/.test(prefix)
        ? token : token.replace(/[^\n]/g, ' ');
    });
  return Array.from(clean.matchAll(/^[ \t]*#[ \t]*include[ \t]*["<]([^">\r\n]+)[">]/gm),
    match => ({ name: match[1]!, start: match.index! }));
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
