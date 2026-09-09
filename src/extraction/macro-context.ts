import {
  scanCppMacroDefinitions,
  selectUnambiguousCppMacroDefinitions,
  type CppMacroDefinition,
} from './declaration-macros';

export const CPP_MACRO_MANIFEST_METADATA_KEY = 'cpp_macro_manifest_v1';
export const CPP_MACRO_MANIFEST_READY_METADATA_KEY = 'cpp_macro_manifest_ready_v1';
export const CPP_MACRO_CONTEXT_PENDING_METADATA_KEY = 'cpp_macro_context_pending_v1';

export interface CppMacroFileContribution {
  names: string[];
  bodylessNames: string[];
  definitions: CppMacroDefinition[];
}

export interface CppMacroManifestFile extends CppMacroFileContribution {
  path: string;
}

export interface CppMacroManifest {
  version: 1;
  files: CppMacroManifestFile[];
}

interface CppMacroSemanticEntry {
  bodyless: boolean;
  definitionSignature: string | null;
  dependencies: string[];
  opaqueDependency: boolean;
}

export interface CppMacroContext {
  names: Set<string>;
  bodylessNames: Set<string>;
  definitions: CppMacroDefinition[];
  semanticEntries: Map<string, CppMacroSemanticEntry>;
}

export interface CppMacroContextDiff {
  changedNames: Set<string>;
  affectedNames: Set<string>;
}

const MACRO_NAME_PATTERN = /^[A-Za-z_]\w*$/;
const IDENTIFIER_PATTERN = /[A-Za-z_]\w*/g;

function cloneDefinition(definition: CppMacroDefinition): CppMacroDefinition {
  return {
    name: definition.name,
    parameters: definition.parameters === null ? null : [...definition.parameters],
    variadicParameter: definition.variadicParameter,
    replacement: definition.replacement,
  };
}

function normalizeDefinitionSignature(definition: CppMacroDefinition): string {
  return JSON.stringify([
    definition.parameters,
    definition.variadicParameter ?? null,
    definition.replacement.replace(/\s+/g, ' ').trim(),
  ]);
}

function definitionDependencies(definition: CppMacroDefinition): string[] {
  const formals = new Set(definition.parameters ?? []);
  if (definition.variadicParameter) formals.add(definition.variadicParameter);
  formals.add('__VA_ARGS__');

  const dependencies = new Set<string>();
  IDENTIFIER_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IDENTIFIER_PATTERN.exec(definition.replacement)) !== null) {
    const name = match[0];
    if (!formals.has(name) && name !== definition.name) dependencies.add(name);
  }
  return [...dependencies].sort();
}

function isDefinition(value: unknown): value is CppMacroDefinition {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.name !== 'string' || !MACRO_NAME_PATTERN.test(candidate.name)) return false;
  if (typeof candidate.replacement !== 'string') return false;
  if (
    candidate.parameters !== null &&
    (!Array.isArray(candidate.parameters) ||
      candidate.parameters.some((parameter) =>
        typeof parameter !== 'string' || !MACRO_NAME_PATTERN.test(parameter)
      ))
  ) {
    return false;
  }
  return candidate.variadicParameter === undefined ||
    (typeof candidate.variadicParameter === 'string' &&
      MACRO_NAME_PATTERN.test(candidate.variadicParameter));
}

function normalizeContribution(
  contribution: CppMacroFileContribution,
): CppMacroFileContribution {
  return {
    names: [...new Set(contribution.names)].sort(),
    bodylessNames: [...new Set(contribution.bodylessNames)].sort(),
    definitions: contribution.definitions.map(cloneDefinition),
  };
}

export function isCppMacroContributionEmpty(
  contribution: CppMacroFileContribution,
): boolean {
  return contribution.names.length === 0 &&
    contribution.bodylessNames.length === 0 &&
    contribution.definitions.length === 0;
}

/**
 * A C-family macro definition necessarily contains a literal preprocessor
 * marker. This intentionally accepts false positives (comments, strings and
 * non-define directives) so callers can skip the more expensive regex scans
 * only when an empty contribution is certain.
 */
export function mayContainCppMacroDirective(source: string): boolean {
  return source.includes('#');
}

/** Scan the exact project-wide macro inputs contributed by one C-family file. */
export function scanCppMacroFileContribution(source: string): CppMacroFileContribution {
  const names = new Set<string>();
  const macroRegex = /^\s*#\s*define\s+([A-Za-z_]\w*)/gm;
  let match: RegExpExecArray | null;
  while ((match = macroRegex.exec(source)) !== null) {
    const name = match[1];
    if (name) names.add(name);
  }

  const bodylessNames = new Set<string>();
  const bodylessRegex = /^\s*#\s*define\s+([A-Za-z_]\w*)(?!\s*\()(?:[ \t]*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/[ \t]*)?)?[ \t]*$/gm;
  while ((match = bodylessRegex.exec(source)) !== null) {
    const name = match[1];
    if (name) bodylessNames.add(name);
  }

  return normalizeContribution({
    names: [...names],
    bodylessNames: [...bodylessNames],
    definitions: scanCppMacroDefinitions(source),
  });
}

export function cppMacroManifestToMap(
  manifest: CppMacroManifest,
): Map<string, CppMacroFileContribution> {
  return new Map(
    manifest.files.map((file) => [
      file.path,
      normalizeContribution(file),
    ]),
  );
}

export function cppMacroManifestFromMap(
  files: ReadonlyMap<string, CppMacroFileContribution>,
): CppMacroManifest {
  return {
    version: 1,
    files: [...files.entries()]
      .filter(([, contribution]) => !isCppMacroContributionEmpty(contribution))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([filePath, contribution]) => ({
        path: filePath,
        ...normalizeContribution(contribution),
      })),
  };
}

export function serializeCppMacroManifest(manifest: CppMacroManifest): string {
  return JSON.stringify(cppMacroManifestFromMap(cppMacroManifestToMap(manifest)));
}

export function parseCppMacroManifest(raw: string | null): CppMacroManifest | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as Record<string, unknown>;
    if (candidate.version !== 1 || !Array.isArray(candidate.files)) return null;

    const files = new Map<string, CppMacroFileContribution>();
    for (const value of candidate.files) {
      if (!value || typeof value !== 'object') return null;
      const file = value as Record<string, unknown>;
      if (typeof file.path !== 'string' || file.path.length === 0) return null;
      if (!Array.isArray(file.names) || file.names.some((name) =>
        typeof name !== 'string' || !MACRO_NAME_PATTERN.test(name)
      )) return null;
      if (!Array.isArray(file.bodylessNames) || file.bodylessNames.some((name) =>
        typeof name !== 'string' || !MACRO_NAME_PATTERN.test(name)
      )) return null;
      if (!Array.isArray(file.definitions) || file.definitions.some((definition) =>
        !isDefinition(definition)
      )) return null;

      files.set(file.path, normalizeContribution({
        names: file.names as string[],
        bodylessNames: file.bodylessNames as string[],
        definitions: (file.definitions as CppMacroDefinition[]).map(cloneDefinition),
      }));
    }
    return cppMacroManifestFromMap(files);
  } catch {
    return null;
  }
}

export function buildCppMacroContext(manifest: CppMacroManifest): CppMacroContext {
  const names = new Set<string>();
  const bodylessNames = new Set<string>();
  const allDefinitions: CppMacroDefinition[] = [];

  for (const file of manifest.files) {
    for (const name of file.names) names.add(name);
    for (const name of file.bodylessNames) bodylessNames.add(name);
    allDefinitions.push(...file.definitions.map(cloneDefinition));
  }

  const definitions = selectUnambiguousCppMacroDefinitions(allDefinitions);
  const definitionByName = new Map(definitions.map((definition) => [definition.name, definition]));
  const semanticEntries = new Map<string, CppMacroSemanticEntry>();
  for (const name of [...names].sort()) {
    const definition = definitionByName.get(name);
    semanticEntries.set(name, {
      bodyless: bodylessNames.has(name),
      definitionSignature: definition ? normalizeDefinitionSignature(definition) : null,
      dependencies: definition ? definitionDependencies(definition) : [],
      // Token pasting can synthesize a macro identifier that is not present as
      // a literal token in the replacement. If any macro changes, users of such
      // a definition are conservatively invalidated.
      opaqueDependency: definition?.replacement.includes('##') ?? false,
    });
  }

  return { names, bodylessNames, definitions, semanticEntries };
}

function semanticEntryKey(entry: CppMacroSemanticEntry | undefined): string | null {
  if (!entry) return null;
  return JSON.stringify([entry.bodyless, entry.definitionSignature]);
}

/**
 * Return macros whose effective semantics changed, plus every macro that can
 * expand through one of them. The reverse dependency graph is the union of the
 * old and new contexts so additions, removals and conflict transitions are all
 * conservative.
 */
export function diffCppMacroContexts(
  previous: CppMacroContext,
  current: CppMacroContext,
): CppMacroContextDiff {
  const allNames = new Set([
    ...previous.semanticEntries.keys(),
    ...current.semanticEntries.keys(),
  ]);
  const changedNames = new Set<string>();
  for (const name of allNames) {
    if (
      semanticEntryKey(previous.semanticEntries.get(name)) !==
      semanticEntryKey(current.semanticEntries.get(name))
    ) {
      changedNames.add(name);
    }
  }

  if (changedNames.size === 0) {
    return { changedNames, affectedNames: new Set<string>() };
  }

  const reverseDependencies = new Map<string, Set<string>>();
  const opaqueMacros = new Set<string>();
  for (const context of [previous, current]) {
    for (const [name, entry] of context.semanticEntries) {
      if (entry.opaqueDependency) opaqueMacros.add(name);
      for (const dependency of entry.dependencies) {
        if (!allNames.has(dependency)) continue;
        let dependents = reverseDependencies.get(dependency);
        if (!dependents) {
          dependents = new Set<string>();
          reverseDependencies.set(dependency, dependents);
        }
        dependents.add(name);
      }
    }
  }

  const affectedNames = new Set([...changedNames, ...opaqueMacros]);
  const queue = [...affectedNames];
  for (let index = 0; index < queue.length; index++) {
    const name = queue[index]!;
    for (const dependent of reverseDependencies.get(name) ?? []) {
      if (affectedNames.has(dependent)) continue;
      affectedNames.add(dependent);
      queue.push(dependent);
    }
  }
  return { changedNames, affectedNames };
}

/** Conservative raw-token check: comments and strings may cause extra work, never misses. */
export function sourceReferencesAnyCppMacro(
  source: string,
  macroNames: ReadonlySet<string>,
): boolean {
  if (macroNames.size === 0) return false;
  IDENTIFIER_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IDENTIFIER_PATTERN.exec(source)) !== null) {
    if (macroNames.has(match[0])) return true;
  }
  return false;
}
