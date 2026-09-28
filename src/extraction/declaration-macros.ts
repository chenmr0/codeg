/**
 * Conservative C/C++ declaration-macro recovery.
 *
 * Tree-sitter intentionally does not run a preprocessor, so a macro invocation
 * that *creates* a declaration has no declaration node to visit.  This module
 * implements the small, deterministic subset of preprocessing needed to build
 * an auxiliary parse source for those invocations.  It is deliberately not a
 * conditional-compilation evaluator:
 *
 * - only unambiguous project-wide definitions are shared across files;
 * - a same-file definition overrides the project definition only after its
 *   `#define` line;
 * - expansion is bounded by depth, output size, and invocation count;
 * - source invocations are replaced only when the fully expanded text has a
 *   declaration shape (or is a structural closing macro such as `}`);
 * - line count is preserved, so recovered nodes map back to the invocation.
 */

export interface CppMacroDefinition {
  name: string;
  /** null for an object-like macro, an array for a function-like macro. */
  parameters: string[] | null;
  variadicParameter?: string;
  replacement: string;
  /** Source offset for same-file ordering. Omitted for project-wide entries. */
  start?: number;
  end?: number;
}

/** Original UTF-16 range and recursively expanded replacement of one invocation. */
export interface DeclarationMacroCandidate {
  start: number;
  end: number;
  expansion: string;
}

/**
 * A bounded token replacement that cannot escape its initializer expression.
 * This is a lexical boundary proof, not declaration/expression type inference.
 * Reject structural tokens even in nested bodies; uncertain syntax keeps the
 * recovery path. Never use this predicate to suppress top-level declarations.
 */
export function preservesInitializerBoundary(text: string): boolean {
  if (!text.trim() || text.length >= MAX_EXPANSION_BYTES || /R"|\\|\?\?|<%|%>|<:|:>|%:/.test(text)) return false;
  const stack: string[] = [];
  for (let i = 0; i < text.length;) {
    const char = text[i]!;
    if (char === '"' || char === "'") {
      const end = skipQuoted(text, i);
      if (end <= i + 1 || text[end - 1] !== char || /[\r\n]/.test(text.slice(i, end))) return false;
      i = end;
      continue;
    }
    if (char === '/' && text[i + 1] === '/') return false;
    if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return false;
      i = end + 2;
      continue;
    }
    if ('{};#'.includes(char)) return false;
    if (char === '(' || char === '[') stack.push(char);
    else if (char === ')' || char === ']') {
      if (stack.pop() !== (char === ')' ? '(' : '[')) return false;
    }
    i++;
  }
  return stack.length === 0;
}

export interface DeclarationMacroExpansion {
  source: string;
  /** 1-indexed source lines on which a declaration-producing invocation began. */
  invocationLines: Set<number>;
  expandedMacroNames: Set<string>;
  /** Remaining source was not inspected after the bounded expansion budget. */
  truncated?: boolean;
}

const MAX_DEFINITION_BYTES = 64 * 1024;
const MAX_EXPANSION_BYTES = 256 * 1024;
const MAX_EXPANSION_DEPTH = 24;
const MAX_SOURCE_INVOCATIONS = 8192;

function isIdentStart(char: string): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return code === 95
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122);
}

function isIdentPart(char: string): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return code === 95
    || (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122);
}

function skipQuoted(text: string, start: number): number {
  const quote = text[start]!;
  let i = start + 1;
  while (i < text.length) {
    const char = text[i]!;
    if (char === '\\') {
      i += 2;
      continue;
    }
    i++;
    if (char === quote) break;
  }
  return i;
}

function skipLineComment(text: string, start: number): number {
  const newline = text.indexOf('\n', start + 2);
  return newline < 0 ? text.length : newline;
}

function skipBlockComment(text: string, start: number): number {
  const end = text.indexOf('*/', start + 2);
  return end < 0 ? text.length : end + 2;
}

function directiveEnd(source: string, hash: number): number {
  let i = hash;
  while (i < source.length) {
    const newline = source.indexOf('\n', i);
    if (newline < 0) return source.length;
    let k = newline - 1;
    if (k >= 0 && source[k] === '\r') k--;
    if (k >= hash && source[k] === '\\') {
      i = newline + 1;
      continue;
    }
    return newline;
  }
  return source.length;
}

function splitArguments(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    if (char === '"' || char === "'") {
      i = skipQuoted(text, i);
      continue;
    }
    if (char === '/' && text[i + 1] === '/') {
      i = skipLineComment(text, i);
      continue;
    }
    if (char === '/' && text[i + 1] === '*') {
      i = skipBlockComment(text, i);
      continue;
    }
    if (char === '(') paren++;
    else if (char === ')') paren = Math.max(0, paren - 1);
    else if (char === '[') bracket++;
    else if (char === ']') bracket = Math.max(0, bracket - 1);
    else if (char === '{') brace++;
    else if (char === '}') brace = Math.max(0, brace - 1);
    else if (char === ',' && paren === 0 && bracket === 0 && brace === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
    i++;
  }
  const tail = text.slice(start).trim();
  if (tail || text.trim()) out.push(tail);
  return out;
}

function parseDefinition(source: string, hash: number, end: number): CppMacroDefinition | null {
  let text = source.slice(hash, end).replace(/\\\r?\n/g, ' ');
  text = text.replace(/^\s*#\s*define\s+/, '');
  let i = 0;
  if (!isIdentStart(text[i] ?? '')) return null;
  i++;
  while (i < text.length && isIdentPart(text[i]!)) i++;
  const name = text.slice(0, i);
  let parameters: string[] | null = null;
  let variadicParameter: string | undefined;

  // C/C++ function-like macros require `(` immediately after the name.
  if (text[i] === '(') {
    const open = i;
    let depth = 1;
    i++;
    while (i < text.length && depth > 0) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
      i++;
    }
    if (depth !== 0) return null;
    const raw = text.slice(open + 1, i - 1);
    const segments = splitArguments(raw);
    parameters = [];
    for (const segment of segments) {
      const value = segment.trim();
      if (!value) continue;
      if (value === '...') {
        variadicParameter = '__VA_ARGS__';
        parameters.push('__VA_ARGS__');
        continue;
      }
      const gnuVariadic = value.match(/^([A-Za-z_]\w*)\s*\.\.\.$/);
      if (gnuVariadic) {
        variadicParameter = gnuVariadic[1]!;
        parameters.push(gnuVariadic[1]!);
        continue;
      }
      const formal = value.match(/^([A-Za-z_]\w*)$/)?.[1];
      if (!formal) return null;
      parameters.push(formal);
    }
  }

  const replacement = text.slice(i).trim();
  if (replacement.length > MAX_DEFINITION_BYTES) return null;
  return { name, parameters, variadicParameter, replacement, start: hash, end };
}

/** Scan all ordinary `#define` directives in one C/C++ source file. */
export function scanCppMacroDefinitions(source: string): CppMacroDefinition[] {
  // Most translation units consume macros but do not define any. Let the
  // native regexp engine reject those files before the JS line-by-line scan.
  // This accepts the same whitespace between `#` and `define` as the parser
  // below; false positives in comments merely fall through to the exact scan.
  if (!/#\s*define\b/.test(source)) return [];

  const definitions: CppMacroDefinition[] = [];
  let offset = 0;
  while (offset < source.length) {
    const newline = source.indexOf('\n', offset);
    const lineEnd = newline < 0 ? source.length : newline;
    let first = offset;
    while (first < lineEnd && (source[first] === ' ' || source[first] === '\t' || source[first] === '\r')) first++;
    if (source[first] === '#') {
      const end = directiveEnd(source, first);
      const header = source.slice(first, Math.min(end, first + 128));
      if (/^#\s*define\b/.test(header)) {
        const parsed = parseDefinition(source, first, end);
        if (parsed) definitions.push(parsed);
      }
      offset = end < source.length ? end + 1 : end;
      continue;
    }
    offset = newline < 0 ? source.length : newline + 1;
  }
  return definitions;
}

function definitionKey(definition: CppMacroDefinition): string {
  return JSON.stringify([
    definition.parameters,
    definition.variadicParameter ?? null,
    definition.replacement.replace(/\s+/g, ' ').trim(),
  ]);
}

/**
 * Keep only project-wide definitions whose spelling is unambiguous. Multiple
 * identical definitions are harmless; conflicting platform/config variants
 * are omitted and may still be recovered by a same-file definition.
 */
export function selectUnambiguousCppMacroDefinitions(
  definitions: Iterable<CppMacroDefinition>,
): CppMacroDefinition[] {
  const byName = new Map<string, Map<string, CppMacroDefinition>>();
  for (const definition of definitions) {
    let variants = byName.get(definition.name);
    if (!variants) {
      variants = new Map();
      byName.set(definition.name, variants);
    }
    variants.set(definitionKey(definition), {
      name: definition.name,
      parameters: definition.parameters,
      variadicParameter: definition.variadicParameter,
      replacement: definition.replacement,
    });
  }
  const result: CppMacroDefinition[] = [];
  for (const variants of byName.values()) {
    if (variants.size === 1) result.push(variants.values().next().value!);
  }
  return result;
}

interface ParsedInvocation {
  args: string[];
  end: number;
}

interface MacroLookup {
  get(name: string): CppMacroDefinition | undefined;
}

interface MacroDefinitionIndex {
  definitions: Map<string, CppMacroDefinition>;
  /** C/C++ identifiers recognized by this module are ASCII. */
  initialCharacters: Uint8Array;
}

const definitionIndexCache = new WeakMap<readonly CppMacroDefinition[], MacroDefinitionIndex>();

function definitionIndex(
  definitions: readonly CppMacroDefinition[],
): MacroDefinitionIndex {
  const cached = definitionIndexCache.get(definitions);
  if (cached) return cached;
  const byName = new Map(definitions.map(definition => [definition.name, definition]));
  const initialCharacters = new Uint8Array(128);
  for (const name of byName.keys()) initialCharacters[name.charCodeAt(0)] = 1;
  const index = { definitions: byName, initialCharacters };
  definitionIndexCache.set(definitions, index);
  return index;
}

function parseInvocation(text: string, open: number): ParsedInvocation | null {
  if (text[open] !== '(') return null;
  let i = open + 1;
  let depth = 1;
  let start = i;
  const args: string[] = [];
  while (i < text.length) {
    const char = text[i]!;
    if (char === '"' || char === "'") {
      i = skipQuoted(text, i);
      continue;
    }
    if (char === '/' && text[i + 1] === '/') {
      i = skipLineComment(text, i);
      continue;
    }
    if (char === '/' && text[i + 1] === '*') {
      i = skipBlockComment(text, i);
      continue;
    }
    if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth === 0) {
        const tail = text.slice(start, i).trim();
        if (tail || args.length > 0) args.push(tail);
        return { args, end: i + 1 };
      }
    } else if (char === ',' && depth === 1) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
    i++;
  }
  return null;
}

function escapeForStringification(value: string): string {
  return value.trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s+/g, ' ');
}

function replaceFormal(text: string, formal: string, value: string): string {
  const escaped = formal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`\\b${escaped}\\b`, 'g'), value);
}

const uncommentedReplacements = new WeakMap<CppMacroDefinition, { raw: string; text: string }>();

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}

function skipPreprocessingNumber(text: string, start: number): number {
  if (!isDigit(text[start]) && !(text[start] === '.' && isDigit(text[start + 1]))) return start;
  let end = start + 1;
  while (end < text.length) {
    const next = text[end]!;
    if (isIdentPart(next) || next === '.' || next === "'" && isIdentPart(text[end + 1] ?? '')) end++;
    else if ((next === '+' || next === '-') && /[eEpP]/.test(text[end - 1]!)) end++;
    else break;
  }
  return end;
}

function applyArguments(
  definition: CppMacroDefinition,
  args: string[],
  expandedArgs: string[] = args,
): string | null {
  let replacement = definition.replacement;
  if (replacement.includes('//')) {
    const cached = uncommentedReplacements.get(definition);
    if (cached?.raw === replacement) replacement = cached.text;
    else {
      const text = eraseLineComments(replacement);
      uncommentedReplacements.set(definition, { raw: replacement, text });
      replacement = text;
    }
  }
  // Comments belong to the definition, not the outer invocation receiving
  // its tokens. Otherwise `#define ALIAS value // note` consumes the rest of
  // a containing declaration when substituted into a larger macro.
  if (definition.parameters === null) return replacement;
  const parameters = definition.parameters;
  const variadicIndex = definition.variadicParameter
    ? parameters.indexOf(definition.variadicParameter)
    : -1;
  const required = variadicIndex >= 0 ? variadicIndex : parameters.length;
  if (args.length < required) return null;

  const values = new Map<string, string>();
  const expandedValues = new Map<string, string>();
  for (let i = 0; i < parameters.length; i++) {
    const formal = parameters[i]!;
    values.set(
      formal,
      i === variadicIndex ? args.slice(i).join(', ') : (args[i] ?? ''),
    );
    expandedValues.set(
      formal,
      i === variadicIndex ? expandedArgs.slice(i).join(', ') : (expandedArgs[i] ?? ''),
    );
  }
  if (definition.variadicParameter && definition.variadicParameter !== '__VA_ARGS__') {
    values.set('__VA_ARGS__', values.get(definition.variadicParameter) ?? '');
    expandedValues.set('__VA_ARGS__', expandedValues.get(definition.variadicParameter) ?? '');
  }

  let result = replacement;
  // GNU comma swallowing: `, ##__VA_ARGS__` disappears with an empty pack.
  const variadicValue = definition.variadicParameter
    ? (values.get(definition.variadicParameter) ?? '')
    : undefined;
  if (variadicValue !== undefined) {
    result = result.replace(/,\s*##\s*__VA_ARGS__\b/g, variadicValue ? `, ${variadicValue}` : '');
  }

  // Stringification must happen before ordinary formal substitution.
  for (const [formal, value] of values) {
    const escaped = formal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(
      new RegExp(`(^|[^#])#\\s*${escaped}\\b`, 'g'),
      (_match, prefix: string) => `${prefix}"${escapeForStringification(value)}"`,
    );
  }

  // Macro arguments are expanded before ordinary substitution, but # and ##
  // consume their original token spelling. Protect paste-adjacent formals with
  // placeholders, substitute expanded values everywhere else, then restore.
  const pastePlaceholders = new Map<string, string>();
  let placeholderIndex = 0;
  for (const [formal, value] of values) {
    const escaped = formal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const makePlaceholder = (): string => {
      const placeholder = `__CODEGRAPH_PASTE_ARG_${placeholderIndex++}__`;
      pastePlaceholders.set(placeholder, value.trim());
      return placeholder;
    };
    result = result.replace(new RegExp(`\\b${escaped}\\b(?=\\s*##)`, 'g'), makePlaceholder);
    result = result.replace(
      new RegExp(`(##\\s*)\\b${escaped}\\b`, 'g'),
      (_match, prefix: string) => prefix + makePlaceholder(),
    );
  }
  for (const [formal, value] of expandedValues) result = replaceFormal(result, formal, value);
  for (const [placeholder, value] of pastePlaceholders) result = result.replaceAll(placeholder, value);

  // Token paste after substitution. The preprocessor permits only tokens on
  // each side; accepting identifier/number/operator fragments covers common
  // declaration-name generation without evaluating arbitrary expressions.
  let previous = '';
  while (previous !== result && result.includes('##')) {
    previous = result;
    result = result.replace(/([A-Za-z0-9_]+)\s*##\s*([A-Za-z0-9_]+)/g, '$1$2');
    result = result.replace(/\s*##\s*/g, '');
  }
  return result;
}

function expandText(
  text: string,
  definitions: MacroLookup,
  depth: number,
  stack: Set<string>,
): string {
  if (depth >= MAX_EXPANSION_DEPTH || text.length > MAX_EXPANSION_BYTES) return text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    if (char === '"' || char === "'") {
      const end = skipQuoted(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (char === '/' && text[i + 1] === '/') {
      const end = skipLineComment(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (char === '/' && text[i + 1] === '*') {
      const end = skipBlockComment(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    // A preprocessing number is one token, including identifier suffixes.
    // In `123suffix` the suffix must not be expanded as a macro before a
    // surrounding declaration macro pastes/stringifies the complete token.
    const numberEnd = skipPreprocessingNumber(text, i);
    if (numberEnd > i) {
      out += text.slice(i, numberEnd);
      i = numberEnd;
      continue;
    }
    if (!isIdentStart(char)) {
      out += char;
      i++;
      continue;
    }
    const start = i++;
    while (i < text.length && isIdentPart(text[i]!)) i++;
    const name = text.slice(start, i);
    const definition = definitions.get(name);
    if (!definition || stack.has(name)) {
      out += name;
      continue;
    }
    let args: string[] = [];
    let end = i;
    if (definition.parameters !== null) {
      let open = i;
      while (open < text.length && /[ \t\r\n]/.test(text[open]!)) open++;
      const invocation = parseInvocation(text, open);
      if (!invocation) {
        out += name;
        continue;
      }
      args = invocation.args;
      end = invocation.end;
    }
    const argStack = new Set(stack);
    argStack.add(name);
    const expandedArgs = args.map(arg => expandText(arg, definitions, depth + 1, argStack));
    const applied = applyArguments(definition, args, expandedArgs);
    if (applied === null) {
      out += text.slice(start, end);
      i = end;
      continue;
    }
    const nextStack = new Set(stack);
    nextStack.add(name);
    out += expandText(applied, definitions, depth + 1, nextStack);
    i = end;
    if (out.length > MAX_EXPANSION_BYTES) return out.slice(0, MAX_EXPANSION_BYTES);
  }
  return out;
}

function looksLikeDeclaration(expansion: string): boolean {
  const text = expansion.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const trimmed = text.trim();
  if (/^(?:do|if|for|while|switch|return|break|continue|goto|throw)\b/.test(trimmed)) {
    return false;
  }
  if (/\b(?:class|struct|union|enum|typedef|namespace)\b/.test(text)) return true;
  if (/\b(?:public|private|protected)\s*:/.test(text)) return true;
  // Split definition macros commonly expand only the callable signature; the
  // following `{ ... }` is written at the invocation site. Requiring `;` loses
  // these otherwise ordinary out-of-line C++ function definitions.
  if (/^(?:\s*template\s*<[^;{}]+>\s*)?(?:[\w:<>]+\s+|[*&]\s*)+[~\w:<>]+\s*\([^;{}]*\)\s*(?:(?:const|noexcept|override|final)\s*)*$/s.test(trimmed)) {
    return true;
  }
  // At namespace/class scope a semicolon in an expanded macro represents a
  // declaration (functions, fields, variables, static_assert, or aliases).
  return text.includes(';');
}

function isStructuralExpansion(expansion: string): boolean {
  return /^[\s{};:]+$/.test(expansion) && /[{}]/.test(expansion);
}

/** Prevent a macro-body `//` comment from swallowing later declarations when collapsed. */
function eraseLineComments(text: string): string {
  let output = '';
  for (let i = 0; i < text.length;) {
    const char = text[i]!;
    if (char === '"' || char === "'") {
      const end = skipQuoted(text, i);
      output += text.slice(i, end);
      i = end;
    } else if (char === '/' && text[i + 1] === '/') {
      const end = skipLineComment(text, i);
      output += ' '.repeat(end - i);
      i = end;
    } else {
      output += char;
      i++;
    }
  }
  return output;
}

function isDirectiveStart(source: string, offset: number): boolean {
  let lineStart = offset;
  while (lineStart > 0 && source[lineStart - 1] !== '\n') lineStart--;
  for (let i = lineStart; i < offset; i++) {
    if (source[i] !== ' ' && source[i] !== '\t' && source[i] !== '\r') return false;
  }
  return source[offset] === '#';
}

function definitionForOffset(
  name: string,
  offset: number,
  globalDefinitions: Map<string, CppMacroDefinition>,
  localDefinitions: Map<string, CppMacroDefinition[]>,
): CppMacroDefinition | undefined {
  const locals = localDefinitions.get(name);
  if (locals) {
    let selected: CppMacroDefinition | undefined;
    for (const candidate of locals) {
      if ((candidate.start ?? Number.MAX_SAFE_INTEGER) >= offset) break;
      selected = candidate;
    }
    if (selected) return selected;
  }
  return globalDefinitions.get(name);
}

/**
 * Expand declaration-producing macro invocations while preserving the source's
 * line count. The optional predicate lets the caller reject function-body
 * statement macros using its already-parsed raw AST.
 */
export function expandDeclarationMacros(
  source: string,
  projectDefinitions: readonly CppMacroDefinition[],
  isDeclarationScope?: (line: number, column: number, candidate: DeclarationMacroCandidate) => boolean,
  isLexicallyDeclarationScope?: (line: number, column: number) => boolean,
): DeclarationMacroExpansion {
  const globalIndex = definitionIndex(projectDefinitions);
  const globalDefinitions = globalIndex.definitions;
  const localDefinitions = new Map<string, CppMacroDefinition[]>();
  for (const definition of scanCppMacroDefinitions(source)) {
    let values = localDefinitions.get(definition.name);
    if (!values) {
      values = [];
      localDefinitions.set(definition.name, values);
    }
    values.push(definition);
  }

  if (globalDefinitions.size === 0 && localDefinitions.size === 0) {
    return { source, invocationLines: new Set(), expandedMacroNames: new Set() };
  }

  // Copy the cached 128-byte table because same-file definitions add valid
  // initials for this invocation only. This exact filter skips slicing and
  // hashing ordinary identifiers whose first character cannot begin any known
  // macro; it makes no naming-style assumptions (lowercase macros still work).
  const candidateInitialCharacters = globalIndex.initialCharacters.slice();
  for (const name of localDefinitions.keys()) candidateInitialCharacters[name.charCodeAt(0)] = 1;

  // Recursive helper expansion needs a single lookup table. A same-file
  // definition is safe for helpers only when its spelling is unique in this
  // file; position-sensitive root lookup is still handled separately below.
  const localExpansionDefinitions = new Map<string, CppMacroDefinition>();
  for (const [name, values] of localDefinitions) {
    const variants = new Map(values.map(value => [definitionKey(value), value]));
    if (variants.size === 1) localExpansionDefinitions.set(name, values[0]!);
  }
  const expansionDefinitions: MacroLookup = {
    get: name => localExpansionDefinitions.get(name) ?? globalDefinitions.get(name),
  };

  const replacements: Array<{ start: number; end: number; text: string; line: number; name: string }> = [];
  const invocationLines = new Set<number>();
  const expandedMacroNames = new Set<string>();
  let invocationCount = 0;
  let line = 1;
  let lineStart = 0;
  let i = 0;
  const advanceLineState = (from: number, to: number): void => {
    for (let k = from; k < to; k++) {
      if (source[k] === '\n') {
        line++;
        lineStart = k + 1;
      }
    }
  };

  while (i < source.length && invocationCount < MAX_SOURCE_INVOCATIONS) {
    const char = source[i]!;
    if (char === '\n') {
      line++;
      lineStart = i + 1;
      i++;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = skipQuoted(source, i);
      advanceLineState(i, end);
      i = end;
      continue;
    }
    if (char === '/' && source[i + 1] === '/') {
      const end = skipLineComment(source, i);
      advanceLineState(i, end);
      i = end;
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      const end = skipBlockComment(source, i);
      advanceLineState(i, end);
      i = end;
      continue;
    }
    if (char === '#' && isDirectiveStart(source, i)) {
      const end = directiveEnd(source, i);
      advanceLineState(i, end);
      i = end;
      continue;
    }
    const numberEnd = skipPreprocessingNumber(source, i);
    if (numberEnd > i) { i = numberEnd; continue; }
    if (!isIdentStart(char)) {
      i++;
      continue;
    }

    if (candidateInitialCharacters[char.charCodeAt(0)] === 0) {
      i++;
      while (i < source.length && isIdentPart(source[i]!)) i++;
      continue;
    }

    const start = i++;
    while (i < source.length && isIdentPart(source[i]!)) i++;
    const name = source.slice(start, i);
    const definition = definitionForOffset(name, start, globalDefinitions, localDefinitions);
    if (!definition) continue;

    const column = start - lineStart;
    let args: string[] = [];
    let end = i;
    if (definition.parameters !== null) {
      let open = i;
      while (open < source.length && /[ \t\r\n]/.test(source[open]!)) open++;
      const invocation = parseInvocation(source, open);
      if (!invocation) continue;
      args = invocation.args;
      end = invocation.end;
    }

    // The lexical executable-body check depends only on the original source,
    // not on the expanded macro text. Run that exact negative predicate before
    // recursive argument/body expansion so statement macros cannot consume
    // seconds or overflow the stack merely to be rejected later. The complete
    // AST-aware declaration-scope predicate remains below after the expansion
    // has proven declaration-shaped.
    if (isLexicallyDeclarationScope && !isLexicallyDeclarationScope(line, column)) {
      advanceLineState(start, end);
      i = end;
      continue;
    }

    const expandedArgs = args.map(arg => expandText(arg, expansionDefinitions, 1, new Set([name])));
    const applied = applyArguments(definition, args, expandedArgs);
    if (applied === null) continue;
    const stack = new Set<string>([name]);
    const expanded = expandText(applied, expansionDefinitions, 1, stack);
    if (!looksLikeDeclaration(expanded) && !isStructuralExpansion(expanded)) continue;
    if (expanded.length > MAX_EXPANSION_BYTES) continue;
    // Scope classification may build lexical executable ranges and query the
    // raw AST. Delay that work until expansion has proven this invocation can
    // actually create declaration syntax. The predicate is pure, so this
    // preserves the accepted replacement set while avoiding expensive scope
    // analysis for ordinary expression/statement macros.
    if (isDeclarationScope && !isDeclarationScope(line, column, { start, end, expansion: expanded })) continue;

    const original = source.slice(start, end);
    const newlineCount = (original.match(/\n/g) ?? []).length;
    const oneLine = eraseLineComments(expanded).replace(/\r?\n/g, ' ');
    replacements.push({ start, end, text: oneLine + '\n'.repeat(newlineCount), line, name });
    invocationLines.add(line);
    expandedMacroNames.add(name);
    invocationCount++;
    advanceLineState(start, end);
    i = end;
  }

  if (replacements.length === 0) {
    return { source, invocationLines, expandedMacroNames };
  }
  // Replacements are collected in strictly increasing, non-overlapping source
  // order because the scanner advances to each invocation's end. Assemble the
  // result once instead of copying the full translation unit for every macro
  // (O(source + output), rather than O(replacements * source)).
  const chunks: string[] = [];
  let cursor = 0;
  for (const replacement of replacements) {
    chunks.push(source.slice(cursor, replacement.start), replacement.text);
    cursor = replacement.end;
  }
  chunks.push(source.slice(cursor));
  const truncated = i < source.length && /\S/.test(source.slice(i));
  return { source: chunks.join(''), invocationLines, expandedMacroNames, ...(truncated ? { truncated } : {}) };
}
