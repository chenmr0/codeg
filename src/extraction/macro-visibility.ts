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
  const clean = source.replace(/(?:u8|u|U|L)?R"([^ ()\\\t\r\n]{0,16})\([\s\S]*?\)\1"|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (token: string, _delimiter: string | undefined, offset: number) => {
      const prefix = source.slice(source.lastIndexOf('\n', offset - 1) + 1, offset);
      if (token.startsWith('"') && /^[ \t]*#[ \t]*include[ \t]*$/.test(prefix)) return token;
      return token.replace(/[^\n]/g, ' ');
    });
  return Array.from(clean.matchAll(/^[ \t]*#[ \t]*include[ \t]+["<]([^">\r\n]+)[">]/gm),
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

export function visibleMacroDefinitions(
  project: MacroProjectEvidence,
  file: string,
  source: string,
): CppMacroDefinition[] {
  const reachable = new Map<string, number>();
  for (const include of scanLiteralIncludes(source)) {
    const pending = [{ from: file, name: include.name }];
    while (pending.length) {
      const next = pending.pop()!;
      const target = resolveInclude(project, next.from, next.name);
      if (!target || target === file || reachable.has(target)) continue;
      reachable.set(target, include.start);
      for (const name of project[target]!.includes) pending.push({ from: target, name });
    }
  }
  const definitions: CppMacroDefinition[] = [];
  const starts = new Map<string, number>();
  for (const [included, start] of reachable) {
    for (const definition of project[included]!.definitions) {
      definitions.push(definition);
      starts.set(definition.name, Math.min(starts.get(definition.name) ?? Infinity, start));
    }
  }
  // Conflicts outside the include closure cannot erase a valid macro. Within
  // the closure retain the established conservative ambiguous-name policy.
  return selectUnambiguousCppMacroDefinitions(definitions).map(definition => ({
    ...definition, visibleAfter: starts.get(definition.name),
  }));
}
