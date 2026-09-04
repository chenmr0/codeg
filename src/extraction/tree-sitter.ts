/**
 * Tree-sitter Parser Wrapper
 *
 * Handles parsing source code and extracting structural information.
 */

import { Node as SyntaxNode, Tree, Parser as WasmParser } from 'web-tree-sitter';
import * as path from 'path';
import {
  Language,
  Node,
  Edge,
  NodeKind,
  ExtractionResult,
  ExtractionTimings,
  ExtractionError,
  UnresolvedReference,
} from '../types';
import { createParser, getParser, detectLanguage, isLanguageSupported, isFileLevelOnlyLanguage, maskCStyleCommentsAndLiterals } from './grammars';
import { generateNodeId, getNodeText, getChildByField, getPrecedingDocstring } from './tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from './tree-sitter-types';
import { EXTRACTORS } from './languages';
import { LiquidExtractor } from './liquid-extractor';
import { RazorExtractor } from './razor-extractor';
import { SvelteExtractor } from './svelte-extractor';
import { DfmExtractor } from './dfm-extractor';
import { VueExtractor } from './vue-extractor';
import { MyBatisExtractor } from './mybatis-extractor';
import {
  detectXMacroConstructs,
  xmacroSupported,
  type XMacroConstruct,
} from './xmacro';
import {
  getAllFrameworkResolvers,
  getApplicableFrameworks,
} from '../resolution/frameworks';
import {
  expandDeclarationMacros,
  type CppMacroDefinition,
} from './declaration-macros';
import { isWasmRuntimeCorruptionError } from './wasm-errors';

// Re-export for backward compatibility
export { generateNodeId } from './tree-sitter-helpers';

interface CppDeclaredTypeName {
  name: string;
  qualifiedName?: string;
}

/** Resolve `class/struct/union/enum Outer::Inner` without treating it as anonymous. */
function getCppDeclaredTypeName(node: SyntaxNode, source: string): CppDeclaredTypeName | null {
  if (node.type !== 'class_specifier' && node.type !== 'struct_specifier'
    && node.type !== 'union_specifier' && node.type !== 'enum_specifier') {
    return null;
  }
  const nameNode = getChildByField(node, 'name')
    ?? node.namedChildren.find((child) =>
      child.type === 'qualified_identifier' || child.type === 'type_identifier' || child.type === 'identifier');
  if (!nameNode) return null;
  const raw = getNodeText(nameNode, source).trim().replace(/^::/, '');
  if (!raw) return null;
  if (nameNode.type !== 'qualified_identifier' && !raw.includes('::')) {
    return { name: raw };
  }
  const parts = raw.split('::').map((part) => part.trim()).filter(Boolean);
  const tail = parts[parts.length - 1];
  return tail ? { name: tail, qualifiedName: parts.join('::') } : null;
}

/**
 * Extract the name from a node based on language
 */
function extractName(node: SyntaxNode, source: string, extractor: LanguageExtractor): string {
  const hookName = extractor.resolveName?.(node, source);
  if (hookName) return hookName;

  const cppTypeName = getCppDeclaredTypeName(node, source);
  if (cppTypeName) return cppTypeName.name;

  // Try field name first
  const nameNode = getChildByField(node, extractor.nameField);
  if (nameNode) {
    // Unwrap pointer_declarator / reference_declarator(s) for C/C++ pointer /
    // reference return types. Without unwrapping `reference_declarator`, a
    // reference-return function (`T& get_instance()`) is named `& get_instance()`
    // — the `&` and trailing `()` stay in the declarator text, so calls never
    // resolve by name. Covers `&`, `&&`, and `*&` chains (loop keeps unwrapping).
    let resolved = nameNode;
    while (resolved.type === 'pointer_declarator' || resolved.type === 'reference_declarator') {
      const inner = getChildByField(resolved, 'declarator') || resolved.namedChild(0);
      if (!inner) break;
      resolved = inner;
    }
    // Handle complex declarators (C/C++)
    if (resolved.type === 'function_declarator' || resolved.type === 'declarator') {
      const innerName = getChildByField(resolved, 'declarator') || resolved.namedChild(0);
      if (innerName) {
        // Unwrap parenthesized_declarator: int (foo)(int) → foo, and the
        // function-pointer typedef/field form `T (*foo)(int)` whose
        // parenthesized_declarator wraps a pointer_declarator — keep unwrapping
        // pointer/reference declarators so we return `foo`, not `*foo` (without
        // this, `typedef VOS_BOOL (*FnPtr)(void)` and struct fields
        // `VOS_UINT32 (*cb)(void)` are named `*FnPtr` / `(*cb)`, which exact-name
        // query never matches).
        if (innerName.type === 'parenthesized_declarator') {
          let innermost = getChildByField(innerName, 'declarator') || innerName.namedChild(0);
          while (innermost && (innermost.type === 'pointer_declarator' || innermost.type === 'reference_declarator')) {
            const inner = getChildByField(innermost, 'declarator') || innermost.namedChild(0);
            if (!inner) break;
            innermost = inner;
          }
          return innermost ? getNodeText(innermost, source) : getNodeText(innerName, source);
        }
        return getNodeText(innerName, source);
      }
      return getNodeText(resolved, source);
    }
    // When a function_definition's declarator is a bare parenthesized_declarator
    // (no nested function_declarator), tree-sitter has misparsed due to
    // unrecognized macros appearing before the function name.  The actual name
    // is in the type field, not the declarator.
    // e.g.  RRE_ATTRIBUTE_VISIBILITY VOS_UINT32 realFuncName(VOS_VOID) { }
    if (resolved.type === 'parenthesized_declarator' && node.type === 'function_definition') {
      const typeNode = getChildByField(node, 'type');
      if (typeNode) return getNodeText(typeNode, source);
    }
    // Lua: `function t.f()` / `function t:m()` — the name node is a dot/method
    // index expression; the simple name is the trailing field/method (the table
    // receiver is captured separately via getReceiverType).
    if (resolved.type === 'dot_index_expression') {
      const field = getChildByField(resolved, 'field');
      if (field) return getNodeText(field, source);
    }
    if (resolved.type === 'method_index_expression') {
      const method = getChildByField(resolved, 'method');
      if (method) return getNodeText(method, source);
    }
    return getNodeText(resolved, source);
  }

  // For Dart method_signature, look inside inner signature types
  if (node.type === 'method_signature') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && (
        child.type === 'function_signature' ||
        child.type === 'getter_signature' ||
        child.type === 'setter_signature' ||
        child.type === 'constructor_signature' ||
        child.type === 'factory_constructor_signature'
      )) {
        // Find identifier inside the inner signature
        for (let j = 0; j < child.namedChildCount; j++) {
          const inner = child.namedChild(j);
          if (inner?.type === 'identifier') {
            return getNodeText(inner, source);
          }
        }
      }
    }
  }

  // Arrow/function expressions get their name from the parent variable_declarator,
  // not from identifiers in their body. Without this, single-expression arrow
  // functions like `const fn = () => someIdentifier` get named "someIdentifier"
  // instead of "fn", because the fallback below finds the body identifier.
  if (node.type === 'arrow_function' || node.type === 'function_expression') {
    return '<anonymous>';
  }

  // Fall back to first identifier child
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (
      child &&
      (child.type === 'identifier' ||
        child.type === 'type_identifier' ||
        child.type === 'simple_identifier' ||
        child.type === 'constant')
    ) {
      return getNodeText(child, source);
    }
  }

  return '<anonymous>';
}

/**
 * Resolve a Scala type node to its base type NAME for name-matching — unwrapping
 * `generic_type` (`Monoid[Int]` → `Monoid`), taking the last segment of a
 * qualified `stable_type_identifier` (`cats.Functor` → `Functor`), and falling
 * back to a descendant `type_identifier`. Returns null for non-type nodes.
 * Shared by Scala inheritance and type-reference extraction.
 */
function scalaBaseTypeName(node: SyntaxNode | null, source: string): string | null {
  if (!node) return null;
  switch (node.type) {
    case 'type_identifier':
    case 'identifier':
      return getNodeText(node, source);
    case 'generic_type':
      // `<base> type_arguments` — the base type is the first named child.
      return scalaBaseTypeName(node.namedChild(0), source);
    case 'stable_type_identifier':
    case 'stable_identifier': {
      // Qualified `a.b.C` — match on the simple (last) segment.
      const ids = node.namedChildren.filter(
        (c: SyntaxNode) => c.type === 'type_identifier' || c.type === 'identifier'
      );
      const last = ids[ids.length - 1];
      return last ? getNodeText(last, source) : null;
    }
    default: {
      const id = node.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
      return id ? getNodeText(id, source) : null;
    }
  }
}

/**
 * PHP type-position wrapper node kinds (a type-hint is `named_type`,
 * `?Foo` is `optional_type`, `A|B` is `union_type`, `A&B` is
 * `intersection_type`). Used to find the type subtree inside a parameter /
 * property / return position before walking it for class references.
 */
const PHP_TYPE_NODES: ReadonlySet<string> = new Set([
  'named_type', 'optional_type', 'nullable_type',
  'union_type', 'intersection_type', 'disjunctive_normal_form_type',
  'primitive_type',
]);

/**
 * Member-access node kinds whose receiver, when it's a capitalized
 * type/enum/class name, is a real dependency — `Enum.value`, `Type.CONST`,
 * `Foo::BAR`. These VALUE reads (as opposed to `Type.method()` calls, already
 * handled) produced no edge, so a type used only via a static member or enum
 * value looked like nothing depended on it. See {@link extractStaticMemberRef}.
 */
const MEMBER_ACCESS_TYPES: ReadonlySet<string> = new Set([
  'field_access',                       // java (`Foo.BAR`)
  'member_access_expression',           // c#  (`Foo.Bar`)
  'navigation_expression',              // kotlin / swift (`Foo.bar`)
  'field_expression',                   // scala (`Foo.bar`)
  'class_constant_access_expression',   // php (`Foo::CONST`, `Foo::class`)
  'scoped_property_access_expression',  // php (`Foo::$bar`)
  'qualified_identifier',               // c++ (`Foo::bar`)
]);

/**
 * Languages whose types are Capitalized by convention, so a capitalized
 * member-access receiver is reliably a type (not a local/variable). The
 * static-member/value-read pass is gated to these — the ones where it was the
 * confirmed residual frontier (enum-value / static-field reads). TS/JS/Python
 * are deliberately excluded, and a measured A/B confirms the call: extending the
 * pass to them adds ZERO coverage — in import-based languages you must `import` a
 * type before any `Type.MEMBER` read, so the import edge already covers it (the
 * static read is pure duplication) — while adding real graph noise (+1813 edges /
 * +2448 `references` on excalidraw, the retrieval-perf benchmark, all pointing at
 * already-covered types). Don't re-add `member_expression`/`attribute` here.
 */
const STATIC_MEMBER_LANGS: ReadonlySet<string> = new Set([
  'java', 'csharp', 'kotlin', 'swift', 'scala', 'dart', 'php', 'cpp',
]);

/**
 * Tree-sitter node kinds that represent constructor invocations
 * (`new Foo()` and friends). Used by extractInstantiation to emit
 * an `instantiates` reference targeting the class name.
 */
const INSTANTIATION_KINDS: ReadonlySet<string> = new Set([
  'new_expression',                  // typescript / javascript / tsx / jsx
  'object_creation_expression',      // java / c#
  'instance_creation_expression',    // some grammars
  'composite_literal',               // go — `Widget{...}` / `pkga.Widget{...}`
  'struct_expression',               // rust — `Widget { n: 1 }` / `m::Widget { .. }`
  'instance_expression',             // scala — `new Monoid[Int] { ... }`
]);

/**
 * Node types whose presence among a C/C++ function body's direct named
 * children indicates tree-sitter has misparsed the compound_statement
 * boundary due to preprocessor directives inside the function. These
 * are top-level constructs that should not appear as statements inside
 * a valid C/C++ compound_statement.
 *
 * Note: `type_definition` is intentionally EXCLUDED. Unlike struct/enum/class
 * specifiers (which tree-sitter wraps in a `declaration` node at statement
 * scope), a `typedef` statement always produces a bare `type_definition`
 * node as a direct child of the compound_statement. Local typedefs are
 * legitimate C/C++ code, so including `type_definition` here causes body
 * leak detection to over-fire on every local typedef, incorrectly treating
 * it and all subsequent content as file-level globals.
 */
const C_CPP_BODY_LEAK_TYPES: ReadonlySet<string> = new Set([
  'function_definition',
  'class_specifier',
  'struct_specifier',
  'enum_specifier',
]);

/** C/C++ keywords that tree-sitter occasionally misparses as variable
 *  declarator names (e.g. `if` from `else if (MACRO(...))` when preprocessor
 *  macros confuse the grammar into error recovery). These are reserved words
 *  that can never be valid variable names, so filtering them is safe. */
const C_CPP_KEYWORD_NAMES: ReadonlySet<string> = new Set([
  'if', 'else', 'switch', 'case', 'default',
  'for', 'while', 'do', 'break', 'continue', 'goto',
  'return', 'try', 'catch', 'throw',
  'new', 'delete',
  // Declaration/type keywords. Besides filtering error-recovery artifacts,
  // this list is used to keep project-wide macro discovery from poisoning
  // valid C++ tokens such as `final` and `override` during pre-parse.
  'class', 'struct', 'union', 'enum', 'namespace', 'template', 'typename',
  'typedef', 'using', 'public', 'protected', 'private', 'virtual', 'friend',
  'final', 'override', 'noexcept', 'constexpr', 'consteval', 'constinit',
  'const', 'volatile', 'mutable', 'inline', 'static', 'extern', 'thread_local',
  'auto', 'decltype', 'operator', 'explicit', 'export', 'requires', 'concept',
  'true', 'false', 'nullptr', 'this',
  // Type keywords that tree-sitter-c may expose as field_identifier
  // inside misparsed field_declaration / function_declarator nodes.
  // These are never valid function names.
  'void', 'char', 'int', 'short', 'long', 'float', 'double',
  'signed', 'unsigned', 'size_t', 'ssize_t',
]);

/**
 * Node kinds that may carry generic type parameters. `createNode` invokes the
 * language's optional `getTypeParameters` hook only for these declaration
 * kinds, so fields/variables/enum-members/imports are never asked (and
 * languages without the hook — i.e. everything but C++ — are untouched).
 * Includes interface/trait for completeness even though C++ has neither.
 */
const TYPE_PARAMETER_KINDS: ReadonlySet<NodeKind> = new Set([
  'function', 'method', 'class', 'struct', 'interface', 'trait', 'enum', 'type_alias',
]);

interface ParseDamage {
  errorCount: number;
  missingCount: number;
  macroArtifactCount: number;
  totalErrorSpan: number;
  largestErrorSpan: number;
  score: number;
}

interface SourceRange {
  start: number;
  end: number;
}

/** Find the narrow silent misparse produced by `SWITCH(x)\nnext_call()`. */
function findStatementMacroArtifacts(
  root: SyntaxNode,
  macroNames?: Set<string> | null,
): SyntaxNode[] {
  if (!macroNames || macroNames.size === 0) return [];

  const artifacts: SyntaxNode[] = [];
  for (const macroType of root.descendantsOfType('macro_type_specifier')) {
    const nameNode = macroType.childForFieldName('name');
    if (!nameNode || !macroNames.has(nameNode.text)) continue;

    let declaration = macroType.parent;
    while (
      declaration &&
      declaration.type !== 'declaration' &&
      declaration.type !== 'field_declaration' &&
      declaration.type !== 'translation_unit' &&
      declaration.type !== 'compound_statement'
    ) {
      declaration = declaration.parent;
    }
    if (!declaration || declaration.type !== 'declaration') continue;

    // The hallmark of the silent SWITCH(x) misparse is that the macro type on
    // one line absorbs the next line's `bar()` as a function declarator. A real
    // macro type declaration normally keeps its declarator on the same line;
    // requiring both the line break and function_declarator keeps this signal
    // narrow and avoids treating ordinary macro-based variable types as damage.
    if (declaration.endPosition.row <= macroType.endPosition.row) continue;
    if (declaration.descendantsOfType('function_declarator').length === 0) continue;

    let parent = declaration.parent;
    let insideCompound = false;
    while (parent && parent.type !== 'translation_unit') {
      if (parent.type === 'compound_statement') {
        insideCompound = true;
        break;
      }
      parent = parent.parent;
    }
    if (insideCompound) artifacts.push(declaration);
  }
  return artifacts;
}

/**
 * Quantify tree-sitter recovery damage. ERROR byte span is weighted most
 * heavily because one giant recovery node swallowing a function/file is much
 * worse for extraction than a tiny missing token. Counts keep several small
 * errors from looking free. Zero means a structurally clean parse.
 */
function measureParseDamage(
  root: SyntaxNode,
  macroNames?: Set<string> | null,
): ParseDamage {
  const macroArtifacts = findStatementMacroArtifacts(root, macroNames);
  if (!root.hasError && macroArtifacts.length === 0) {
    return {
      errorCount: 0,
      missingCount: 0,
      macroArtifactCount: 0,
      totalErrorSpan: 0,
      largestErrorSpan: 0,
      score: 0,
    };
  }

  let errorCount = 0;
  let missingCount = 0;
  let totalErrorSpan = 0;
  let largestErrorSpan = 0;
  if (root.hasError) {
    const stack: SyntaxNode[] = [root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.isError) {
        errorCount++;
        const span = Math.max(1, node.endIndex - node.startIndex);
        totalErrorSpan += span;
        if (span > largestErrorSpan) largestErrorSpan = span;
      }
      if (node.isMissing) missingCount++;
      if (!node.hasError && !node.isError && !node.isMissing) continue;
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) stack.push(child);
      }
    }
  }

  const macroArtifactSpan = macroArtifacts.reduce(
    (sum, node) => sum + Math.max(1, node.endIndex - node.startIndex),
    0,
  );

  return {
    errorCount,
    missingCount,
    macroArtifactCount: macroArtifacts.length,
    totalErrorSpan,
    largestErrorSpan,
    score:
      largestErrorSpan * 8 +
      totalErrorSpan * 4 +
      errorCount * 64 +
      missingCount * 32 +
      macroArtifacts.length * 128 +
      macroArtifactSpan * 2,
  };
}

/** Return true only for a material, measurable parser-recovery improvement. */
function isParseDamageBetter(candidate: ParseDamage, original: ParseDamage): boolean {
  return candidate.score < original.score;
}

/**
 * Capture named class/struct/enum definitions that the raw parser still
 * recognized. A recovery retry is allowed to add definitions, but never to
 * erase one that was already structurally present: ERROR-count improvement is
 * not useful when the new tree folds a real type into a giant bogus function.
 * Offsets are stable because every preParse transform is byte preserving.
 */
function collectNamedTypeDefinitionAnchors(
  root: SyntaxNode,
  extractor: LanguageExtractor,
): Set<string> {
  const typeContainerTypes = new Set([
    ...extractor.classTypes,
    ...extractor.structTypes,
    ...extractor.enumTypes,
  ]);
  const anchors = new Set<string>();
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (typeContainerTypes.has(node.type)) {
      const name = node.childForFieldName('name');
      const body = node.childForFieldName(extractor.bodyField);
      if (name && body) {
        anchors.add(`${node.type}:${name.startIndex}:${name.endIndex}:${name.text}`);
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
  }
  return anchors;
}

function preservesNamedTypeDefinitions(
  candidate: SyntaxNode,
  original: SyntaxNode,
  extractor: LanguageExtractor,
): boolean {
  const originalAnchors = collectNamedTypeDefinitionAnchors(original, extractor);
  if (originalAnchors.size === 0) return true;
  const candidateAnchors = collectNamedTypeDefinitionAnchors(candidate, extractor);
  for (const anchor of originalAnchors) {
    if (!candidateAnchors.has(anchor)) return false;
  }
  return true;
}

/** Expand a bare ERROR range by two source lines for root-level recovery. */
function expandRangeByLines(source: string, start: number, end: number, lineCount: number): SourceRange {
  let expandedStart = Math.max(0, start);
  let expandedEnd = Math.min(source.length, Math.max(end, start + 1));
  for (let i = 0; i < lineCount; i++) {
    const previousNewline = source.lastIndexOf('\n', Math.max(0, expandedStart - 2));
    expandedStart = previousNewline === -1 ? 0 : previousNewline + 1;
    const nextNewline = source.indexOf('\n', expandedEnd);
    expandedEnd = nextNewline === -1 ? source.length : nextNewline + 1;
  }
  return { start: expandedStart, end: expandedEnd };
}

/** Match clang tooling's symbol spelling for callable template-ids/operators. */
function normalizeCppConversionType(type: string): string {
  return type
    .trim()
    .replace(/\s*::\s*/g, '::')
    .replace(/\s*([*&]+)\s*/g, '$1')
    .replace(/\s+/g, ' ');
}

function normalizeCppCallableName(name: string, receiverType?: string): string {
  const trimmedName = name.trim();
  const templateId = trimmedName.match(/^(~?[A-Za-z_]\w*)\s*<[\s\S]+>$/);
  if (templateId && receiverType) {
    const receiverTail = receiverType.split('::').pop()?.trim() ?? '';
    const receiverBase = receiverTail.replace(/<[^<>]*>\s*$/, '');
    if (receiverBase === templateId[1]!.replace(/^~/, '')) return templateId[1]!;
  }
  const conversionOperator = trimmedName.match(/^operator\s+([A-Za-z_:][\s\S]*)$/);
  if (conversionOperator) {
    return `operator ${normalizeCppConversionType(conversionOperator[1]!)}`;
  }
  // Only symbolic operators are compacted. Conversion operators (`operator
  // const char *`) retain their meaningful type whitespace.
  const symbolicOperator = trimmedName.match(/^operator\s*([^\w\s][\s\S]*)$/);
  return symbolicOperator ? `operator${symbolicOperator[1]!.replace(/\s+/g, '')}` : trimmedName;
}

interface SourceSpelledCppCallable {
  prefix: string;
  receiverType: string;
  name: string;
  qualifiedName: string;
}

function cppTopLevelScopeSeparators(value: string): number[] {
  const separators: number[] = [];
  let angleDepth = 0;
  for (let i = 0; i + 1 < value.length; i++) {
    const char = value[i]!;
    if (char === '<') {
      angleDepth++;
    } else if (char === '>' && angleDepth > 0) {
      angleDepth--;
    } else if (angleDepth === 0 && char === ':' && value[i + 1] === ':') {
      separators.push(i);
      i++;
    }
  }
  return separators;
}

function cppScopeSegmentStart(value: string, endInclusive: number): number {
  let cursor = endInclusive;
  while (cursor >= 0 && /\s/.test(value[cursor]!)) cursor--;
  if (cursor < 0) return -1;

  if (value[cursor] === '>') {
    let depth = 1;
    cursor--;
    while (cursor >= 0 && depth > 0) {
      if (value[cursor] === '>') depth++;
      else if (value[cursor] === '<') depth--;
      cursor--;
    }
    if (depth !== 0) return -1;
    while (cursor >= 0 && /\s/.test(value[cursor]!)) cursor--;
  }

  const identifierEnd = cursor;
  while (cursor >= 0 && /[A-Za-z0-9_]/.test(value[cursor]!)) cursor--;
  return cursor === identifierEnd ? -1 : cursor + 1;
}

function cppReceiverStart(value: string, receiverEnd: number): number {
  let cursor = receiverEnd - 1;
  let start = cppScopeSegmentStart(value, cursor);
  if (start < 0) return -1;

  while (start > 0) {
    cursor = start - 1;
    while (cursor >= 0 && /\s/.test(value[cursor]!)) cursor--;
    if (cursor < 1 || value[cursor] !== ':' || value[cursor - 1] !== ':') break;
    cursor -= 2;
    const previous = cppScopeSegmentStart(value, cursor);
    if (previous < 0) break;
    start = previous;
  }
  return start;
}

function cppReceiverBase(receiverType: string): string {
  const separators = cppTopLevelScopeSeparators(receiverType);
  const tail = receiverType.slice((separators.at(-1) ?? -2) + 2).trim();
  const templateStart = tail.indexOf('<');
  return (templateStart >= 0 ? tail.slice(0, templateStart) : tail).trim();
}

function isBalancedCppTemplateText(value: string): boolean {
  let depth = 0;
  for (const char of value) {
    if (char === '<') depth++;
    else if (char === '>') {
      if (depth === 0) return false;
      depth--;
    }
  }
  return depth === 0;
}

function isValidRecoveredCppCallable(receiverType: string, name: string): boolean {
  if (!receiverType || !name || !isBalancedCppTemplateText(receiverType)) return false;
  let templateDepth = 0;
  let receiverSkeleton = '';
  for (const char of receiverType) {
    if (char === '<') {
      templateDepth++;
      continue;
    }
    if (char === '>') {
      templateDepth--;
      continue;
    }
    if (templateDepth === 0) receiverSkeleton += char;
  }
  if (/\s/.test(receiverSkeleton)) return false;
  if (!/^(?:::)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/.test(receiverSkeleton)) return false;
  if (/::(?:class|struct|enum|typename)(?:::|$)/.test(receiverSkeleton)) return false;

  const trimmedName = name.trim();
  if (/^operator\s+/.test(trimmedName)) return trimmedName.length > 'operator '.length;
  if (/^operator[^A-Za-z0-9_]/.test(trimmedName)) return trimmedName.length > 'operator'.length;
  if (!/^~?[A-Za-z_]\w*(?:\s*<[\s\S]+>)?$/.test(trimmedName)) return false;
  return isBalancedCppTemplateText(trimmedName);
}

/**
 * Parse the right-most qualified callable in a source-spelled definition
 * header. Candidate discovery remains intentionally broad; this parser owns
 * identity extraction so a qualified return type can never become part of the
 * method's qualified name.
 */
function parseSourceSpelledCppCallable(header: string): SourceSpelledCppCallable | null {
  const trimmedEnd = header.trimEnd();
  const separators = cppTopLevelScopeSeparators(trimmedEnd);
  if (separators.length === 0) return null;

  const operatorSeparator = [...separators].reverse().find(separator =>
    /^\s*operator\b/.test(trimmedEnd.slice(separator + 2))
  );
  const callableSeparator = operatorSeparator ?? separators[separators.length - 1]!;
  const rawName = trimmedEnd.slice(callableSeparator + 2).trim();
  const receiverStart = cppReceiverStart(trimmedEnd, callableSeparator);
  if (receiverStart < 0) return null;

  const receiverType = trimmedEnd
    .slice(receiverStart, callableSeparator)
    .trim()
    .replace(/\s*::\s*/g, '::')
    .replace(/^::/, '');
  const name = normalizeCppCallableName(rawName, receiverType).trim();
  if (!isValidRecoveredCppCallable(receiverType, name)) return null;

  const prefix = trimmedEnd.slice(0, receiverStart).trim();
  const receiverBase = cppReceiverBase(receiverType);
  const callableBase = name.replace(/^~/, '').replace(/\s*<[\s\S]+>$/, '');
  const isCtorOrDtor = receiverBase === callableBase;
  const isConversionOperator = /^operator\s+[A-Za-z_:]/.test(name);
  if (!prefix && !isCtorOrDtor && !isConversionOperator) return null;
  if (/^(?:return|if|for|while|switch|case|throw)\b/.test(prefix)) return null;

  return {
    prefix,
    receiverType,
    name,
    qualifiedName: `${receiverType}::${name}`,
  };
}

function anonymousCppTypeName(node: SyntaxNode): string | null {
  if (getChildByField(node, 'name')) return null;
  if (node.type === 'enum_specifier') return '(anonymous enum)';
  if (node.type === 'union_specifier') return '(anonymous union)';
  if (node.type === 'struct_specifier') return '(anonymous struct)';
  return null;
}

/** Read the callable declarator without wandering into template/parameter types. */
function cppCallableDeclaratorName(node: SyntaxNode, source: string): string | null {
  const operatorCast = node.type === 'operator_cast'
    ? node
    : node.descendantsOfType('operator_cast')[0];
  if (operatorCast) {
    const conversionDeclarator = getChildByField(operatorCast, 'declarator');
    const parameters = conversionDeclarator?.descendantsOfType('parameter_list')[0];
    if (parameters) {
      const operatorText = getNodeText(operatorCast, source);
      const conversionEnd = parameters.startIndex - operatorCast.startIndex;
      const conversionType = operatorText.slice('operator'.length, conversionEnd);
      if (conversionType.trim()) {
        return `operator ${normalizeCppConversionType(conversionType)}`;
      }
    }
  }

  const fn = node.type === 'function_declarator'
    ? node
    : node.descendantsOfType('function_declarator')[0];
  if (!fn) return null;
  let declarator = getChildByField(fn, 'declarator') ?? fn.namedChild(0);
  while (declarator && (declarator.type === 'pointer_declarator'
    || declarator.type === 'reference_declarator'
    || declarator.type === 'parenthesized_declarator')) {
    declarator = getChildByField(declarator, 'declarator') ?? declarator.namedChild(0);
  }
  if (!declarator) return null;
  const raw = getNodeText(declarator, source).trim().replace(/\s*::\s*/g, '::');
  if (!raw) return null;
  const operatorScope = raw.lastIndexOf('::operator');
  if (operatorScope >= 0) return raw.slice(operatorScope + 2).trim();
  let angleDepth = 0;
  for (let i = raw.length - 1; i > 0; i--) {
    if (raw[i] === '>') angleDepth++;
    else if (raw[i] === '<' && angleDepth > 0) angleDepth--;
    else if (angleDepth === 0 && raw[i] === ':' && raw[i - 1] === ':') {
      return raw.slice(i + 1).trim();
    }
  }
  return raw.trim();
}

/** Expand a declaration recovery range to the complete source lines it touches. */
function expandRangeToFullLines(source: string, start: number, end: number): SourceRange {
  const previousNewline = source.lastIndexOf('\n', Math.max(0, start - 1));
  const lineStart = previousNewline === -1 ? 0 : previousNewline + 1;
  const nextNewline = source.indexOf('\n', Math.max(end, start + 1));
  const lineEnd = nextNewline === -1 ? source.length : nextNewline + 1;
  return { start: lineStart, end: lineEnd };
}

/**
 * Find source scopes in which an error-triggered pre-parse transform is allowed
 * to operate. Errors inside functions authorize the containing function (all
 * control-macro lines in that already-damaged body may need masking). Type-body
 * errors authorize that type. Otherwise only the nearest declaration is used;
 * a root-level ERROR receives a two-line neighborhood. Preprocessor containers
 * deliberately never become scopes because one #if commonly wraps a whole
 * header and would recreate the old file-wide mutation behavior.
 */
function collectRecoveryScopes(
  root: SyntaxNode,
  source: string,
  extractor: LanguageExtractor,
  macroNames?: Set<string> | null,
): SourceRange[] {
  const macroArtifacts = findStatementMacroArtifacts(root, macroNames);
  if (!root.hasError && macroArtifacts.length === 0) return [];

  const functionTypes = new Set(extractor.functionTypes);
  const typeContainerTypes = new Set([
    ...extractor.classTypes,
    ...extractor.structTypes,
    ...extractor.enumTypes,
  ]);
  const declarationTypes = new Set([
    ...extractor.typeAliasTypes,
    ...extractor.variableTypes,
    ...(extractor.fieldTypes ?? []),
  ]);
  const ranges: SourceRange[] = [];
  const stack: SyntaxNode[] = [root];

  const addContainingScope = (issue: SyntaxNode): void => {
    let current = issue.parent;
    let declarationScope: SyntaxNode | null = null;
    let typeScope: SyntaxNode | null = null;
    let functionScope: SyntaxNode | null = null;
    while (current && current.type !== 'translation_unit') {
      if (functionTypes.has(current.type)) functionScope = current;
      else if (typeContainerTypes.has(current.type)) typeScope = current;
      else if (!declarationScope && declarationTypes.has(current.type)) declarationScope = current;
      current = current.parent;
    }

    if (functionScope) {
      ranges.push({ start: functionScope.startIndex, end: functionScope.endIndex });
    } else if (declarationScope) {
      // Error recovery often splits one physical declaration into adjacent AST
      // nodes (`void MACRO method() POSTFIX_MACRO override {}`). Masking only
      // the broken node leaves the postfix fragment untouched and can produce
      // a cleaner-but-still-wrong tree. The complete declaration lines are the
      // narrowest source-owned scope that keeps those fragments together.
      ranges.push(expandRangeToFullLines(
        source,
        declarationScope.startIndex,
        declarationScope.endIndex,
      ));
    } else if (typeScope) {
      ranges.push({ start: typeScope.startIndex, end: typeScope.endIndex });
    } else {
      ranges.push(expandRangeByLines(source, issue.startIndex, issue.endIndex, 2));
    }
  };

  for (const artifact of macroArtifacts) addContainingScope(artifact);

  while (stack.length > 0) {
    const issue = stack.pop()!;
    const isIssue = issue.isError || issue.isMissing;
    if (isIssue) addContainingScope(issue);

    if (!issue.hasError && !isIssue) continue;
    for (let i = 0; i < issue.childCount; i++) {
      const child = issue.child(i);
      if (child) stack.push(child);
    }
  }

  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: SourceRange[] = [];
  for (const range of ranges) {
    const start = Math.max(0, Math.min(source.length, range.start));
    const end = Math.max(start, Math.min(source.length, range.end));
    const previous = merged[merged.length - 1];
    if (previous && start <= previous.end) {
      if (end > previous.end) previous.end = end;
    } else if (end > start) {
      merged.push({ start, end });
    }
  }
  return merged;
}

/**
 * Keep an offset-preserving transform only inside parser-damaged scopes.
 * Returning the original source on a length mismatch enforces the preParse
 * contract and avoids invalid source-position mappings.
 */
function restrictTransformToScopes(
  source: string,
  transformed: string,
  scopes: SourceRange[],
): string {
  if (transformed.length !== source.length || transformed === source || scopes.length === 0) {
    return source;
  }

  const parts: string[] = [];
  let cursor = 0;
  for (const scope of scopes) {
    parts.push(source.slice(cursor, scope.start));
    parts.push(transformed.slice(scope.start, scope.end));
    cursor = scope.end;
  }
  parts.push(source.slice(cursor));
  return parts.join('');
}

/**
 * TreeSitterExtractor - Main extraction class
 */
export class TreeSitterExtractor {
  private filePath: string;
  private language: Language;
  private source: string;
  private tree: Tree | null = null;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];
  private timings: ExtractionTimings = {};
  private extractor: LanguageExtractor | null = null;
  private nodeStack: string[] = []; // Stack of parent node IDs
  private methodIndex: Map<string, string> | null = null; // lookup key → node ID for Pascal defProc lookup
  // Per-function shadow set: local variable names (params + declarations) that
  // hide same-named globals inside the current function body. Populated before
  // visiting each function body, cleared after. Only used for C/C++.
  private currentLocalNames: Set<string> = new Set();

  // Names of `#define` macros collected from the file's preproc_def /
  // preproc_function_def nodes. Passed to isMisparsedFunction so C/C++ extractors
  // can suppress spurious function nodes from macro invocations whose shape
  // (NAME(params) { body }) matches the function_definition grammar rule.
  private fileMacroNames: Set<string> = new Set();

  // Project-wide `#define` names collected by the orchestrator's pre-scan
  // (regex over all C/C++/ObjC files). Merged into `fileMacroNames` during
  // collectMacroNames() so `isMisparsedFunction` can suppress spurious
  // function nodes caused by macros defined in OTHER files (via #include).
  private globalMacroNames: Set<string> | null = null;

  // Project-wide bodyless object-like macro names (`#define NAME` with empty
  // body) collected by the orchestrator's pre-scan. Passed to preParse so the
  // C/C++ preprocessor transform can blank them (they expand to nothing),
  // turning `typedef SAFE VOS_BOOL (*FnPtr)(...)` into the clean shape
  // tree-sitter parses correctly. See c-cpp.ts preprocessStatementMacros.
  private globalBodylessMacroNames: Set<string> | null = null;
  /** Unambiguous project-wide definitions for declaration-macro recovery. */
  private globalMacroDefinitions: readonly CppMacroDefinition[] | null = null;
  /** Parser supplied for a short-lived auxiliary extraction; never cached. */
  private parserOverride: WasmParser | null = null;
  /** Original source bytes, retained for X-macro analysis before pre-parse transforms. */
  private originalSource: string;
  /** Built only when a declaration-shaped macro needs source line mapping. */
  private originalLineStarts: number[] | null = null;
  private lexicalCompoundEnds: Map<number, number> = new Map();
  private lexicalExecutableRanges: SourceRange[] | null = null;
  /** Proven self-including X-macro enum constructs found before parsing. */
  private xMacroConstructs: XMacroConstruct[] = [];

  constructor(
    filePath: string,
    source: string,
    language?: Language,
    globalMacroNames?: Set<string>,
    bodylessMacroNames?: Set<string>,
    macroDefinitions?: readonly CppMacroDefinition[],
    parserOverride?: WasmParser,
  ) {
    this.filePath = filePath;
    this.originalSource = source;
    this.source = source;
    this.language = language || detectLanguage(filePath, source);
    this.extractor = EXTRACTORS[this.language] || null;
    this.globalMacroNames = globalMacroNames ?? null;
    this.globalBodylessMacroNames = bodylessMacroNames ?? null;
    this.globalMacroDefinitions = macroDefinitions ?? null;
    this.parserOverride = parserOverride ?? null;
  }

  /**
   * Parse and extract from the source code
   */
  extract(): ExtractionResult {
    const startTime = Date.now();
    this.timings = {};

    if (!isLanguageSupported(this.language)) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `Unsupported language: ${this.language}`,
            filePath: this.filePath,
            severity: 'error',
            code: 'unsupported_language',
          },
        ],
        durationMs: Date.now() - startTime,
      };
    }

    const parser = this.parserOverride ?? getParser(this.language);
    if (!parser) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `Failed to get parser for language: ${this.language}`,
            filePath: this.filePath,
            severity: 'error',
            code: 'parser_error',
          },
        ],
        durationMs: Date.now() - startTime,
      };
    }

    // Fast path for pure-macro data headers (C only). Files made entirely of
    // preprocessor directives (≥20 object-like #define data macros) trigger a
    // pathological tree-sitter-c parse once macro bodies carry inline block
    // comments or very long rows — measured ~O(n²) with a collapsed tree
    // (0-2 macros survive), far past the per-file parse timeout, yet they
    // yield no extractable symbols beyond macro names. Skip the parse and
    // collect macro names via regex instead: O(n), and better recall than the
    // broken parse path. Detection is a structural whitelist over
    // comment/literal-masked text (see isPureMacroDataHeader), so semicolons
    // in a license banner no longer push a data table into the pathological
    // parse, and code of any shape keeps the normal path. C++ is not affected
    // by the timeout (different grammar constants) and stays on the normal
    // path. Escape hatch: CODEGRAPH_FORCE_PARSE=1 forces the normal parse.
    if (this.language === 'c' && isPureMacroDataHeader(this.source)) {
      const { nodes: macroNodes, edges: macroEdges } = extractMacrosByRegex(
        this.filePath,
        this.source,
        this.language,
      );
      return {
        nodes: macroNodes,
        edges: macroEdges,
        unresolvedReferences: [],
        errors: [
          {
            message:
              'Skipped parse for pure-macro data header (set CODEGRAPH_FORCE_PARSE=1 to force)',
            filePath: this.filePath,
            severity: 'warning',
            code: 'skipped_macro_data_header',
          },
        ],
        durationMs: Date.now() - startTime,
      };
    }

    try {
      // Reset per-file state
      this.currentLocalNames.clear();
      this.fileMacroNames.clear();
      this.source = this.originalSource;
      this.xMacroConstructs = [];

      // A self-including X-macro enum is recoverable without a filesystem or a
      // full preprocessor because both the macro data list and the enum live in
      // this source string. Analyze the original bytes first; only complete,
      // provable constructs have their owned directive lines blanked.
      if (xmacroSupported(this.language)) {
        const xmacro = detectXMacroConstructs(this.originalSource, this.filePath);
        this.source = xmacro.blankedSource;
        this.xMacroConstructs = xmacro.constructs;
      }

      // Controlled plan F (C only): a define-dense header that did NOT take
      // the pure-macro fast path (mixed macro table + real declarations)
      // blanked the block comments inside its #define bodies before parsing —
      // they are what drives tree-sitter-c into the O(n²) error recovery that
      // times out syncs and collapses the tree. Length-preserving, so node
      // offsets stay valid; comments outside directives are untouched. See
      // blankDefineBodyComments for the full rationale and semantics.
      if (this.language === 'c') {
        this.source = blankDefineBodyComments(this.source);
      }

      const primaryParseStarted = performance.now();
      // Optional offset-preserving source transform for grammar gaps. Most
      // languages use the historical `always` strategy. C/C++ uses `on-error`:
      // parse the original bytes first, leave a healthy tree completely
      // untouched, and only try macro masking inside structurally damaged
      // scopes. The retry is accepted only when ERROR/MISSING or proven silent
      // macro-structure damage decreases.
      const preParse = this.extractor?.preParse;
      if (preParse && this.extractor?.preParseStrategy === 'on-error') {
        const baseSource = this.source;
        const rawTree = parser.parse(baseSource) ?? null;
        if (!rawTree) throw new Error('Parser returned null tree');
        this.tree = rawTree;

        const originalDamage = measureParseDamage(rawTree.rootNode, this.globalMacroNames);
        if (originalDamage.score > 0) {
          const transformed = preParse(
            baseSource,
            this.globalMacroNames ?? undefined,
            this.globalBodylessMacroNames ?? undefined,
          );
          // Some C++ grammar workarounds are syntax-only. Parse their masked
          // bytes, but keep the ordinary recovery source for getNodeText and
          // signatures after adoption. Every transform is offset preserving,
          // so one tree can safely address the other string.
          const parseOnlyRecovery = this.extractor.parseOnlyRecovery;
          const parseOnlyTransformed = parseOnlyRecovery
            ? parseOnlyRecovery(
                transformed,
                this.globalMacroNames ?? undefined,
                this.globalBodylessMacroNames ?? undefined,
              )
            : undefined;
          // Collect recovery scopes ONLY when some transformer actually
          // changed the source: with both transforms identical to the
          // original, restrictTransformToScopes can only return the original
          // and the candidate list is necessarily empty — yet the scope
          // walk over an ERROR-heavy tree is expensive (measured 8.9s on a
          // single-macro header whose damage was unrelated to macros). The
          // parse-only transformer is checked too: it can mask `const`
          // qualifiers even when the macro transform is a no-op, and those
          // candidates must survive.
          const scopes =
            transformed !== baseSource || parseOnlyTransformed !== undefined && parseOnlyTransformed !== baseSource
              ? collectRecoveryScopes(
                  rawTree.rootNode,
                  baseSource,
                  this.extractor,
                  this.globalMacroNames,
                )
              : [];
          const extractionRecoverySource = restrictTransformToScopes(
            baseSource,
            transformed,
            scopes,
          );
          const candidates: Array<{ parseSource: string; extractionSource: string }> = [];

          if (parseOnlyRecovery) {
            const parseOnlySource = restrictTransformToScopes(
              baseSource,
              parseOnlyTransformed!,
              scopes,
            );
            if (
              parseOnlySource !== baseSource &&
              !candidates.some((candidate) => candidate.parseSource === parseOnlySource)
            ) {
              candidates.push({
                parseSource: parseOnlySource,
                extractionSource: extractionRecoverySource,
              });
            }
          }
          // Try the combined syntax-only candidate first. When it reaches a
          // clean score there is no need to pay for a second recovery parse;
          // damaged files therefore normally remain at two parses total.
          if (
            extractionRecoverySource !== baseSource &&
            !candidates.some((candidate) => candidate.parseSource === extractionRecoverySource)
          ) {
            candidates.push({
              parseSource: extractionRecoverySource,
              extractionSource: extractionRecoverySource,
            });
          }

          let bestTree: Tree = rawTree;
          let bestDamage = originalDamage;
          let bestSource = baseSource;
          for (const candidate of candidates) {
            const candidateTree = parser.parse(candidate.parseSource) ?? null;
            if (!candidateTree) continue;
            const candidateDamage = measureParseDamage(
              candidateTree.rootNode,
              this.globalMacroNames,
            );
            if (
              isParseDamageBetter(candidateDamage, bestDamage) &&
              preservesNamedTypeDefinitions(
                candidateTree.rootNode,
                rawTree.rootNode,
                this.extractor,
              )
            ) {
              if (bestTree !== rawTree) bestTree.delete();
              bestTree = candidateTree;
              bestDamage = candidateDamage;
              bestSource = candidate.extractionSource;
              if (bestDamage.score === 0) break;
            } else {
              candidateTree.delete();
            }
          }

          if (bestTree !== rawTree) {
            rawTree.delete();
            this.tree = bestTree;
            this.source = bestSource;
          }
        }
      } else {
        if (preParse) {
          this.source = preParse(
            this.source,
            this.globalMacroNames ?? undefined,
            this.globalBodylessMacroNames ?? undefined,
          );
        }
        this.tree = parser.parse(this.source) ?? null;
      }
      if (!this.tree) {
        throw new Error('Parser returned null tree');
      }
      this.timings.primaryParseMs = performance.now() - primaryParseStarted;

      const primaryExtractionStarted = performance.now();
      // Create file node representing the source file
      const fileNode: Node = {
        id: `file:${this.filePath}`,
        kind: 'file',
        name: path.basename(this.filePath),
        qualifiedName: this.filePath,
        filePath: this.filePath,
        language: this.language,
        startLine: 1,
        endLine: this.source.split('\n').length,
        startColumn: 0,
        endColumn: 0,
        isExported: false,
        updatedAt: Date.now(),
      };
      this.nodes.push(fileNode);

      // Push file node onto stack so top-level declarations get contains edges
      this.nodeStack.push(fileNode.id);

      // The parser input has proven X-macro definitions blanked so the enum
      // grammar can recover. Recreate those definitions from originalSource as
      // ordinary file-owned macro nodes before walking the transformed tree.
      this.recoverXMacroMacros();

      // Collect `#define` macro names for misparse filtering. C/C++ parsers
      // lack a preprocessor: when a macro invocation has the shape
      // `MACRO_NAME(params) { body }`, tree-sitter misparses it as a
      // function_definition. Collecting names here lets isMisparsedFunction
      // suppress those spurious function nodes.
      this.collectMacroNames();

      // File-level package declaration (Kotlin/Java). Creates an implicit
      // `namespace` node wrapping every top-level declaration so their
      // qualifiedName carries the FQN — required for cross-file import
      // resolution on JVM languages where filename ≠ class name.
      const packageNodeId = this.extractFilePackage(this.tree.rootNode);
      if (packageNodeId) this.nodeStack.push(packageNodeId);

      this.visitNode(this.tree.rootNode);

      // A single malformed macro can make tree-sitter fold all later
      // out-of-line C++ methods into ERROR nodes. Recover only source-spelled,
      // qualified definitions whose body delimiter is still unambiguous.
      this.recoverSourceSpelledCppMethodDefinitions();

      if (packageNodeId) this.nodeStack.pop();
      this.nodeStack.pop();
      this.timings.primaryExtractionMs = performance.now() - primaryExtractionStarted;

      this.recoverDeclarationMacroNodes();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      // WASM runtime corruption leaves the module unsafe for every subsequent
      // parse. Re-throw so the worker can terminate and be replaced.
      if (isWasmRuntimeCorruptionError(msg)) {
        throw error;
      }

      this.errors.push({
        message: `Parse error: ${msg}`,
        filePath: this.filePath,
        severity: 'error',
        code: 'parse_error',
      });
    } finally {
      // Free tree-sitter WASM memory immediately — trees hold native heap memory
      // invisible to V8's GC that accumulates across thousands of files.
      this.releaseTree();
      // Release source string to reduce GC pressure
      this.source = '';
    }

    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
      timings: this.timings,
    };
  }

  /** Delete the current native tree once and clear the reference first. */
  private releaseTree(): void {
    const tree = this.tree;
    this.tree = null;
    tree?.delete();
  }

  /** Parse one transformed declaration source with a disposable Parser. */
  private extractDeclarationRecoverySource(source: string): ExtractionResult {
    const parser = createParser(this.language);
    if (!parser) {
      throw new Error(`Failed to create isolated parser for language: ${this.language}`);
    }
    try {
      return extractFromSource(
        this.filePath,
        source,
        this.language,
        undefined,
        this.globalMacroNames ?? undefined,
        this.globalBodylessMacroNames ?? undefined,
        undefined,
        parser,
      );
    } finally {
      parser.delete();
    }
  }

  /**
   * A declaration-generating macro at file/namespace/class scope is worth an
   * auxiliary expansion parse. Ordinary statement macros inside a compound
   * statement are not: expanding them adds parse cost and can surface local
   * implementation details as symbols. The raw tree is sufficient for this
   * boundary check even when the invocation itself is an ERROR node.
   */
  private isDeclarationMacroScope(line: number, column: number): boolean {
    if (!this.tree) return false;
    const sourceOffset = this.originalLineStart(line) + column;
    if ((this.language === 'c' || this.language === 'cpp')
      && this.isInsideLexicalExecutableBody(sourceOffset)) return false;
    let current = this.tree.rootNode.descendantForPosition({
      row: Math.max(0, line - 1),
      column: Math.max(0, column),
    });
    let depth = 0;
    while (current && depth++ < 128) {
      if (current.type === 'compound_statement') {
        // Error recovery sometimes extends a function's compound_statement far
        // beyond its real closing brace. Ignore that stale AST ancestor only
        // when a lexical, balanced close proves the invocation lies after it.
        if (sourceOffset <= this.lexicalCompoundEnd(current.startIndex)) return false;
      }
      current = current.parent;
    }
    return true;
  }

  /** Map a 1-indexed line to its byte offset, building the table on first use. */
  private originalLineStart(line: number): number {
    if (this.originalLineStarts === null) {
      const starts = [0];
      for (let i = 0; i < this.originalSource.length; i++) {
        if (this.originalSource[i] === '\n') starts.push(i + 1);
      }
      this.originalLineStarts = starts;
    }
    return this.originalLineStarts[Math.max(0, line - 1)] ?? 0;
  }

  /**
   * Preserve only the source lines needed to parse declaration-macro output in
   * its original namespace/class/template context. This keeps line numbers and
   * qualified names stable without reparsing an entire large translation unit.
   */
  private buildDeclarationMacroRecoverySource(
    expandedSource: string,
    invocationLines: ReadonlySet<number>,
  ): string {
    if (!this.tree || !this.extractor) return expandedSource;
    const lines = expandedSource.split('\n');
    const originalLines = this.originalSource.split('\n');
    const kept = new Set<number>();
    const root = this.tree.rootNode;
    const containerTypes = new Set<string>([
      'namespace_definition',
      'linkage_specification',
      ...this.extractor.classTypes,
      ...this.extractor.structTypes,
      ...this.extractor.enumTypes,
    ]);

    const keepRows = (startRow: number, endRow: number): void => {
      const start = Math.max(0, Math.min(startRow, lines.length - 1));
      const end = Math.max(start, Math.min(endRow, lines.length - 1));
      for (let row = start; row <= end; row++) kept.add(row + 1);
    };

    for (const line of invocationLines) {
      const row = Math.max(0, line - 1);
      const originalLine = originalLines[row] ?? '';
      const column = originalLine.search(/\S/);
      let current: SyntaxNode | null = root.descendantForPosition({
        row,
        column: Math.max(0, column),
      });
      let depth = 0;
      while (current && depth++ < 128) {
        if (containerTypes.has(current.type)) {
          const body = this.extractor.resolveBody?.(current, this.extractor.bodyField)
            ?? getChildByField(current, this.extractor.bodyField);
          if (body) {
            let headerStart = current.startPosition.row;
            if (current.parent?.type === 'template_declaration') {
              headerStart = current.parent.startPosition.row;
            }
            keepRows(headerStart, body.startPosition.row);
            keepRows(body.endPosition.row, current.endPosition.row);

            // Visibility is semantic context for generated members. Preserve
            // the latest access section preceding this invocation.
            let latestAccess: SyntaxNode | null = null;
            for (const child of body.namedChildren) {
              if (child.type === 'access_specifier' && child.startPosition.row <= row) {
                latestAccess = child;
              }
            }
            if (latestAccess) {
              keepRows(latestAccess.startPosition.row, latestAccess.endPosition.row);
            }
          }
        }
        current = current.parent;
      }

      this.keepDeclarationContinuationLines(lines, line, kept);
    }

    return lines.map((text, index) => kept.has(index + 1) ? text : '').join('\n');
  }

  /** Keep a split declaration/function body following an expanded invocation. */
  private keepDeclarationContinuationLines(
    lines: readonly string[],
    startLine: number,
    kept: Set<number>,
  ): void {
    let parenDepth = 0;
    let braceDepth = 0;
    let bodyStarted = false;
    let blockComment = false;
    const lastRow = Math.min(lines.length - 1, Math.max(0, startLine - 1) + 512);

    for (let row = Math.max(0, startLine - 1); row <= lastRow; row++) {
      kept.add(row + 1);
      const text = lines[row] ?? '';
      for (let i = 0; i < text.length; i++) {
        const char = text[i]!;
        if (blockComment) {
          if (char === '*' && text[i + 1] === '/') {
            blockComment = false;
            i++;
          }
          continue;
        }
        if (char === '/' && text[i + 1] === '*') {
          blockComment = true;
          i++;
          continue;
        }
        if (char === '/' && text[i + 1] === '/') break;
        if (char === '"' || char === "'") {
          const quote = char;
          for (i++; i < text.length; i++) {
            if (text[i] === '\\') i++;
            else if (text[i] === quote) break;
          }
          continue;
        }
        if (char === '(') parenDepth++;
        else if (char === ')' && parenDepth > 0) parenDepth--;
        else if (char === '{' && parenDepth === 0) {
          bodyStarted = true;
          braceDepth++;
        } else if (char === '}' && bodyStarted && --braceDepth === 0) {
          return;
        } else if (char === ';' && !bodyStarted && parenDepth === 0) {
          return;
        }
      }
    }
  }

  /** Lexically identify balanced function/lambda bodies even in a damaged AST. */
  private isInsideLexicalExecutableBody(offset: number): boolean {
    if (this.lexicalExecutableRanges === null) {
      const source = this.originalSource;
      const ranges: SourceRange[] = [];
      const stack: Array<{ executable: boolean; start: number }> = [];
      let executableDepth = 0;
      let segmentStart = 0;
      let parenDepth = 0;
      let bracketDepth = 0;
      for (let i = 0; i < source.length; i++) {
        const char = source[i]!;
        if (char === '"' || char === "'") {
          const quote = char;
          for (i++; i < source.length; i++) {
            if (source[i] === '\\') i++;
            else if (source[i] === quote) break;
          }
        } else if (char === '/' && source[i + 1] === '/') {
          const end = source.indexOf('\n', i + 2);
          i = (end === -1 ? source.length : end) - 1;
        } else if (char === '/' && source[i + 1] === '*') {
          const end = source.indexOf('*/', i + 2);
          i = (end === -1 ? source.length : end + 2) - 1;
        } else if (char === '#' && /^\s*$/.test(source.slice(source.lastIndexOf('\n', i - 1) + 1, i))) {
          // Braces inside a multi-line macro definition are preprocessing
          // tokens, not lexical C/C++ scopes.
          let end = source.indexOf('\n', i + 1);
          while (end !== -1 && source[end - 1] === '\\') end = source.indexOf('\n', end + 1);
          i = end === -1 ? source.length : end;
          segmentStart = i + 1;
        } else if (char === '(') parenDepth++;
        else if (char === ')' && parenDepth > 0) parenDepth--;
        else if (char === '[') bracketDepth++;
        else if (char === ']' && bracketDepth > 0) bracketDepth--;
        else if (char === '{' && parenDepth === 0 && bracketDepth === 0) {
          const parentExecutable = executableDepth > 0;
          const context = source.slice(segmentStart, i).trim();
          const declarationContainer = /\b(?:namespace|class|struct|union|enum)\b[\s\S]*$/.test(context);
          const callableHeader = /\)[\s\S]*(?:const|volatile|noexcept|override|final|requires|->|:)?\s*$/.test(context)
            || /\][\s\S]*(?:\([^)]*\))?\s*$/.test(context);
          const executable = parentExecutable || (!declarationContainer && callableHeader);
          stack.push({ executable, start: i });
          if (executable) executableDepth++;
          segmentStart = i + 1;
        } else if (char === '}' && parenDepth === 0 && bracketDepth === 0) {
          const entry = stack.pop();
          if (entry?.executable) {
            executableDepth--;
            if (executableDepth === 0) ranges.push({ start: entry.start + 1, end: i });
          }
          segmentStart = i + 1;
        } else if (char === ';' && parenDepth === 0 && bracketDepth === 0) {
          segmentStart = i + 1;
        }
      }
      this.lexicalExecutableRanges = ranges;
    }
    // Top-level executable ranges are disjoint and appended in source order.
    // Locate the first range whose end is after the offset instead of scanning
    // every function body for every declaration-macro candidate.
    let low = 0;
    let high = this.lexicalExecutableRanges.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.lexicalExecutableRanges[mid]!.end <= offset) low = mid + 1;
      else high = mid;
    }
    const range = this.lexicalExecutableRanges[low];
    return !!range && offset >= range.start && offset < range.end;
  }

  private lexicalCompoundEnd(start: number): number {
    const cached = this.lexicalCompoundEnds.get(start);
    if (cached !== undefined) return cached;
    const source = this.originalSource;
    let braceDepth = 0;
    for (let i = start; i < source.length; i++) {
      const char = source[i]!;
      if (char === '"' || char === "'") {
        const quote = char;
        for (i++; i < source.length; i++) {
          if (source[i] === '\\') i++;
          else if (source[i] === quote) break;
        }
      } else if (char === '/' && source[i + 1] === '/') {
        const end = source.indexOf('\n', i + 2);
        i = (end === -1 ? source.length : end) - 1;
      } else if (char === '/' && source[i + 1] === '*') {
        const end = source.indexOf('*/', i + 2);
        i = (end === -1 ? source.length : end + 2) - 1;
      } else if (char === '{') {
        braceDepth++;
      } else if (char === '}' && --braceDepth === 0) {
        this.lexicalCompoundEnds.set(start, i);
        return i;
      }
    }
    this.lexicalCompoundEnds.set(start, source.length);
    return source.length;
  }

  /**
   * Recover source-spelled `Return Owner::method(...) {` definitions from a
   * damaged C++ tree. This is intentionally narrower than a regex function
   * extractor: it only runs on erroneous trees, requires a qualified name and
   * a balanced parameter list followed by a body, and deduplicates normal AST
   * results. Calls such as `ns::fn(...)` are rejected unless a return-type
   * prefix is present; the prefix-free exception is a real ctor/dtor.
   */
  private recoverSourceSpelledCppMethodDefinitions(): void {
    if (this.language !== 'cpp' || !this.tree?.rootNode.hasError || !this.originalSource.includes('::')) {
      return;
    }
    const source = this.originalSource;
    const lineStarts = [0];
    for (let i = 0; i < source.length; i++) {
      if (source[i] === '\n') lineStarts.push(i + 1);
    }
    const lineForOffset = (offset: number): number => {
      let low = 0;
      let high = lineStarts.length;
      while (low + 1 < high) {
        const mid = (low + high) >>> 1;
        if (lineStarts[mid]! <= offset) low = mid;
        else high = mid;
      }
      return low + 1;
    };
    const skipQuoted = (offset: number): number => {
      const quote = source[offset]!;
      let i = offset + 1;
      while (i < source.length) {
        if (source[i] === '\\') i += 2;
        else if (source[i] === quote) return i + 1;
        else i++;
      }
      return i;
    };
    const closeParameterList = (open: number): number => {
      let depth = 0;
      for (let i = open; i < source.length; i++) {
        const char = source[i]!;
        if (char === '"' || char === "'") {
          i = skipQuoted(i) - 1;
        } else if (char === '/' && source[i + 1] === '/') {
          const end = source.indexOf('\n', i + 2);
          i = (end === -1 ? source.length : end) - 1;
        } else if (char === '/' && source[i + 1] === '*') {
          const end = source.indexOf('*/', i + 2);
          i = (end === -1 ? source.length : end + 2) - 1;
        } else if (char === '(') {
          depth++;
        } else if (char === ')' && --depth === 0) {
          return i;
        }
      }
      return -1;
    };
    const bodyDelimiter = (start: number): { offset: number; char: string } | null => {
      const limit = Math.min(source.length, start + 4096);
      for (let i = start; i < limit; i++) {
        const char = source[i]!;
        if (char === '"' || char === "'") i = skipQuoted(i) - 1;
        else if (char === '/' && source[i + 1] === '/') {
          const end = source.indexOf('\n', i + 2);
          i = (end === -1 ? source.length : end) - 1;
        } else if (char === '/' && source[i + 1] === '*') {
          const end = source.indexOf('*/', i + 2);
          i = (end === -1 ? source.length : end + 2) - 1;
        } else if (char === '{' || char === ';') return { offset: i, char };
      }
      return null;
    };

    const candidate = /^[ \t]*([^#\/\n;{}]*?)((?:[A-Za-z_]\w*(?:\s*<[^;\n{}]+>)?\s*::)+(?:~?[A-Za-z_]\w*(?:\s*<[^;\n{}]+>)?|operator\s*(?:\[\]|\(\)|[^;\n{}(]+?)))\s*\(/gm;
    let match: RegExpExecArray | null;
    while ((match = candidate.exec(source)) !== null) {
      const open = candidate.lastIndex - 1;
      const close = closeParameterList(open);
      if (close < 0) continue;
      const delimiter = bodyDelimiter(close + 1);
      if (!delimiter || delimiter.char !== '{') continue;

      const parsed = parseSourceSpelledCppCallable(source.slice(match.index, open));
      if (!parsed) continue;
      const { name, qualifiedName } = parsed;
      const line = lineForOffset(match.index);
      const lineStart = lineStarts[line - 1]!;
      const column = match.index - lineStart;
      if (this.nodes.some(node =>
        node.name === name && (
          (node.qualifiedName === qualifiedName && Math.abs(node.startLine - line) <= 2) ||
          (node.kind === 'method' && node.startLine === line && node.startColumn === column)
        ))) {
        continue;
      }
      const signature = source.slice(match.index, delimiter.offset).trim();
      this.createSyntheticNode('method', name, line, column, name.length, {
        qualifiedName,
        signature,
        isDeclaration: false,
        isExported: true,
      }, 'cpp-qualified-definition-recovery');
    }
  }

  /**
   * Recover declarations created by macros from a line-preserving sparse source
   * that retains namespace/class/template context around each invocation. Only
   * new symbol nodes anchored to an expanded invocation line are merged;
   * references/calls remain owned by the primary source parse.
   */
  private recoverDeclarationMacroNodes(): void {
    if (
      (this.language !== 'c' && this.language !== 'cpp') ||
      !this.globalMacroDefinitions ||
      this.globalMacroDefinitions.length === 0 ||
      !this.tree
    ) {
      return;
    }

    const expansionStarted = performance.now();
    const expanded = expandDeclarationMacros(
      this.originalSource,
      this.globalMacroDefinitions,
      (line, column) => this.isDeclarationMacroScope(line, column),
      (line, column) => {
        const sourceOffset = this.originalLineStart(line) + column;
        return !this.isInsideLexicalExecutableBody(sourceOffset);
      },
    );
    this.timings.declarationMacroExpansionMs =
      performance.now() - expansionStarted;
    if (expanded.source === this.originalSource || expanded.invocationLines.size === 0) return;

    const recoverySourceStarted = performance.now();
    const recoverySource = this.buildDeclarationMacroRecoverySource(
      expanded.source,
      expanded.invocationLines,
    );
    this.timings.declarationMacroRecoverySourceMs =
      performance.now() - recoverySourceStarted;

    // All primary-tree work is complete at this point. Release it before any
    // auxiliary parse so no nested extraction shares a live tree with another
    // Parser in the same web-tree-sitter runtime.
    this.releaseTree();

    // Deliberately omit macroDefinitions to prevent recursive auxiliary parses.
    // A one-shot Parser is never shared with the worker's long-lived parser.
    const auxiliaryParseStarted = performance.now();
    const recovered = this.extractDeclarationRecoverySource(recoverySource);
    this.timings.declarationMacroAuxParseMs =
      performance.now() - auxiliaryParseStarted;
    const recoveredNodes = recovered.nodes;
    const recoveredEdges = recovered.edges;

    const mergeStarted = performance.now();

    const recoverableKinds = new Set<NodeKind>([
      'class', 'struct', 'enum', 'enum_member', 'interface', 'trait',
      'type_alias', 'function', 'method', 'field', 'property',
      'variable', 'constant',
    ]);
    const existingIds = new Set(this.nodes.map(node => node.id));
    const generatedIds = new Set<string>();
    const recoveredById = new Map(recoveredNodes.map(node => [node.id, node]));
    const recoveredParent = new Map<string, string>();
    for (const edge of recoveredEdges) {
      if (edge.kind === 'contains') recoveredParent.set(edge.target, edge.source);
    }
    const isTemplateParameterArtifact = (node: Node): boolean => {
      if (node.kind !== 'field' && node.kind !== 'property' && node.kind !== 'variable') return false;
      let parentId = recoveredParent.get(node.id);
      for (let depth = 0; parentId && depth < 32; depth++) {
        const parent = recoveredById.get(parentId);
        if (!parent) break;
        if (parent.typeParameters?.includes(node.name)) return true;
        parentId = recoveredParent.get(parentId);
      }
      return false;
    };
    const isRedundantSourceSpelledDefinition = (node: Node): boolean => {
      if (
        this.language !== 'cpp' ||
        (node.kind !== 'method' && node.kind !== 'function') ||
        node.isDeclaration ||
        !node.qualifiedName
      ) {
        return false;
      }
      const normalizedQualifiedName = node.qualifiedName
        .trim()
        .replace(/\s*::\s*/g, '::');
      const lineStart = this.originalLineStart(node.startLine);
      const lineEnd = this.originalSource.indexOf('\n', lineStart);
      const sourceLine = this.originalSource
        .slice(lineStart, lineEnd === -1 ? this.originalSource.length : lineEnd)
        .replace(/\s+/g, '');
      if (!sourceLine.includes(normalizedQualifiedName.replace(/\s+/g, ''))) return false;
      return this.nodes.some(existing =>
        existing.kind === node.kind &&
        existing.name.trim() === node.name.trim() &&
        existing.qualifiedName.trim().replace(/\s*::\s*/g, '::') === normalizedQualifiedName &&
        existing.startLine === node.startLine &&
        existing.startColumn === node.startColumn &&
        !existing.isDeclaration
      );
    };
    for (const node of recoveredNodes) {
      if (
        !recoverableKinds.has(node.kind) ||
        !expanded.invocationLines.has(node.startLine) ||
        existingIds.has(node.id) ||
        expanded.expandedMacroNames.has(node.name) ||
        isRedundantSourceSpelledDefinition(node) ||
        isTemplateParameterArtifact(node)
      ) {
        continue;
      }
      this.nodes.push(node);
      existingIds.add(node.id);
      generatedIds.add(node.id);
    }
    if (generatedIds.size === 0) {
      this.timings.declarationMacroMergeMs = performance.now() - mergeStarted;
      return;
    }

    const existingEdgeKeys = new Set(
      this.edges.map(edge => `${edge.kind}\0${edge.source}\0${edge.target}`),
    );
    for (const edge of recoveredEdges) {
      if (edge.kind !== 'contains' || !generatedIds.has(edge.target)) continue;
      if (!existingIds.has(edge.source) && !generatedIds.has(edge.source)) continue;
      const key = `${edge.kind}\0${edge.source}\0${edge.target}`;
      if (existingEdgeKeys.has(key)) continue;
      this.edges.push(edge);
      existingEdgeKeys.add(key);
    }
    this.timings.declarationMacroMergeMs = performance.now() - mergeStarted;
  }

  /**
   * Visit a node and extract information
   */
  private visitNode(node: SyntaxNode): void {
    if (!this.extractor) return;

    const nodeType = node.type;
    let skipChildren = false;

    // Language-specific custom visitor hook
    if (this.extractor.visitNode) {
      const ctx = this.makeExtractorContext();
      const handled = this.extractor.visitNode(node, ctx);
      if (handled) return;
    }

    // Pascal-specific AST handling
    if (this.language === 'pascal') {
      skipChildren = this.visitPascalNode(node);
      if (skipChildren) return;
    }

    // Check for function declarations
    // For Python/Ruby, function_definition inside a class should be treated as method
    if (this.extractor.functionTypes.includes(nodeType)) {
      // C/C++ error recovery can wrap a complete type definition as the
      // `type` child of a later function_definition. This happens when
      // conditionally compiled fragments prevent the grammar from recognizing
      // the type's closing brace: the class/struct AST is still intact, but the
      // normal function path skips every non-body child. Recover that direct,
      // structural child before extracting the wrapper function. This also
      // handles legal inline return-type definitions without relying on names,
      // macros, paths, or project-specific conventions.
      if (this.language === 'c' || this.language === 'cpp') {
        const inlineType = getChildByField(node, 'type');
        if (inlineType && this.extractor.classTypes.includes(inlineType.type)) {
          this.extractClass(inlineType);
        } else if (inlineType && this.extractor.structTypes.includes(inlineType.type)) {
          this.extractStruct(inlineType);
        } else if (inlineType && this.extractor.enumTypes.includes(inlineType.type)) {
          this.extractEnum(inlineType);
        }
      }
      if (this.isInsideClassLikeNode() && this.extractor.methodTypes.includes(nodeType)) {
        // Inside a class - treat as method
        this.extractMethod(node);
        skipChildren = true; // extractMethod visits children via visitFunctionBody
      } else {
        this.extractFunction(node);
        skipChildren = true; // extractFunction visits children via visitFunctionBody
      }
    }
    // Check for class declarations
    else if (this.extractor.classTypes.includes(nodeType)) {
      // Some languages reuse class_declaration for structs/enums (e.g. Swift)
      const classification = this.extractor.classifyClassNode?.(node) ?? 'class';
      if (classification === 'struct') {
        this.extractStruct(node);
      } else if (classification === 'enum') {
        this.extractEnum(node);
      } else if (classification === 'interface') {
        this.extractInterface(node);
      } else if (classification === 'trait') {
        this.extractClass(node, 'trait');
      } else {
        this.extractClass(node);
      }
      skipChildren = true; // extractClass visits body children
    }
    // Extra class node types (e.g. Dart mixin_declaration, extension_declaration)
    else if (this.extractor.extraClassNodeTypes?.includes(nodeType)) {
      this.extractClass(node);
      skipChildren = true;
    }
    // Check for method declarations (only if not already handled by functionTypes)
    else if (this.extractor.methodTypes.includes(nodeType)) {
      this.extractMethod(node);
      skipChildren = true; // extractMethod visits children via visitFunctionBody
    }
    // C++ explicit template instantiations (`template class Box<int>;`) use a
    // dedicated wrapper whose body-less type child is not a forward declaration.
    else if (this.language === 'cpp' && nodeType === 'template_instantiation') {
      skipChildren = this.extractCppTemplateInstantiation(node);
    }
    // Check for interface/protocol/trait declarations
    else if (this.extractor.interfaceTypes.includes(nodeType)) {
      this.extractInterface(node);
      skipChildren = true; // extractInterface visits body children
    }
    // Check for struct declarations
    else if (this.extractor.structTypes.includes(nodeType)) {
      this.extractStruct(node);
      skipChildren = true; // extractStruct visits body children
    }
    // Check for enum declarations
    else if (this.extractor.enumTypes.includes(nodeType)) {
      this.extractEnum(node);
      skipChildren = true; // extractEnum visits body children
    }
    // Check for type alias declarations (e.g. `type X = ...` in TypeScript)
    // For Go, type_spec wraps struct/interface definitions — resolveTypeAliasKind
    // detects these and extractTypeAlias creates the correct node kind.
    else if (this.extractor.typeAliasTypes.includes(nodeType)) {
      skipChildren = this.extractTypeAlias(node);
    }
    // C/C++ explicit type forward declarations (`class Foo;`, `struct S;`,
    // `enum class E;`). Keep them as declaration nodes, but do not confuse an
    // elaborated type use (`void f(struct S*)`) with a declaration.
    else if (
      (this.language === 'c' || this.language === 'cpp') &&
      (nodeType === 'declaration' || nodeType === 'field_declaration') &&
      this.extractExplicitForwardTypeDeclarations(node)
    ) {
      skipChildren = true;
    }
    // Check for class properties (e.g. C# property_declaration)
    else if (this.extractor.propertyTypes?.includes(nodeType) && this.isInsideClassLikeNode()) {
      this.extractProperty(node);
      skipChildren = true;
    }
    // Constructors, destructors, conversion operators and other no-return-type
    // C++ member declarations are `declaration -> function_declarator`, not
    // `field_declaration`. Route them through method extraction explicitly.
    else if (this.isCppClassMemberFunctionDeclaration(node)) {
      this.extractMethod(node, true);
      skipChildren = true;
    }
    // Check for class fields (e.g. Java field_declaration, C# field_declaration)
    else if (this.extractor.fieldTypes?.includes(nodeType) && this.isInsideClassLikeNode()) {
      this.extractField(node);
      skipChildren = true;
    }
    // C/C++: top-level field_declaration containing a function_declarator is a
    // misparsed function prototype. When a multi-line #define leaks struct-body
    // content into the translation_unit (e.g. uv.h UV_HANDLE_FIELDS), tree-sitter-c
    // treats subsequent `UV_EXTERN int foo(args);` as field_declaration instead of
    // declaration. Route these through extractVariable so the existing C/C++ branch
    // — which already detects function_declarator inside declarations — creates
    // proper function nodes for them.
    //
    // The leak can also swallow subsequent struct/enum definitions inside the
    // wrapper struct_specifier's field_declaration_list (X-macro pattern
    // `struct X { MACRO_FIELDS };` — tree-sitter-c has no preprocessor, so the
    // macro identifier is misread as the field type and field_declaration_list
    // never closes; ERROR recovery then folds the following top-level declarations
    // into one giant field_declaration). extractNestedStructEnums rescues those
    // still-intact struct_specifier/enum_specifier bodies.
    else if (
      (this.language === 'c' || this.language === 'cpp') &&
      nodeType === 'field_declaration' &&
      !this.isInsideClassLikeNode() &&
      !this.isInsideFunctionNode() &&
      (node.descendantsOfType('function_declarator').length > 0 ||
       this.hasSwallowedTypeDefinitions(node))
    ) {
      if (node.descendantsOfType('function_declarator').length > 0) {
        this.extractVariable(node);
        // When tree-sitter-c macro body leakage is deep enough, the misparsed
        // field_declaration wraps a struct_specifier that swallows subsequent
        // function prototypes as its own field_declaration_list children
        // (e.g. uv.h lines 738-837: struct uv_udp_send_s swallows 23
        //  uv_udp_* declarations; lines 972-1441: swallows 50 more).
        // Walk into struct_specifier → field_declaration_list and extract
        // every child field_declaration that contains a function_declarator.
        this.extractNestedStructFunctions(node);
      }
      this.extractNestedStructEnums(node);
      skipChildren = true;
    }
    // Check for variable declarations (const, let, var, etc.)
    // Only extract top-level / namespace-scope variables — not locals inside
    // functions, methods, class-like bodies, or orphaned compound_statements
    // (tree-sitter misparses K&R C definitions and macro-expanded test
    //  bodies, leaking their locals to the translation_unit level).
    else if (
      this.extractor.variableTypes.includes(nodeType) &&
      !this.isInsideClassLikeNode() &&
      !this.isInsideFunctionNode() &&
      !this.isInsideCompoundStatement(node)
    ) {
      // C/C++ unresolved wrapper macros can split
      //
      //   EXTERN_STDC_BEGIN
      //   typedef enum { A, B } Alias;
      //
      // into a broken `EXTERN_STDC_BEGIN typedef` declaration followed by a
      // normal declaration whose type is the still-intact anonymous enum. The
      // latter otherwise goes through extractVariable and skips its children,
      // losing the enum and every member. Recover only this precise two-node
      // error shape; a legal `enum { A } variable;` has no broken `typedef`
      // prefix and must remain a variable declaration.
      const splitTypedefEnum =
        (this.language === 'c' || this.language === 'cpp')
          ? this.getSplitTypedefEnumDeclaration(node)
          : null;
      const nextSplitTypedefEnum =
        (this.language === 'c' || this.language === 'cpp')
          ? this.getSplitTypedefEnumDeclaration(node.nextNamedSibling)
          : null;

      if (splitTypedefEnum) {
        this.extractEnum(splitTypedefEnum.enumNode, splitTypedefEnum.alias);
        skipChildren = true;
      } else if (nextSplitTypedefEnum?.prefixNode.id === node.id) {
        // Suppress the bogus variable named `typedef`; the following
        // declaration is recovered as the enum typedef above.
        skipChildren = true;
      }
      // C/C++ split-prototype stray half: this declaration is the spurious
      // `(declaration type:(type_identifier) declarator:(identifier) (MISSING
      // ";"))` that tree-sitter-c emits as the FIRST half of a misparsed
      // `<TYPE1> <TYPE2> *name(args);` prototype. The real function name lives
      // in the following expression_statement's call_expression, which the
      // expression_statement rescue recovers as a function node. Suppress the
      // bogus variable here (it would be named after the second type macro,
      // e.g. LDAP_CHAR) so the prototype yields exactly one function node.
      // A real variable declaration never has a MISSING ";" + a following
      // `*name(args)` expression_statement, so this never suppresses a
      // legitimate symbol. See isBrokenTypeSplitDeclaration /
      // rescueSplitPrototypeExprStmt.
      else if (
        (this.language === 'c' || this.language === 'cpp') &&
        this.isBrokenTypeSplitDeclaration(node) &&
        (this.rescueSplitPrototypeExprStmt(node.nextNamedSibling) !== null ||
          this.rescuePointerInitExprStmtName(node.nextNamedSibling) !== null)
      ) {
        skipChildren = true;
      } else {
        this.extractVariable(node);
        // C/C++: a declaration may wrap an ERROR child — stacked attribute
        // macros (e.g. `EXTERN VOS_VOID TlmFree(...) CALLEE_RET_ALIGN();`) can
        // cause tree-sitter-c to nest the function_declarator inside an ERROR
        // that is itself inside a declaration. extractVariable skips ERROR
        // children (not in DECLARATOR_TYPES), so don't skipChildren in that
        // case — let the body walker reach the ERROR so the ERROR-node rescue
        // below can extract the function declaration.
        const hasErrorWithFd =
          (this.language === 'c' || this.language === 'cpp') &&
          node.namedChildren.some(
            (c) => c.type === 'ERROR' && c.descendantsOfType('function_declarator').length > 0
          );
        skipChildren = !hasErrorWithFd;
      }
    }
    // C/C++: expression_statement at translation_unit/namespace scope is a
    // misparse caused by unrecognized macros before a variable declaration
    // with an initializer.  tree-sitter splits the first N identifiers into a
    // spurious declaration and leaves the real assignment as an
    // expression_statement.
    // e.g.  RRE_ATTRIBUTE_VISIBILITY VOS_UINT32 g_DEV_ulFrameType = VOS_NULL_LONG;
    else if (
      (this.language === 'c' || this.language === 'cpp') &&
      nodeType === 'expression_statement' &&
      !this.isInsideClassLikeNode() &&
      !this.isInsideFunctionNode() &&
      !this.isInsideCompoundStatement(node)
    ) {
      const inner = node.namedChild(0);
      if (inner?.type === 'assignment_expression') {
        const left = inner.namedChild(0);
        if (left?.type === 'identifier') {
          const name = getNodeText(left, this.source);
          if (name && !C_CPP_KEYWORD_NAMES.has(name)) {
            const right = inner.namedChild(1);
            const initValue = right
              ? getNodeText(right, this.source).slice(0, 100) : undefined;
            const initSignature = initValue
              ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;
            const isExported = this.extractor.isExported?.(left, this.source) ?? false;
            this.createNode('variable', name, left, {
              signature: initSignature,
              isExported,
            });
          }
        }
        else if (left?.type === 'pointer_expression') {
          // C/C++ pointer-variable-init rescue: `MACRO TYPE *g_ptr = init;`
          // where the leading visibility/type macro is NOT in the project
          // global `#define` set (so preParse doesn't replace it) gets split by
          // tree-sitter-c into a spurious `(declaration MACRO TYPE (MISSING
          // ";"))` + this `expression_statement(assignment_expression(
          // pointer_expression *g_ptr = init))`. The pointer variable name
          // lands in the pointer_expression and would be lost — the existing
          // assignment_expression rescue above only handles a bare-identifier
          // left (`g_x = init`), not `*g_ptr = init`. Rescue it symmetrically:
          // extract the identifier operand of the pointer_expression as a
          // variable. Only a bare-identifier operand matches (`*g_ptr`),
          // excluding `*id[idx]` / `*id.field` / `*name(args)` which are not
          // simple variable initializations. An expression_statement at
          // file/namespace scope is always error recovery (never valid C/C++),
          // so this never traps real code. See eval-crsp-init-var-repro for
          // the rescue matrix (left-non-bare-identifier was a known gap).
          const operand = left.namedChild(0);
          if (operand?.type === 'identifier') {
            const name = getNodeText(operand, this.source);
            if (name && !C_CPP_KEYWORD_NAMES.has(name)) {
              const right = inner.namedChild(1);
              const initValue = right
                ? getNodeText(right, this.source).slice(0, 100) : undefined;
              const initSignature = initValue
                ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;
              const isExported = this.extractor.isExported?.(operand, this.source) ?? false;
              this.createNode('variable', name, operand, {
                signature: initSignature,
                isExported,
              });
            }
          }
        }
      }
      else if (inner?.type === 'pointer_expression') {
        // C/C++ split-prototype rescue: `<TYPE1> <TYPE2> *name(args);` where
        // the leading type macros are neither in the project global `#define`
        // set (so preParse doesn't replace them) nor recognized types gets
        // split by tree-sitter-c into a spurious `(declaration … (MISSING
        // ";"))` (stray variable, suppressed by the variableTypes guard) +
        // this `expression_statement(pointer_expression(call_expression name
        // args))`. The function name lands in the call_expression and would be
        // lost. Reconstruct the function declaration from the combined span of
        // the broken declaration + this expression_statement. An
        // expression_statement at file/namespace scope is always error
        // recovery (never valid C/C++), so this never traps real code. See
        // isBrokenTypeSplitDeclaration / rescueSplitPrototypeExprStmt.
        const name = this.rescueSplitPrototypeExprStmt(node);
        if (name) {
          const prev = node.previousNamedSibling;
          if (prev && this.isBrokenTypeSplitDeclaration(prev)) {
            // prev is the minimal broken `type_identifier identifier (MISSING
            // ";")` immediately preceding this expression_statement, so the
            // span is just the one prototype line. Cap defensively (matches
            // the assignment_expression rescue's slice cap) so a pathological
            // pair can never yield an oversized signature node.
            let signature = this.source.slice(prev.startIndex, node.endIndex);
            if (signature.length > 2000) signature = signature.slice(0, 2000) + '...';
            this.createNode('function', name, node, {
              signature,
              isDeclaration: true,
            });
          }
        }
      }
      skipChildren = true;
    }
    // C/C++: top-level ERROR node containing a function_declarator is a
    // misparsed function prototype. Stacked attribute macros before the
    // return type (e.g. `SAFE VOS_VOID* OWNED NULLABLE`) plus a trailing
    // macro call after the parameter list (e.g. `CALLEE_RET_ALIGN()`)
    // break tree-sitter-c's declaration parse: the `*` is misread as a
    // dereference expression, the type split into a spurious declaration +
    // expression_statement, and the function_declarator lands in an ERROR
    // recovery node. Route through extractVariable so the existing C/C++
    // branch detects the function_declarator and creates a function
    // declaration node with isDeclaration=true.
    //
    // Do NOT set skipChildren: a large ERROR node (e.g. X-macro leak where
    // `struct foo { MACRO_FIELDS };` never closes the field_declaration_list)
    // may also contain struct_specifier / enum_specifier / declaration
    // children that the body walker still needs to dispatch to their own
    // extractors. extractVariable only processes direct children whose type
    // is in DECLARATOR_TYPES (bare function_declarator, pointer_declarator,
    // etc.), so it won't re-process declaration children the walker reaches
    // next.
    else if (
      (this.language === 'c' || this.language === 'cpp') &&
      nodeType === 'ERROR' &&
      !this.isInsideClassLikeNode() &&
      !this.isInsideFunctionNode() &&
      !this.isInsideCompoundStatement(node) &&
      node.descendantsOfType('function_declarator').length > 0
    ) {
      this.extractVariable(node);
    }
    // Swift stored properties inside a type. Swift instance properties aren't
    // extracted as their own nodes, but a property's PROPERTY WRAPPER
    // (`@Argument`/`@Published`/`@State`/custom) and declared type ARE
    // dependencies — attribute them to the enclosing type so the wrapper/type
    // files get dependents. Don't skipChildren: an initializer's calls still
    // matter. (Other languages extract properties via property/field types.)
    else if (
      this.language === 'swift' &&
      nodeType === 'property_declaration' &&
      this.isInsideClassLikeNode()
    ) {
      const ownerId = this.nodeStack[this.nodeStack.length - 1];
      if (ownerId) {
        this.extractDecoratorsFor(node, ownerId);
        this.extractVariableTypeAnnotation(node, ownerId);
        // Fluent / SwiftUI property-wrapper attributes often reference a model or
        // type by metatype in their ARGUMENTS — `@Siblings(through: Pivot.self,
        // …)`, `@Group(…)`. extractDecoratorsFor captures the wrapper type
        // (`Siblings`); this pulls the TYPE out of the argument expressions
        // (`Pivot.self` → a dependency on Pivot), so a model reached ONLY through
        // a relationship (a many-to-many pivot/join model) isn't left orphaned.
        // extractStaticMemberRef self-filters to `Type.member` navigation, so the
        // `\.$keypath` arguments and the wrapper `user_type` are skipped.
        const modifiers = node.namedChildren.find((c: SyntaxNode) => c.type === 'modifiers');
        if (modifiers) {
          const walkAttrArgs = (n: SyntaxNode): void => {
            this.extractStaticMemberRef(n);
            for (let i = 0; i < n.namedChildCount; i++) {
              const c = n.namedChild(i);
              if (c) walkAttrArgs(c);
            }
          };
          walkAttrArgs(modifiers);
        }
      }
    }
    // `export_statement` itself is not extracted — the walker descends
    // into children, where the inner declaration (lexical_declaration,
    // function_declaration, class_declaration, etc.) is dispatched to
    // its own extractor. `isExported` walks the parent chain, so the
    // exported flag is preserved automatically.
    //
    // Calling extractExportedVariables here AND descending caused every
    // `export const X = ...` to produce two nodes for the same symbol —
    // one kind:'variable' from extractExportedVariables and one
    // kind:'constant' from extractVariable. The dedicated dispatch is
    // the correct one (it picks kind from isConst, captures the
    // initializer signature, and walks type annotations); the
    // export-statement helper was redundant.
    // Check for preprocessor macro definitions (#define)
    else if (this.extractor.macroTypes?.includes(nodeType)) {
      this.extractMacro(node);
      skipChildren = true; // macro bodies don't contain sub-symbols
    }
    // Check for imports
    else if (this.extractor.importTypes.includes(nodeType)) {
      this.extractImport(node);
    }
    // Re-export from another module — `export { X } from './y'` (TS/JS). A
    // re-export is a dependency on the source module just like an import, but
    // the export_statement is otherwise only descended into (no declaration to
    // extract), so a barrel that ONLY re-exports produced zero edges and showed
    // 0 dependents. Link each re-exported name to its definition. Children are
    // still visited (a non-re-export `export const X = …` has no `source` and
    // falls through to its normal declaration extraction).
    else if (
      nodeType === 'export_statement' &&
      (this.language === 'typescript' || this.language === 'tsx' ||
       this.language === 'javascript' || this.language === 'jsx') &&
      getChildByField(node, 'source')
    ) {
      const parentId = this.nodeStack[this.nodeStack.length - 1];
      if (parentId) this.emitReExportRefs(node, parentId);
    }
    // Check for function calls
    else if (this.extractor.callTypes.includes(nodeType)) {
      this.extractCall(node);
    }
    // `new Foo(...)` / `Foo::new(...)` / object_creation_expression —
    // produce an `instantiates` reference. Children still walked so
    // nested calls inside the constructor args (`new Foo(bar())`) get
    // their own `calls` refs.
    else if (INSTANTIATION_KINDS.has(nodeType)) {
      this.extractInstantiation(node);
      // Java/C# `new T(...) { ... }` — anonymous class with body. Without
      // extracting it as a class node + its methods, the interface→impl
      // synthesizer (Phase 5.5) can't bridge T's abstract methods to the
      // anonymous overrides, and an agent investigating a call through T
      // (`strategy.iterator(...)` where strategy is a Strategy lambda body)
      // has to Read the file to find the actual implementation.
      const anonBody = this.findAnonymousClassBody(node);
      if (anonBody) {
        this.extractAnonymousClass(node, anonBody);
        skipChildren = true;
      }
    }
    // (Decorator handling lives inside the symbol-creating extractors
    // — extractClass / extractFunction / extractProperty — because the
    // decorator node sits BEFORE the symbol in the AST and the walker
    // would otherwise see the wrong nodeStack head.)
    // Rust: `impl Trait for Type { ... }` — creates implements edge from Type to Trait
    else if (nodeType === 'impl_item') {
      this.extractRustImplItem(node);
    }
    // TypeScript interface members: property_signature (`foo: T`, `foo?: T`)
    // and method_signature (`foo(arg: A): R`) both carry type annotations the
    // interface walker would otherwise drop. Extract them as `references`
    // edges from the interface so resolvers can wire callers/impact for
    // types that only appear in interface members.
    else if (
      (nodeType === 'property_signature' || nodeType === 'method_signature') &&
      this.isInsideClassLikeNode() &&
      this.TYPE_ANNOTATION_LANGUAGES.has(this.language)
    ) {
      const parentId = this.nodeStack[this.nodeStack.length - 1];
      if (parentId) {
        this.extractTypeAnnotations(node, parentId);
      }
      // don't skipChildren — nested signatures still need traversal
    }
    // C/C++ global variable reference tracking. Identifiers matching the
    // `g_xxx` naming convention inside a function/method body are collected
    // as `references` edges so codegraph_callers/codegraph_impact can answer
    // "who uses this global variable".
    else if (
      nodeType === 'identifier' &&
      (this.language === 'c' || this.language === 'cpp') &&
      this.nodeStack.length > 0
    ) {
      const name = getNodeText(node, this.source);
      if (name.length > 3 && name.startsWith('g_') && /^g_[a-zA-Z]/.test(name)) {
        const parentId = this.nodeStack[this.nodeStack.length - 1];
        if (parentId) {
          this.unresolvedReferences.push({
            fromNodeId: parentId,
            referenceName: name,
            referenceKind: 'references',
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
          });
        }
      }
    }

    // Visit children (unless the extract method already visited them)
    if (!skipChildren) {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) {
          this.visitNode(child);
        }
      }
    }
  }

  /**
   * Create a Node object
   */
  private createNode(
    kind: NodeKind,
    name: string,
    node: SyntaxNode,
    extra?: Partial<Node>
  ): Node | null {
    // Skip nodes with empty/missing names — they are not meaningful symbols
    // and would cause FK violations when edges reference them (see issue #42)
    if (!name) {
      return null;
    }

    const id = generateNodeId(this.filePath, kind, name, node.startPosition.row + 1);

    // Some grammars (e.g. Dart) model a function/method body as a *sibling* of
    // the signature node, so the declaration node's own range is just the
    // signature line. Extend endLine to the resolved body when it sits beyond
    // the node so the node spans its body — required for any body-level analysis
    // (callees, the callback synthesizer's body scan, context slices). Guarded to
    // only ever extend: for child-body grammars the body is within range (no-op).
    let endLine = node.endPosition.row + 1;
    if (kind === 'function' || kind === 'method') {
      const body = this.extractor?.resolveBody?.(node, this.extractor.bodyField);
      if (body && body.endPosition.row + 1 > endLine) {
        endLine = body.endPosition.row + 1;
      }
    }

    const newNode: Node = {
      id,
      kind,
      name,
      qualifiedName: this.buildQualifiedName(name),
      filePath: this.filePath,
      language: this.language,
      startLine: node.startPosition.row + 1,
      endLine,
      startColumn: node.startPosition.column,
      endColumn: node.endPosition.column,
      updatedAt: Date.now(),
      ...extra,
    };

    // Persist extra symbol-level modifiers (e.g. Kotlin `expect`/`actual`) onto
    // the node's decorators list so the resolver can pair multiplatform
    // declarations with their implementations. Merged, not overwritten, so a
    // language that also captures real annotations keeps both.
    const mods = this.extractor?.extractModifiers?.(node);
    if (mods && mods.length > 0) {
      newNode.decorators = [...(newNode.decorators ?? []), ...mods];
    }

    // Generic type parameters (e.g. C++ `template <typename T>`). Only the
    // declaration kinds in TYPE_PARAMETER_KINDS are asked, and only when the
    // language provides a getTypeParameters hook — so languages without it
    // (i.e. everything but C++) are completely unaffected. `extra` is honored
    // if a caller already supplied typeParameters.
    if (TYPE_PARAMETER_KINDS.has(kind) && newNode.typeParameters === undefined) {
      const tparams = this.extractor?.getTypeParameters?.(node, this.source);
      if (tparams && tparams.length > 0) {
        newNode.typeParameters = tparams;
      }
    }

    this.nodes.push(newNode);

    // Add containment edge from parent
    if (this.nodeStack.length > 0) {
      const parentId = this.nodeStack[this.nodeStack.length - 1];
      if (parentId) {
        this.edges.push({
          source: parentId,
          target: id,
          kind: 'contains',
        });
      }
    }

    return newNode;
  }

  /** Create a source-anchored node that has no tree-sitter SyntaxNode. */
  private createSyntheticNode(
    kind: NodeKind,
    name: string,
    startLine: number,
    startColumn: number,
    endColumn: number,
    extra?: Partial<Node>,
    salt?: string,
  ): Node | null {
    if (!name) return null;
    const id = generateNodeId(this.filePath, kind, name, startLine, salt);
    const newNode: Node = {
      id,
      kind,
      name,
      qualifiedName: this.buildQualifiedName(name),
      filePath: this.filePath,
      language: this.language,
      startLine,
      endLine: startLine,
      startColumn,
      endColumn,
      updatedAt: Date.now(),
      ...extra,
    };
    this.nodes.push(newNode);
    const parentId = this.nodeStack[this.nodeStack.length - 1];
    if (parentId) {
      this.edges.push({ source: parentId, target: id, kind: 'contains' });
    }
    return newNode;
  }

  /** Recreate X-macro definitions removed from the parser input by blanking. */
  private recoverXMacroMacros(): void {
    if (this.xMacroConstructs.length === 0) return;

    const lineStarts = [0];
    for (let i = 0; i < this.originalSource.length; i++) {
      if (this.originalSource[i] === '\n') lineStarts.push(i + 1);
    }
    const positionAt = (offset: number): { line: number; column: number } => {
      let lo = 0;
      let hi = lineStarts.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (lineStarts[mid]! <= offset) lo = mid + 1;
        else hi = mid;
      }
      const lineIndex = Math.max(0, lo - 1);
      return { line: lineIndex + 1, column: offset - lineStarts[lineIndex]! };
    };

    const seen = new Set<string>();
    for (const construct of this.xMacroConstructs) {
      for (const definition of construct.macroDefinitions ?? []) {
        const key = `${definition.nameStart}:${definition.name}`;
        if (seen.has(key)) continue;
        seen.add(key);

        let directiveEnd = definition.end;
        if (this.originalSource[directiveEnd - 1] === '\r') directiveEnd--;
        const start = positionAt(definition.start);
        const end = positionAt(directiveEnd);
        this.createSyntheticNode(
          'macro',
          definition.name,
          start.line,
          start.column,
          end.column,
          {
            endLine: end.line,
            signature: this.originalSource.slice(definition.start, directiveEnd),
            isExported: true,
          },
        );
      }
    }
  }

  /**
   * Find first named child whose type is in the given list.
   * Used to locate inner type nodes (e.g. enum_specifier inside a typedef).
   */
  private findChildByTypes(node: SyntaxNode, types: string[]): SyntaxNode | null {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && types.includes(child.type)) return child;
    }
    return null;
  }

  /**
   * Collect `#define` macro names from `preproc_def` and
   * `preproc_function_def` nodes in the AST. These are passed to
   * `isMisparsedFunction` so C/C++ extractors can suppress spurious
   * function nodes caused by macro invocations whose shape
   * (`MACRO_NAME(params) { body }`) matches the function_definition
   * grammar rule.
   *
   * Top-level `#define` directives are collected here (possibly nested
   * inside `#if`/`#ifdef` blocks). `#define` can also appear inside
   * function bodies — those are extracted as macro nodes by
   * visitFunctionBody's macroTypes branch, but are NOT collected here
   * (this scan stops at non-preproc nodes to avoid walking every
   * function body). The consequence: a function-local macro invoked
   * later as `MACRO(args){body}` is not in fileMacroNames, so
   * isMisparsedFunction won't suppress it — a known, low-risk gap
   * (function-local macros are typically used only within their
   * defining function).
   */
  private collectMacroNames(): void {
    if (!this.tree) return;

    // Container types that can hold preproc directives at file scope
    const preprocContainers = new Set([
      'preproc_if',
      'preproc_ifdef',
      'preproc_ifndef',
      'preproc_else',
    ]);

    const walk = (node: SyntaxNode) => {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child) continue;
        if (child.type === 'preproc_def' || child.type === 'preproc_function_def') {
          const nameNode = child.childForFieldName?.('name') ?? null;
          if (nameNode) {
            this.fileMacroNames.add(nameNode.text);
          }
        } else if (preprocContainers.has(child.type)) {
          walk(child);
        }
      }
    };

    walk(this.tree.rootNode);

    // Merge project-wide macro names collected by the orchestrator's
    // pre-scan. This catches macros defined in other files (via #include)
    // that tree-sitter can't see in this file's AST — without it, a macro
    // invocation MACRO(args){body} in file B, where the macro is defined
    // in header A, would produce a spurious function node in file B.
    if (this.globalMacroNames) {
      for (const name of this.globalMacroNames) {
        this.fileMacroNames.add(name);
      }
    }
  }

  /**
   * Extract a `#define` macro as a graph node.
   *
   * Handles both object-like macros (`#define FOO 42`) and function-like
   * macros (`#define MAX(a,b) ((a)>(b)?(a):(b))`). The macro name is
   * read from the `name` field, and the full `#define` text is stored
   * as the signature for searchability and display.
   */
  private extractMacro(node: SyntaxNode): void {
    if (!this.extractor) return;

    const nameNode = getChildByField(node, 'name');
    if (!nameNode) return;
    const name = getNodeText(nameNode, this.source);
    if (!name) return;

    const signature = this.source.substring(node.startIndex, node.endIndex);

    this.createNode('macro', name, node, {
      signature,
      isExported: true,
    });
  }

  /**
   * Find a `packageTypes` child under the root, create a `namespace` node
   * for it, and return its id so the caller can scope top-level
   * declarations underneath. Returns null when no package header is
   * present (script files, .kts without a package).
   */
  private extractFilePackage(rootNode: SyntaxNode): string | null {
    const types = this.extractor?.packageTypes;
    if (!types || types.length === 0 || !this.extractor?.extractPackage) return null;

    let pkgNode: SyntaxNode | null = null;
    for (let i = 0; i < rootNode.namedChildCount; i++) {
      const child = rootNode.namedChild(i);
      if (child && types.includes(child.type)) {
        pkgNode = child;
        break;
      }
    }
    if (!pkgNode) return null;

    const pkgName = this.extractor.extractPackage(pkgNode, this.source);
    if (!pkgName) return null;

    const ns = this.createNode('namespace', pkgName, pkgNode);
    return ns?.id ?? null;
  }

  /**
   * Build qualified name from node stack
   */
  private buildQualifiedName(name: string): string {
    // Build a qualified name from the semantic hierarchy only (no file path).
    // The file path is stored separately in filePath and pollutes FTS if included here.
    // The innermost semantic parent's qualifiedName already contains every
    // outer scope. Reusing it also preserves an explicitly-qualified nested
    // type definition such as `class Outer::Inner`, whose simple node name is
    // only `Inner`.
    for (let i = this.nodeStack.length - 1; i >= 0; i--) {
      const node = this.nodes.find((n) => n.id === this.nodeStack[i]);
      if (node && node.kind !== 'file') {
        return `${node.qualifiedName}::${name}`;
      }
    }
    return name;
  }

  /**
   * Build an ExtractorContext for passing to language-specific visitNode hooks.
   */
  private makeExtractorContext(): ExtractorContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      createNode: (kind, name, node, extra) => self.createNode(kind, name, node, extra),
      visitNode: (node) => self.visitNode(node),
      visitFunctionBody: (body, functionId) => self.visitFunctionBody(body, functionId),
      addUnresolvedReference: (ref) => self.unresolvedReferences.push(ref),
      pushScope: (nodeId) => self.nodeStack.push(nodeId),
      popScope: () => self.nodeStack.pop(),
      get filePath() { return self.filePath; },
      get source() { return self.source; },
      get nodeStack() { return self.nodeStack; },
      get nodes() { return self.nodes; },
    };
  }

  /**
   * Check if the current node stack indicates we are inside a class-like node
   * (class, struct, interface, trait). File nodes do not count as class-like.
   */
  private isInsideClassLikeNode(): boolean {
    if (this.nodeStack.length === 0) return false;
    const parentId = this.nodeStack[this.nodeStack.length - 1];
    if (!parentId) return false;
    const parentNode = this.nodes.find((n) => n.id === parentId);
    if (!parentNode) return false;
    return (
      parentNode.kind === 'class' ||
      parentNode.kind === 'struct' ||
      parentNode.kind === 'interface' ||
      parentNode.kind === 'trait' ||
      parentNode.kind === 'enum' ||
      parentNode.kind === 'module'
    );
  }

  /**
   * Check if the current node stack indicates we are inside a function-like
   * node (function or method). Used to prevent local variable extraction
   * when a declaration node sits inside a recognized function body.
   */
  private isInsideFunctionNode(): boolean {
    if (this.nodeStack.length === 0) return false;
    return this.nodeStack.some((id) => {
      const node = this.nodes.find((n) => n.id === id);
      return node?.kind === 'function' || node?.kind === 'method';
    });
  }

  /**
   * Check if a declaration node is a local variable inside an orphaned
   * compound_statement (a function body whose enclosing function_definition
   * tree-sitter failed to parse).  K&R-style C, cpp macros, and Google Test
   * macros routinely produce compound_statements at translation_unit level;
   * their declarations are locals and must not be extracted as global vars.
   *
   * We guard |this.language| so we never affect block-scoped `let` / `const`
   * in JS/TS/Go/Rust — those languages enter declarations through
   * language-specific branches that are already correct.
   */
  private isInsideCompoundStatement(node: SyntaxNode): boolean {
    if (
      this.language !== 'c' &&
      this.language !== 'cpp' &&
      this.language !== 'objc'
    ) {
      return false;
    }
    // Walk up one level: is the declaration directly inside a compound_statement?
    // compound_statement is always a block { … } — its declarations are locals.
    let parent: SyntaxNode | null = node.parent;
    while (parent) {
      if (parent.type === 'compound_statement') return true;
      // Stop at file-level containers; a declaration whose nearest enclosing
      // scope is a namespace / class / translation_unit is genuinely top-level.
      if (
        parent.type === 'translation_unit' ||
        parent.type === 'namespace_definition' ||
        parent.type === 'class_specifier' ||
        parent.type === 'struct_specifier' ||
        parent.type === 'enum_specifier'
      ) {
        return false;
      }
      parent = parent.parent;
    }
    return false;
  }

  /**
   * C/C++: recognize the spurious FIRST half of a split-prototype misparse.
   *
   * When a function prototype of the form `<TYPE1> <TYPE2> *name(args);` has
   * leading type macros that are neither in the project's global `#define`
   * set (so `preprocessStatementMacros` leaves them in place) nor recognized
   * types, tree-sitter-c can't commit to a declaration parse and splits the
   * line into:
   *
   *   (declaration type:(type_identifier) declarator:(identifier) (MISSING ";"))
   *   (expression_statement (pointer_expression (call_expression name args)))
   *
   * The first node is this broken declaration — the first type macro becomes
   * a `type_identifier`, the second a bare `identifier` "variable", and the
   * terminator is a MISSING ";". The real function name lives in the
   * `call_expression` of the following `expression_statement` and would be
   * lost without rescue. See `rescueSplitPrototypeExprStmt`.
   *
   * The MISSING ";" is the hallmark: a real declaration never lacks its
   * terminator, so this never matches a legitimate variable.
   */
  private isBrokenTypeSplitDeclaration(node: SyntaxNode | null): boolean {
    if (!node || node.type !== 'declaration') return false;
    let hasTypeIdentifier = false;
    let hasBareIdentifierDeclarator = false;
    for (const c of node.namedChildren) {
      if (c.type === 'type_identifier') hasTypeIdentifier = true;
      else if (c.type === 'identifier') hasBareIdentifierDeclarator = true;
    }
    if (!hasTypeIdentifier || !hasBareIdentifierDeclarator) return false;
    return node.children.some((c) => c.isMissing && c.type === ';');
  }

  /**
   * C/C++: recover a typedef enum split by an unresolved statement wrapper.
   *
   * tree-sitter parses `WRAPPER\ntypedef enum { ... } Alias;` as two sibling
   * declarations when WRAPPER is unknown:
   *
   *   declaration(type_identifier: WRAPPER, identifier: typedef, MISSING ';')
   *   declaration(type: enum_specifier, declarator: Alias, ';')
   *
   * The enum_specifier and its enumerators are intact. Return them only when
   * the preceding broken declaration's declarator is literally `typedef`, so
   * ordinary anonymous-enum variables cannot be reclassified as type aliases.
   */
  private getSplitTypedefEnumDeclaration(node: SyntaxNode | null): {
    prefixNode: SyntaxNode;
    enumNode: SyntaxNode;
    alias: string;
  } | null {
    if (!node || node.type !== 'declaration' || !this.extractor) return null;

    const prefixNode = node.previousNamedSibling;
    if (!prefixNode || !this.isBrokenTypeSplitDeclaration(prefixNode)) return null;

    const prefixDeclarator = getChildByField(prefixNode, 'declarator');
    if (!prefixDeclarator || getNodeText(prefixDeclarator, this.source) !== 'typedef') return null;

    const enumNode = getChildByField(node, 'type');
    if (!enumNode || !this.extractor.enumTypes.includes(enumNode.type)) return null;
    const body = this.extractor.resolveBody?.(enumNode, this.extractor.bodyField)
      ?? getChildByField(enumNode, this.extractor.bodyField);
    if (!body) return null;

    const aliasNode = getChildByField(node, 'declarator');
    if (!aliasNode || (aliasNode.type !== 'identifier' && aliasNode.type !== 'type_identifier')) {
      return null;
    }
    const alias = getNodeText(aliasNode, this.source);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) return null;

    const hasRealTerminator = node.children.some((child) => child.type === ';' && !child.isMissing);
    if (!hasRealTerminator) return null;

    return { prefixNode, enumNode, alias };
  }

  /**
   * C/C++: detect the SECOND half of the split-prototype misparse — an
   * `expression_statement` at translation_unit / namespace scope whose single
   * expression is `*name(args)`, i.e. a `pointer_expression` wrapping a
   * `call_expression` whose function is a plain (non-keyword) `identifier`
   * with an `argument_list`. Returns the function name when this node is the
   * rescue target, else null. The caller has already gated scope (not inside
   * class / function / compound).
   *
   * An `expression_statement` at file/namespace scope is never valid C/C++ —
   * it is always tree-sitter error recovery — so this pattern is specific to
   * the misparse.
   */
  private rescueSplitPrototypeExprStmt(node: SyntaxNode | null): string | null {
    if (!node || node.type !== 'expression_statement') return null;
    const inner = node.namedChild(0);
    if (inner?.type !== 'pointer_expression') return null;
    const call = inner.namedChild(0);
    if (call?.type !== 'call_expression') return null;
    const fn = call.namedChild(0);
    const argList = call.namedChild(1);
    if (fn?.type !== 'identifier' || argList?.type !== 'argument_list') return null;
    const name = getNodeText(fn, this.source);
    if (!name || C_CPP_KEYWORD_NAMES.has(name)) return null;
    return name;
  }

  /**
   * C/C++: detect the SECOND half of the pointer-variable-init split misparse
   * — an `expression_statement` at translation_unit / namespace scope whose
   * single expression is `*id = init`, i.e. an `assignment_expression` whose
   * left is a `pointer_expression` over a bare `identifier`. This is the
   * counterpart to the assignment_expression rescue in the expression_statement
   * branch above: when a leading visibility/type macro is not in the project
   * `#define` set, tree-sitter-c splits `MACRO TYPE *g_ptr = init;` into a
   * spurious `(declaration MACRO TYPE (MISSING ";"))` + this
   * `expression_statement(*g_ptr = init)`. Returns the pointer variable name
   * when this node is the rescue target, else null. The caller has already
   * gated scope (not inside class / function / compound).
   *
   * Used to suppress the spurious leading declaration (so the type name, e.g.
   * `BsiKmcServiceApis`, is not emitted as a bogus variable) — the
   * expression_statement branch above performs the actual variable rescue.
   * Only a bare-identifier operand matches, excluding `*id[idx]` /
   * `*id.field` / `*name(args)` (the last is the split-prototype form handled
   * by rescueSplitPrototypeExprStmt). An expression_statement at file/namespace
   * scope is never valid C/C++ — always error recovery — so this never traps
   * real code.
   */
  private rescuePointerInitExprStmtName(node: SyntaxNode | null): string | null {
    if (!node || node.type !== 'expression_statement') return null;
    const inner = node.namedChild(0);
    if (inner?.type !== 'assignment_expression') return null;
    const left = inner.namedChild(0);
    if (left?.type !== 'pointer_expression') return null;
    const operand = left.namedChild(0);
    if (operand?.type !== 'identifier') return null;
    const name = getNodeText(operand, this.source);
    if (!name || C_CPP_KEYWORD_NAMES.has(name)) return null;
    return name;
  }

  /**
   * Extract a function
   */
  private extractFunction(node: SyntaxNode, nameOverride?: string): void {
    if (!this.extractor) return;

    // If the language provides getReceiverType and this function has a receiver
    // (e.g., Rust function_item inside an impl block), extract as method instead
    if (this.extractor.getReceiverType?.(node, this.source)) {
      this.extractMethod(node);
      return;
    }

    // nameOverride is supplied only for explicitly-named anonymous functions the
    // caller resolved itself (e.g. arrow values of exported-const object members
    // — SvelteKit actions). Inline-object arrows reached by the general walker
    // get no override, so they still fall through to the <anonymous> skip below.
    let name = nameOverride ?? extractName(node, this.source, this.extractor);
    // For arrow functions and function expressions assigned to variables,
    // resolve the name from the parent variable_declarator.
    // e.g. `export const useAuth = () => { ... }` — the arrow_function node
    // has no `name` field; the name lives on the variable_declarator.
    if (
      !nameOverride &&
      name === '<anonymous>' &&
      (node.type === 'arrow_function' || node.type === 'function_expression')
    ) {
      const parent = node.parent;
      if (parent?.type === 'variable_declarator') {
        const varName = getChildByField(parent, 'name');
        if (varName) {
          name = getNodeText(varName, this.source);
        }
      }
    }
    if (this.language === 'cpp') name = normalizeCppCallableName(name);
    if (name === '<anonymous>') {
      // Don't emit a node for the anonymous wrapper itself, but still visit its
      // body: AMD/RequireJS and CommonJS module wrappers (`define([], function(){…})`,
      // `(function(){…})()`) hold named inner functions and calls that would
      // otherwise be lost — the dispatcher set skipChildren, so nothing else
      // descends into this subtree. (#528)
      const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
        ?? getChildByField(node, this.extractor.bodyField);
      if (body) {
        this.visitFunctionBody(body, '');
      }
      return;
    }

    // Check for misparse artifacts (e.g. C++ macros causing "namespace detail" functions)
    // Skip the node but still visit the body for calls and structural nodes
    if (this.extractor.isMisparsedFunction?.(name, node, this.fileMacroNames)) {
      const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
        ?? getChildByField(node, this.extractor.bodyField);
      if (body) {
        this.visitFunctionBody(body, '');
      }
      return;
    }

    const docstring = getPrecedingDocstring(node, this.source);
    const signature = this.extractor.getSignature?.(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isExported = this.extractor.isExported?.(node, this.source);
    const isAsync = this.extractor.isAsync?.(node);
    const isStatic = this.extractor.isStatic?.(node);
    const returnType = this.extractor.getReturnType?.(node, this.source);

    const funcNode = this.createNode('function', name, node, {
      docstring,
      signature,
      visibility,
      isExported,
      isAsync,
      isStatic,
      returnType,
    });
    if (!funcNode) return;

    // Extract type annotations (parameter types and return type)
    this.extractTypeAnnotations(node, funcNode.id);

    // Extract decorators applied to the function (rare in JS/TS but
    // present in Python `@decorator def f():` and Java/Kotlin
    // annotations on free functions).
    this.extractDecoratorsFor(node, funcNode.id);

    // Collect parameter names into currentLocalNames before visiting the
    // body. Local variable names are collected incrementally during the
    // visitFunctionBody traversal itself (when declaration nodes are
    // encountered). Only needed for C/C++ — other languages don't emit
    // global-var references from function bodies.
    if (this.language === 'c' || this.language === 'cpp') {
      this.currentLocalNames.clear();
      // C/C++: parameters live inside function_declarator, not directly on
      // function_definition. Unwrap: function_definition → declarator →
      // parameters → parameter_declaration → declarator → identifier.
      const funcDecl = getChildByField(node, this.extractor.nameField);
      const params = funcDecl ? getChildByField(funcDecl, this.extractor.paramsField) : null;
      if (params) {
        for (let i = 0; i < params.namedChildCount; i++) {
          const param = params.namedChild(i);
          if (!param) continue;
          const d = getChildByField(param, 'declarator');
          if (d) {
            const name = this.extractVarNameFromDeclarator(d);
            if (name) this.currentLocalNames.add(name);
          }
        }
      }
    }

    // Push to stack and visit body
    this.nodeStack.push(funcNode.id);
    const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    if (body) {
      // Layer 1: Detect body leakage from C preprocessor misparse.
      // When tree-sitter encounters unrecognized macros inside a function,
      // the compound_statement boundary breaks and swallows subsequent
      // file-level declarations. Look for node types that cannot
      // legitimately appear as first-level body children in C/C++.
      if (this.language === 'c' || this.language === 'cpp') {
        let firstLeakIndex = -1;
        for (let i = 0; i < body.namedChildCount; i++) {
          const child = body.namedChild(i);
          if (child && C_CPP_BODY_LEAK_TYPES.has(child.type)) {
            firstLeakIndex = i;
            break;
          }
        }

        if (firstLeakIndex >= 0) {
          // Collect names from leaked declarations so visitFunctionBody
          // can exclude them from currentLocalNames (they're globals).
          const leakedGlobalNames = new Set<string>();
          const preVisitedNodes = new Set<number>();

          this.nodeStack.pop(); // remove funcNode — process at file scope

          for (let i = firstLeakIndex; i < body.namedChildCount; i++) {
            const child = body.namedChild(i);
            if (!child) continue;
            if (
              child.type === 'declaration' ||
              C_CPP_BODY_LEAK_TYPES.has(child.type)
            ) {
              if (child.type === 'declaration') {
                for (let j = 0; j < child.namedChildCount; j++) {
                  const decl = child.namedChild(j);
                  if (!decl) continue;
                  const vn = this.extractVarNameFromDeclarator(decl);
                  if (vn) leakedGlobalNames.add(vn);
                }
              }
              preVisitedNodes.add(child.startIndex);
              this.visitNode(child);
            }
          }

          this.nodeStack.push(funcNode.id); // restore func scope
          this.visitFunctionBody(body, funcNode.id, leakedGlobalNames, preVisitedNodes);
        } else {
          this.visitFunctionBody(body, funcNode.id);
        }
      } else {
        this.visitFunctionBody(body, funcNode.id);
      }
    }
    this.currentLocalNames.clear();
    this.nodeStack.pop();
  }

  /** True only for a directly-written C/C++ forward declaration. */
  private isExplicitCppForwardDeclaration(node: SyntaxNode): boolean {
    if (this.language !== 'c' && this.language !== 'cpp') return false;
    if (getChildByField(node, this.extractor?.bodyField ?? 'body')) return false;
    const parent = node.parent;
    if (!parent) return false;

    // tree-sitter-cpp represents `class Foo;`, `struct S;`, and a forward enum
    // as a bare specifier directly under the translation unit/class body; the
    // terminating semicolon is an unnamed sibling rather than a declaration
    // wrapper. Check the source byte immediately after the specifier.
    const isDirectDeclarationContainer = parent.type === 'translation_unit'
      || parent.type === 'field_declaration_list'
      || parent.type === 'declaration_list'
      || parent.type === 'template_declaration'
      // Header guards and conditional-compilation branches are transparent
      // declaration containers in C/C++. Their children are still directly
      // written declarations, not elaborated type uses.
      || parent.type === 'preproc_if'
      || parent.type === 'preproc_ifdef'
      || parent.type === 'preproc_else'
      || parent.type === 'preproc_elif';
    if (isDirectDeclarationContainer) {
      return /^\s*;/.test(this.source.slice(node.endIndex));
    }
    if (parent.type !== 'declaration' && parent.type !== 'field_declaration') {
      return false;
    }

    // `struct S *value;` is an elaborated type use plus a declarator, not an
    // explicit `struct S;` declaration. A direct declarator field is the most
    // reliable discriminator; the named-child fallback covers grammar quirks.
    if (getChildByField(parent, 'declarator')) return false;
    const declaratorTypes = new Set([
      'identifier', 'field_identifier', 'init_declarator', 'pointer_declarator',
      'reference_declarator', 'array_declarator', 'function_declarator',
      'parenthesized_declarator',
    ]);
    for (const child of parent.namedChildren) {
      if (child.id !== node.id && declaratorTypes.has(child.type)) return false;
    }
    return getNodeText(parent, this.source).trimEnd().endsWith(';');
  }

  /** Extract `template class/struct Type<Args>;` and `extern template ...`. */
  private extractCppTemplateInstantiation(node: SyntaxNode): boolean {
    const typeNode = node.namedChildren.find(child =>
      child.type === 'class_specifier' || child.type === 'struct_specifier' || child.type === 'union_specifier');
    if (!typeNode) return false;
    const declared = getCppDeclaredTypeName(typeNode, this.source);
    if (!declared) return false;
    const name = declared.name;
    const kind: NodeKind = typeNode.type === 'class_specifier' ? 'class' : 'struct';
    const sourceText = getNodeText(node, this.source).trimStart();
    let qualifiedName: string | undefined;
    if (declared.qualifiedName) {
      const parts = declared.qualifiedName.split('::');
      parts[parts.length - 1] = name;
      qualifiedName = this.buildQualifiedName(parts.join('::'));
    }
    this.createNode(kind, name, node, {
      isDeclaration: sourceText.startsWith('extern template') || undefined,
      ...(qualifiedName ? { qualifiedName } : {}),
    });
    return true;
  }

  /** Extract forward type specifiers wrapped by a declaration node. */
  private extractExplicitForwardTypeDeclarations(node: SyntaxNode): boolean {
    let extracted = false;
    for (const child of node.namedChildren) {
      if ((child.type === 'class_specifier' || child.type === 'struct_specifier' || child.type === 'enum_specifier')
        && this.isExplicitCppForwardDeclaration(child)) {
        this.visitNode(child);
        extracted = true;
      }
    }
    return extracted;
  }

  /** Detect function declarations inside a C++ class body. */
  private isCppClassMemberFunctionDeclaration(node: SyntaxNode): boolean {
    if (this.language !== 'cpp' || node.type !== 'declaration' || !this.isInsideClassLikeNode()) {
      return false;
    }
    // Ordinary fields (including function pointers) use field_declaration.
    // Return-typed member templates instead use declaration below a
    // template_declaration and must be handled here as methods.
    return node.descendantsOfType('function_declarator').length > 0;
  }

  /**
   * Extract a class
   */
  private extractClass(node: SyntaxNode, kind: NodeKind = 'class'): void {
    if (!this.extractor) return;

    const name = extractName(node, this.source, this.extractor);
    let body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    const isCppLike = this.language === 'c' || this.language === 'cpp';
    const isForwardDeclaration = isCppLike && !body && this.isExplicitCppForwardDeclaration(node);
    if (isCppLike && !body && !isForwardDeclaration) return;
    const docstring = getPrecedingDocstring(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isExported = this.extractor.isExported?.(node, this.source);
    const declaredTypeName = this.language === 'cpp'
      ? getCppDeclaredTypeName(node, this.source)
      : null;
    const explicitQualifiedName = declaredTypeName?.qualifiedName
      ? this.buildQualifiedName(declaredTypeName.qualifiedName)
      : undefined;

    const classNode = this.createNode(kind, name, node, {
      docstring,
      visibility,
      isExported,
      isDeclaration: isForwardDeclaration || undefined,
      ...(explicitQualifiedName ? { qualifiedName: explicitQualifiedName } : {}),
    });
    if (!classNode) return;

    if (isForwardDeclaration) return;
    // Several non-C++ grammars model body-less records/classes directly on the
    // declaration node. Preserve the historical fallback for those languages.
    if (!body) body = node;

    // Extract extends/implements
    this.extractInheritance(node, classNode.id);

    // C# primary-constructor parameter dependencies (`class Svc(IRepo r, …)`).
    this.extractCsharpPrimaryCtorParamRefs(node, classNode.id);

    // Extract decorators applied to the class (`@Foo class X {}`).
    this.extractDecoratorsFor(node, classNode.id);

    // Push to stack and visit body
    this.nodeStack.push(classNode.id);
    // Visit all children for methods and properties
    for (let i = 0; i < body!.namedChildCount; i++) {
      const child = body!.namedChild(i);
      if (child) {
        this.visitNode(child);
      }
    }
    this.nodeStack.pop();
  }

  /**
   * Extract a method
   */
  private extractMethod(node: SyntaxNode, isDeclaration = false): void {
    if (!this.extractor) return;

    // For languages with receiver types (Go, Rust), include receiver in qualified name
    // so FTS can match "scrapeLoop.run" → qualified_name "...::scrapeLoop::run"
    const receiverType = this.extractor.getReceiverType?.(node, this.source);

    // For most languages, only extract as method if inside a class-like node
    // Languages with methodsAreTopLevel (e.g. Go) always treat them as methods
    // Languages with getReceiverType (e.g. Rust) extract as method when receiver is found
    if (!this.isInsideClassLikeNode() && !this.extractor.methodsAreTopLevel && !receiverType) {
      // Skip method_definition nodes inside object literals (getters/setters/methods
      // in inline objects). These are ephemeral and create noise (e.g., Svelte context
      // objects: `ctx.set({ get view() { ... } })`).
      if (node.parent?.type === 'object' || node.parent?.type === 'object_expression') {
        const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
          ?? getChildByField(node, this.extractor.bodyField);
        if (body) {
          this.visitFunctionBody(body, '');
        }
        return;
      }
      // Not inside a class-like node and no receiver type, treat as function
      this.extractFunction(node);
      return;
    }

    let name = extractName(node, this.source, this.extractor);
    if (this.language === 'cpp') {
      name = cppCallableDeclaratorName(node, this.source) ?? name;
      const enclosingNode = this.nodeStack.length > 0
        ? this.nodes.find(candidate => candidate.id === this.nodeStack[this.nodeStack.length - 1])
        : undefined;
      name = normalizeCppCallableName(name, receiverType ?? enclosingNode?.name);
    }

    // Check for misparse artifacts (e.g. C++ "switch" inside macro-confused class body)
    if (this.extractor.isMisparsedFunction?.(name, node, this.fileMacroNames)) {
      const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
        ?? getChildByField(node, this.extractor.bodyField);
      if (body) {
        this.visitFunctionBody(body, '');
      }
      return;
    }

    const docstring = getPrecedingDocstring(node, this.source);
    const signature = this.extractor.getSignature?.(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isAsync = this.extractor.isAsync?.(node);
    const isStatic = this.extractor.isStatic?.(node);
    const returnType = this.extractor.getReturnType?.(node, this.source);
    const extraProps: Partial<Node> = {
      docstring,
      signature,
      visibility,
      isAsync,
      isStatic,
      returnType,
      isDeclaration: isDeclaration || undefined,
    };
    if (receiverType) {
      extraProps.qualifiedName = `${receiverType}::${name}`;
    }

    const methodNode = this.createNode('method', name, node, extraProps);
    if (!methodNode) return;

    // For methods with a receiver type but no class-like parent on the stack
    // (e.g., Rust impl blocks), add a contains edge from the owning struct/trait
    if (receiverType && !this.isInsideClassLikeNode()) {
      const ownerNode = this.nodes.find(
        (n) =>
          n.name === receiverType &&
          n.filePath === this.filePath &&
          (n.kind === 'struct' || n.kind === 'class' || n.kind === 'enum' || n.kind === 'trait')
      );
      if (ownerNode) {
        this.edges.push({
          source: ownerNode.id,
          target: methodNode.id,
          kind: 'contains',
        });
      }
    }

    // Extract type annotations (parameter types and return type)
    this.extractTypeAnnotations(node, methodNode.id);

    // Extract decorators (`@Get('/list') list() {}`).
    this.extractDecoratorsFor(node, methodNode.id);

    // Push to stack and visit body
    this.nodeStack.push(methodNode.id);
    const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    if (body) {
      this.visitFunctionBody(body, methodNode.id);
    }
    this.nodeStack.pop();
  }

  /**
   * Extract an interface/protocol/trait
   */
  private extractInterface(node: SyntaxNode): void {
    if (!this.extractor) return;

    const name = extractName(node, this.source, this.extractor);
    const docstring = getPrecedingDocstring(node, this.source);
    const isExported = this.extractor.isExported?.(node, this.source);

    const kind: NodeKind = this.extractor.interfaceKind ?? 'interface';

    const interfaceNode = this.createNode(kind, name, node, {
      docstring,
      isExported,
    });
    if (!interfaceNode) return;

    // Extract extends (interface inheritance)
    this.extractInheritance(node, interfaceNode.id);

    // Visit body children for interface methods and nested types
    this.nodeStack.push(interfaceNode.id);
    let body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    if (!body) body = node;
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (child) {
        this.visitNode(child);
      }
    }
    this.nodeStack.pop();
  }

  /**
   * Extract a struct
   */
  private extractStruct(node: SyntaxNode): void {
    if (!this.extractor) return;

    const body = getChildByField(node, this.extractor.bodyField);
    const isForwardDeclaration = !body && this.isExplicitCppForwardDeclaration(node);
    if (!body && !isForwardDeclaration) return;

    const rawName = extractName(node, this.source, this.extractor);
    const anonymousName = (this.language === 'c' || this.language === 'cpp')
      ? anonymousCppTypeName(node)
      : null;
    const name = anonymousName ?? rawName;
    const docstring = getPrecedingDocstring(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isExported = this.extractor.isExported?.(node, this.source);
    const declaredTypeName = (this.language === 'c' || this.language === 'cpp')
      ? getCppDeclaredTypeName(node, this.source)
      : null;
    const explicitQualifiedName = declaredTypeName?.qualifiedName
      ? this.buildQualifiedName(declaredTypeName.qualifiedName)
      : undefined;

    const structNode = this.createNode('struct', name, node, {
      docstring,
      visibility,
      isExported,
      isDeclaration: isForwardDeclaration || undefined,
      ...(explicitQualifiedName ? { qualifiedName: explicitQualifiedName } : {}),
    });
    if (isForwardDeclaration) return;
    // Anonymous struct (no name -> createNode returned null). Still walk the
    // body so the fields are extracted; their contains edge points to the
    // enclosing scope (C++ anonymous-struct fields inject into the outer
    // scope), so we deliberately do NOT push onto nodeStack here.
    if (structNode && !anonymousName) {
      // Extract inheritance (e.g. Swift: struct HTTPMethod: RawRepresentable)
      this.extractInheritance(node, structNode.id);

      // C# primary-constructor parameter dependencies (`struct P(int x)`, and
      // `record struct M(decimal Amount)` which the grammar nests here).
      this.extractCsharpPrimaryCtorParamRefs(node, structNode.id);

      // Push to stack for field extraction
      this.nodeStack.push(structNode.id);
    }
    for (let i = 0; i < body!.namedChildCount; i++) {
      const child = body!.namedChild(i);
      if (child) {
        this.visitNode(child);
      }
    }
    if (structNode && !anonymousName) this.nodeStack.pop();
  }

  /**
   * Extract an enum
   */
  private extractEnum(node: SyntaxNode, nameOverride?: string): void {
    if (!this.extractor) return;

    const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    const isForwardDeclaration = !body && this.isExplicitCppForwardDeclaration(node);
    if (!body && !isForwardDeclaration) return;

    const anonymousName = !nameOverride && (this.language === 'c' || this.language === 'cpp')
      ? anonymousCppTypeName(node)
      : null;
    const name = nameOverride ?? anonymousName ?? extractName(node, this.source, this.extractor);
    const docstring = getPrecedingDocstring(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isExported = this.extractor.isExported?.(node, this.source);
    const declaredTypeName = (this.language === 'c' || this.language === 'cpp')
      ? getCppDeclaredTypeName(node, this.source)
      : null;
    const explicitQualifiedName = declaredTypeName?.qualifiedName
      ? this.buildQualifiedName(declaredTypeName.qualifiedName)
      : undefined;

    const enumNode = this.createNode('enum', name, node, {
      docstring,
      visibility,
      isExported,
      isDeclaration: isForwardDeclaration || undefined,
      ...(explicitQualifiedName ? { qualifiedName: explicitQualifiedName } : {}),
    });
    if (isForwardDeclaration) return;

    // Anonymous enum (no name → createNode returned null). Still walk the body
    // so the enumerators are extracted; their contains edge points to the
    // enclosing scope (C++ anonymous-enum members inject into the outer
    // scope), so we deliberately do NOT push onto nodeStack here.
    if (enumNode && !anonymousName) {
      // Extract inheritance (e.g. Swift: enum AFError: Error)
      this.extractInheritance(node, enumNode.id);

      // Push to stack and visit body children (enum members, nested types, methods)
      this.nodeStack.push(enumNode.id);
    }

    const memberTypes = this.extractor.enumMemberTypes;
    for (let i = 0; i < body!.namedChildCount; i++) {
      const child = body!.namedChild(i);
      if (!child) continue;

      if (memberTypes?.includes(child.type)) {
        this.extractEnumMembers(child);
      } else {
        this.visitNode(child);
      }
    }

    if (enumNode && !anonymousName && this.xMacroConstructs.length > 0) {
      const constructs = this.xMacroConstructs.filter((construct) =>
        construct.enumBodyStart === body!.startIndex && construct.enumBodyEnd === body!.endIndex);
      if (constructs.length > 0) {
        const existingMemberNames = new Set<string>();
        const childIds = new Set(
          this.edges
            .filter((edge) => edge.kind === 'contains' && edge.source === enumNode.id)
            .map((edge) => edge.target),
        );
        for (const extractedNode of this.nodes) {
          if (extractedNode.kind === 'enum_member' && childIds.has(extractedNode.id)) {
            existingMemberNames.add(extractedNode.name);
          }
        }

        for (const construct of constructs) {
          for (const call of construct.calls) {
            if (existingMemberNames.has(call.name)) continue;
            this.createSyntheticNode(
              'enum_member',
              call.name,
              call.line,
              call.column,
              call.column + construct.macroName.length,
              {
                signature: call.invocation,
                docstring: `Recovered from self-including X-macro ${construct.macroName}`,
              },
              enumNode.id,
            );
            existingMemberNames.add(call.name);
          }
        }
      }
    }
    if (enumNode && !anonymousName) this.nodeStack.pop();
  }

  /**
   * Extract enum member names from an enum member node.
   * Handles multi-case declarations (Swift: `case put, delete`) and single-case patterns.
   */
  private extractEnumMembers(node: SyntaxNode): void {
    // Try field-based name first (e.g. Rust enum_variant has a 'name' field)
    const nameNode = getChildByField(node, 'name');
    if (nameNode) {
      this.createNode('enum_member', getNodeText(nameNode, this.source), node);
      return;
    }

    // Check for identifier-like children (Swift: simple_identifier, TS: property_identifier)
    let found = false;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && (child.type === 'simple_identifier' || child.type === 'identifier' || child.type === 'property_identifier')) {
        this.createNode('enum_member', getNodeText(child, this.source), child);
        found = true;
      }
    }

    // If the node itself IS the identifier (e.g. TS property_identifier directly in enum body)
    if (!found && node.namedChildCount === 0) {
      this.createNode('enum_member', getNodeText(node, this.source), node);
    }
  }

  /**
   * Extract a class property declaration (e.g. C# `public string Name { get; set; }`).
   * Extracts as 'property' kind node inside the owning class.
   */
  private extractProperty(node: SyntaxNode): void {
    if (!this.extractor) return;

    const docstring = getPrecedingDocstring(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isStatic = this.extractor.isStatic?.(node) ?? false;

    const hookName = this.extractor.extractPropertyName?.(node, this.source);
    const nameNode = hookName
      ? null
      : getChildByField(node, 'name') || node.namedChildren.find(c => c.type === 'identifier');
    const name = hookName ?? (nameNode ? getNodeText(nameNode, this.source) : null);
    if (!name) return;

    // Get property type from the type child (first named child that isn't modifier or identifier)
    const typeNode = node.namedChildren.find(
      c => c.type !== 'modifier' && c.type !== 'modifiers'
        && c.type !== 'identifier' && c.type !== 'accessor_list'
        && c.type !== 'accessors' && c.type !== 'equals_value_clause'
    );
    const typeText = typeNode ? getNodeText(typeNode, this.source) : undefined;
    const signature = typeText ? `${typeText} ${name}` : name;

    const propNode = this.createNode('property', name, node, {
      docstring,
      signature,
      visibility,
      isStatic,
    });

    // `@Inject() private svc: Foo` and similar — capture the
    // decorator->target relationship for class properties too.
    if (propNode) {
      this.extractDecoratorsFor(node, propNode.id);
      // Emit `references` edges from the property to types named in its
      // type annotation (#381). The generic walker handles TS-style
      // `type_annotation` children; the C# branch walks the `type` field.
      this.extractTypeAnnotations(node, propNode.id);
    }
  }

  /**
   * Extract a class field declaration (e.g. Java field_declaration, C# field_declaration).
   * Extracts each declarator as a 'field' kind node inside the owning class.
   */
  private extractField(node: SyntaxNode): void {
    if (!this.extractor) return;

    const docstring = getPrecedingDocstring(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isStatic = this.extractor.isStatic?.(node) ?? false;

    // C/C++: a field_declaration inside a class/struct body may wrap a type
    // definition (enum/struct/class) WITHOUT a trailing declarator — e.g.
    //   class C { public: enum E { A, B }; };
    // tree-sitter-cpp parses this as a field_declaration whose named child is
    // an enum_specifier/struct_specifier/class_specifier (the "type"), with NO
    // declarator. extractField normally only extracts declarators (methods/
    // fields) and silently drops the wrapped type definition along with all
    // its members (the root cause of enum_member 74% under-indexing on
    // OceanBase: class-internal enums were never visited). Descend into the
    // type-specifier child so extractEnum/extractStruct/extractClass can pick
    // it up. This runs BEFORE declarator handling so both the type definition
    // AND any trailing declarator (e.g. `enum E { A, B } e;` → enum E + field e)
    // get extracted. The `body` guard skips forward declarations like
    // `class Foo;` (no body) — extractClass would otherwise treat the
    // specifier itself as its body and emit garbage children.
    if (this.language === 'c' || this.language === 'cpp') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child) continue;
        const t = child.type;
        if (t === 'enum_specifier' || t === 'struct_specifier'
          || t === 'union_specifier' || t === 'class_specifier') {
          this.visitNode(child);
        }
      }
    }

    // Java field_declaration: "private final String name = value;" → variable_declarator(s) are direct children
    // C# field_declaration: wraps in variable_declaration → variable_declarator(s)
    let declarators = node.namedChildren.filter(
      c => c.type === 'variable_declarator'
    );
    // C#: look inside variable_declaration wrapper
    if (declarators.length === 0) {
      const varDecl = node.namedChildren.find(c => c.type === 'variable_declaration');
      if (varDecl) {
        declarators = varDecl.namedChildren.filter(c => c.type === 'variable_declarator');
      }
    }

    // PHP property_declaration: property_element → variable_name → name
    if (declarators.length === 0) {
      const propElements = node.namedChildren.filter(c => c.type === 'property_element');
      if (propElements.length > 0) {
        // Get type annotation if present (e.g. "string", "int", "?Foo")
        const typeNode = node.namedChildren.find(
          c => c.type !== 'visibility_modifier' && c.type !== 'static_modifier'
            && c.type !== 'readonly_modifier' && c.type !== 'property_element'
            && c.type !== 'var_modifier'
        );
        const typeText = typeNode ? getNodeText(typeNode, this.source) : undefined;

        for (const elem of propElements) {
          const varName = elem.namedChildren.find(c => c.type === 'variable_name');
          const nameNode = varName?.namedChildren.find(c => c.type === 'name');
          if (!nameNode) continue;
          const name = getNodeText(nameNode, this.source);
          const signature = typeText ? `${typeText} $${name}` : `$${name}`;
          this.createNode('field', name, elem, {
            docstring,
            signature,
            visibility,
            isStatic,
          });
        }
        return;
      }
    }

    // C/C++ field_declaration: `struct S { int x, *p; };` → field_identifier(s)
    // Declarators may be wrapped in pointer_declarator / array_declarator.
    // Multiple field_identifiers can appear as siblings (comma-separated).
    if (declarators.length === 0 && (this.language === 'c' || this.language === 'cpp')) {
      // A member function declaration inside a class (`void bar();`) is parsed
      // by tree-sitter-cpp as a field_declaration with a function_declarator as
      // its declarator. Extract it as a method node so it can be paired with
      // its out-of-line .cpp definition by the decl-def synthesizer. Without
      // this the declaration is dropped and only the .cpp definition exists.
      const fnDeclField = getChildByField(node, 'declarator');
      // Unwrap pointer/reference declarators first: a reference-return member
      // declaration (`static T& instance();`) is wrapped as
      // reference_declarator → function_declarator → field_identifier, so the raw
      // declarator field is a reference_declarator, not a function_declarator.
      let fnDecl = fnDeclField;
      while (fnDecl && (fnDecl.type === 'pointer_declarator' || fnDecl.type === 'reference_declarator')) {
        fnDecl = getChildByField(fnDecl, 'declarator') || fnDecl.namedChild(0) || null;
      }
      if (fnDecl && fnDecl.type === 'function_declarator') {
        // A function/member-function pointer field has the same outer
        // function_declarator as a method prototype, but its identifier is
        // nested below pointer_declarator: `R (*cb)(A)` / `R (C::*cb)(A)`.
        // Keep it a field instead of emitting a bogus method.
        const pointerField = fnDecl.descendantsOfType('field_identifier').find(field => {
          let current = field.parent;
          while (current && current.id !== fnDecl!.id) {
            if (current.type === 'pointer_declarator') return true;
            current = current.parent;
          }
          return false;
        });
        if (pointerField) {
          const name = getNodeText(pointerField, this.source);
          const typeNode = getChildByField(node, 'type');
          const typeText = typeNode ? getNodeText(typeNode, this.source) : undefined;
          this.createNode('field', name, pointerField, {
            docstring,
            signature: typeText ? `${typeText} ${name}` : name,
            visibility,
            isStatic,
          });
          return;
        }
        let innerDecl = getChildByField(fnDecl, 'declarator');
        if (!innerDecl) {
          innerDecl = fnDecl.namedChildren.find(c => c.type === 'field_identifier') ?? null;
        }
        if (innerDecl) {
          let idNode: SyntaxNode | null = innerDecl;
          // Unwrap parenthesized_declarator (function-pointer field
          // `T (*cb)(void)` → parenthesized_declarator wraps a
          // pointer_declarator) in addition to pointer/reference, so we land on
          // the field_identifier `cb` instead of naming the node `(*cb)`.
          while (idNode && (idNode.type === 'pointer_declarator' || idNode.type === 'reference_declarator' || idNode.type === 'parenthesized_declarator')) {
            idNode = getChildByField(idNode, 'declarator') || idNode.namedChild(0) || null;
          }
          if (idNode) {
            const rawFnName = getNodeText(idNode, this.source);
            const fnName = this.language === 'cpp'
              ? normalizeCppCallableName(rawFnName)
              : rawFnName;
            if (fnName) {
              const returnType = this.extractor.getReturnType?.(node, this.source);
              const signature = this.extractor.getSignature?.(node, this.source);
              this.createNode('method', fnName, node, {
                docstring,
                visibility,
                isStatic,
                returnType,
                signature,
                isDeclaration: true,
              });
              return;
            }
          }
        }
      }

      const fieldEntries: Array<{ name: string; posNode: SyntaxNode }> = [];
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child) continue;
        // Unwrap pointer/array/reference declarators to reach the field_identifier.
        // A reference data member (`std::vector<int>& ref_member;`) is wrapped as
        // reference_declarator → field_identifier; without unwrapping it the field
        // is dropped (OceanBase `columns_` regression).
        let current: SyntaxNode | null = child;
        while (current && (current.type === 'pointer_declarator' || current.type === 'array_declarator' || current.type === 'reference_declarator')) {
          const inner: SyntaxNode | null = getChildByField(current, 'declarator') || current.namedChild(0) || null;
          current = inner;
        }
        if (current && current.type === 'field_identifier') {
          fieldEntries.push({ name: getNodeText(current, this.source), posNode: current });
        }
        // C/C++ struct field macro member: a macro on its own line inside a
        // struct/class body (e.g. `typedef struct { VOS_MSG_HEADER; BBRF_MSG_HEADER; ... }`)
        // is parsed by tree-sitter as a field_declaration whose `type` is the
        // macro name (a type_identifier) — the macro member was mistaken for
        // the field's type, with the NEXT macro member becoming the
        // field_identifier declarator. extractField only collects
        // field_identifiers, so the type-position macro is silently dropped
        // (VOS_MSG_HEADER lost while BBRF_MSG_HEADER is kept). Extract that
        // type_identifier as a field too so every macro member is queryable.
        // Restricted to names in globalMacroNames: a real type like `MyStruct`
        // is NOT a macro and must stay a type (it lives in the signature, not
        // as a field node).
        else if (current && current.type === 'type_identifier'
          && this.globalMacroNames && this.globalMacroNames.has(getNodeText(current, this.source))) {
          fieldEntries.push({ name: getNodeText(current, this.source), posNode: current });
        }
      }
      if (fieldEntries.length > 0) {
        // Build type text from the type-child for the signature
        const typeNode = getChildByField(node, 'type');
        const typeText = typeNode ? getNodeText(typeNode, this.source) : undefined;

        const inlineTypeDefinition = node.namedChildren.find(child =>
          (child.type === 'class_specifier' || child.type === 'struct_specifier'
            || child.type === 'union_specifier' || child.type === 'enum_specifier')
          && Boolean(getChildByField(child, this.extractor!.bodyField)));
        for (const { name, posNode } of fieldEntries) {
          const signature = typeText ? `${typeText} ${name}` : name;
          // clang tooling anchors `class Inline { ... } value;` at the start of
          // the whole declaration. Preserve that range while the name remains
          // queryable at its trailing identifier line via endLine containment.
          this.createNode('field', name, inlineTypeDefinition ? node : posNode, {
            docstring,
            signature,
            visibility,
            isStatic,
          });
        }
        return;
      }
    }

    if (declarators.length > 0) {
      // Get field type from the type child
      // Java: type is a direct child of field_declaration
      // C#: type is inside variable_declaration wrapper
      const varDecl = node.namedChildren.find(c => c.type === 'variable_declaration');
      const typeSearchNode = varDecl ?? node;
      const typeNode = typeSearchNode.namedChildren.find(
        c => c.type !== 'modifiers' && c.type !== 'modifier' && c.type !== 'variable_declarator'
          && c.type !== 'variable_declaration' && c.type !== 'marker_annotation' && c.type !== 'annotation'
      );
      const typeText = typeNode ? getNodeText(typeNode, this.source) : undefined;

      for (const decl of declarators) {
        const nameNode = getChildByField(decl, 'name')
          || decl.namedChildren.find(c => c.type === 'identifier');
        if (!nameNode) continue;
        const name = getNodeText(nameNode, this.source);
        const signature = typeText ? `${typeText} ${name}` : name;
        const fieldNode = this.createNode('field', name, decl, {
          docstring,
          signature,
          visibility,
          isStatic,
        });
        // Java/Kotlin annotations / TS field decorators sit on the
        // outer field_declaration, not on the individual declarator.
        if (fieldNode) {
          this.extractDecoratorsFor(node, fieldNode.id);
          // Same as properties: emit `references` to the field's annotated
          // type. The outer `field_declaration` is the right scope to
          // search from — C# carries the `type` inside `variable_declaration`
          // and the language-aware path in `extractTypeAnnotations` descends
          // into that wrapper (#381).
          this.extractTypeAnnotations(node, fieldNode.id);
        }
      }
    } else {
      // Fallback: try to find an identifier child directly
      const nameNode = getChildByField(node, 'name')
        || node.namedChildren.find(c => c.type === 'identifier');
      if (nameNode) {
        const name = getNodeText(nameNode, this.source);
        this.createNode('field', name, node, {
          docstring,
          visibility,
          isStatic,
        });
      }
    }
  }

  /**
   * C/C++: extract function declarations that are nested inside
   * struct_specifiers within a misparsed top-level field_declaration.
   *
   * When tree-sitter-c leaks a multi-line #define body, subsequent struct
   * definitions can span hundreds of lines and swallow function prototypes
   * as their field_declaration_list children.  Some of those children are
   * themselves struct_specifiers (e.g. uv_process_s inside uv_timer_s),
   * producing deeply nested function declarators.  This walks
   * struct_specifier → field_declaration_list recursively and creates
   * function nodes for every leaf field_declaration that contains a
   * function_declarator.
   */
  private extractNestedStructFunctions(node: SyntaxNode): void {
    if (!this.extractor || (this.language !== 'c' && this.language !== 'cpp')) return;

    const structSpecs = node.namedChildren.filter(c => c.type === 'struct_specifier');
    if (structSpecs.length === 0) return;

    const extractName = (funcDecl: SyntaxNode): string | null => {
      // In this misparsed context the declarator uses bare field_identifier.
      let idNode: SyntaxNode | null =
        funcDecl.namedChildren.find(c => c.type === 'field_identifier') ?? null;
      if (!idNode) {
        const decl = getChildByField(funcDecl, 'declarator');
        if (decl) {
          let current: SyntaxNode | null = decl;
          while (current && (current.type === 'pointer_declarator' ||
                             current.type === 'array_declarator')) {
            current = getChildByField(current, 'declarator') || current.namedChild(0) || null;
          }
          if (current && current.type === 'identifier') idNode = current;
        }
      }
      if (!idNode) return null;
      const name = getNodeText(idNode, this.source);
      return name && !C_CPP_KEYWORD_NAMES.has(name) ? name : null;
    };

    // Breadth-first walk: for each struct_specifier, process its immediate
    // field_declaration children (extracting function nodes) and recurse
    // into nested struct_specifiers.
    const walkStruct = (spec: SyntaxNode): void => {
      const fdl = spec.namedChildren.find(c => c.type === 'field_declaration_list');
      if (!fdl) return;

      for (const innerFd of fdl.namedChildren) {
        if (innerFd.type !== 'field_declaration') continue;

        // Check for a function_declarator, which may be wrapped in one
        // or more pointer_declarator layers (e.g. `char** uv_setup_args`).
        let funcDecl: SyntaxNode | null =
          innerFd.namedChildren.find(c => c.type === 'function_declarator') ?? null;
        if (!funcDecl && innerFd.descendantsOfType('function_declarator').length > 0) {
          // Walk through pointer_declarator wrappers to find it.
          let current: SyntaxNode | null =
            innerFd.namedChildren.find(c => c.type === 'pointer_declarator') ?? null;
          while (current && current.type === 'pointer_declarator') {
            const inner = current.namedChildren.find(c => c.type === 'function_declarator');
            if (inner) { funcDecl = inner; break; }
            current = current.namedChildren.find(c => c.type === 'pointer_declarator') ?? null;
          }
        }
        if (funcDecl) {
          const fnName = extractName(funcDecl);
          if (fnName && !this.extractor!.isMisparsedFunction?.(fnName, innerFd, this.fileMacroNames)) {
            this.createNode('function', fnName, innerFd, {
              signature: this.source.substring(innerFd.startIndex, innerFd.endIndex),
              isDeclaration: true,
            });
          }
        }

        // Recurse into nested struct_specifiers (e.g. uv_process_s inside the
        // giant uv_timer_s field_declaration at line 972-1441 in uv.h)
        const nestedStructs = innerFd.namedChildren.filter(c => c.type === 'struct_specifier');
        for (const nested of nestedStructs) {
          walkStruct(nested);
        }
      }
    };

    for (const spec of structSpecs) {
      walkStruct(spec);
    }
  }

  /**
   * C/C++: detect whether a misparsed top-level field_declaration wraps a
   * struct_specifier whose field_declaration_list body contains any
   * struct_specifier/enum_specifier descendants that still have their own body
   * (i.e. real definitions swallowed by the X-macro leak). Used to widen the
   * field_declaration rescue guard beyond the function_declarator-only case.
   */
  private hasSwallowedTypeDefinitions(node: SyntaxNode): boolean {
    if (!this.extractor) return false;
    const bodyField = this.extractor.bodyField;
    for (const wrapper of node.namedChildren.filter(c => c.type === 'struct_specifier')) {
      const body = getChildByField(wrapper, bodyField);
      if (!body) continue;
      if (body.descendantsOfType('struct_specifier').some(s => getChildByField(s, bodyField)) ||
          body.descendantsOfType('enum_specifier').some(e => getChildByField(e, bodyField))) {
        return true;
      }
    }
    return false;
  }

  /**
   * C/C++: extract nested struct/enum definitions that were swallowed by a
   * misparsed top-level field_declaration (X-macro leak:
   * `struct X { MACRO_FIELDS };` — tree-sitter-c has no preprocessor, so the
   * macro identifier is misread as the field type and field_declaration_list
   * never closes; ERROR recovery folds following top-level declarations into
   * the wrapper struct_specifier's body). Pairs with extractNestedStructFunctions,
   * which rescues function_declarator children; this rescues the struct_specifier
   * / enum_specifier children that still have a valid body. typedef enum/struct
   * is fully ERROR-ized by tree-sitter-c (no valid type_definition node), so it
   * is out of scope here — recovering it needs a preprocessor.
   *
   * Structs are rescued via rescueSwallowedStruct (not extractStruct) to avoid
   * two side effects of extractStruct's unconditional body visit: swallowed
   * function prototypes (field_declaration + function_declarator) would become
   * duplicate `method` nodes via extractField's function_declarator branch —
   * they're already rescued as `function` nodes by extractNestedStructFunctions;
   * and swallowed type definitions (field_declaration whose type is a
   * struct/enum specifier with body) would become garbage `field` nodes.
   * Enums are safe to route through extractEnum — their body (enumerator_list)
   * holds only enumerator children, no function_declarator or type-specifier
   * noise.
   */
  private extractNestedStructEnums(node: SyntaxNode): void {
    if (!this.extractor || (this.language !== 'c' && this.language !== 'cpp')) return;
    const bodyField = this.extractor.bodyField;
    // The wrapper struct_specifier is the misparsed field_declaration's directly
    // named child (e.g. uv_timer_s). Its field_declaration_list body holds the
    // swallowed content. descendantsOfType reaches any nesting depth and naturally
    // excludes the wrapper itself (a descendant is not its own descendant).
    const wrapperSpecs = node.namedChildren.filter(c => c.type === 'struct_specifier');
    for (const wrapper of wrapperSpecs) {
      const body = getChildByField(wrapper, bodyField);
      if (!body) continue;
      const structs = body.descendantsOfType('struct_specifier')
        .filter(s => getChildByField(s, bodyField));
      const enums = body.descendantsOfType('enum_specifier')
        .filter(e => getChildByField(e, bodyField));
      for (const s of structs) this.rescueSwallowedStruct(s);
      for (const e of enums) this.extractEnum(e);
    }
  }

  /**
   * C/C++: rescue a struct definition swallowed by the X-macro leak. Like
   * extractStruct, this creates the struct node and visits body children to
   * extract real fields — but it skips categories of swallowed content that
   * extractStruct would misextract:
   *
   *  1. field_declarations containing a function_declarator — these are
   *     swallowed function prototypes, already rescued as `function` nodes by
   *     extractNestedStructFunctions. extractField would create duplicate
   *     `method` nodes for them.
   *  2. field_declarations whose `type` is a struct/enum specifier with a body
   *     — these are swallowed type definitions (typedef remnants or nested
   *     structs/enums). extractField would create garbage `field` nodes from
   *     their declarator. The struct/enum specifiers themselves are handled by
   *     the outer descendantsOfType loop in extractNestedStructEnums.
   *  3. field_declarations whose `type` is a `type_identifier` with text
   *     `typedef` — tree-sitter-c's ERROR recovery parses the `typedef` keyword
   *     itself as a type_identifier, producing a field_declaration whose
   *     declarators are the enumerators/fields of the flattened typedef
   *     enum/struct. extractField would create garbage field nodes named after
   *     those enumerators (e.g. UV_IGNORE, UV_DIRENT_UNKNOWN).
   *  4. field_declarations whose `type` is a `macro_type_specifier` — a macro
   *     function invocation misparsed as a field type (e.g.
   *     `uv_process_get_pid(const uv_process_t*)`), producing a garbage field
   *     named after the macro's return typedef (e.g. uv_pid_t).
   *
   * Real fields (field_declarations with field_identifier declarators, pointer/
   * array wrappers, primitive types, etc.) are visited normally via visitNode,
   * so they get extracted exactly as extractStruct would. Individual fields of
   * flattened `typedef struct { ... }` content (ru_stime, ru_maxrss, etc.)
   * still leak through — they have normal primitive/type_identifier types and
   * no AST marker distinguishes them from real fields. Rescuing them requires
   * a preprocessor, not an AST filter. A field_declaration whose type is an
   * ALL_UPPERCASE macro placeholder (UV_REQ_FIELDS, UV_HANDLE_FIELDS) can also
   * be a real field whose type was mangled into the preceding macro name —
   * filtering those would lose real fields, so they are kept.
   */
  private rescueSwallowedStruct(node: SyntaxNode): void {
    if (!this.extractor) return;

    const body = getChildByField(node, this.extractor.bodyField);
    if (!body) return;

    const name = extractName(node, this.source, this.extractor);
    const docstring = getPrecedingDocstring(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isExported = this.extractor.isExported?.(node, this.source);

    const structNode = this.createNode('struct', name, node, {
      docstring,
      visibility,
      isExported,
    });
    if (!structNode) return; // already created by a prior rescue (dedup)

    this.extractInheritance(node, structNode.id);

    this.nodeStack.push(structNode.id);
    const bodyField = this.extractor.bodyField;
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (!child) continue;
      // Skip swallowed function prototypes — already rescued as function nodes
      // by extractNestedStructFunctions; visiting them here would create
      // duplicate method nodes via extractField's function_declarator branch.
      if (
        child.type === 'field_declaration' &&
        child.descendantsOfType('function_declarator').length > 0
      ) continue;
      // Skip swallowed type definitions (field_declaration whose type is a
      // struct/enum specifier with a body) — the specifiers are handled by the
      // outer descendantsOfType loop; visiting the wrapper field_declaration
      // would create garbage field nodes from the typedef declarator name.
      if (child.type === 'field_declaration') {
        const typeChild = getChildByField(child, 'type');
        if (
          typeChild &&
          (typeChild.type === 'struct_specifier' ||
            typeChild.type === 'enum_specifier') &&
          getChildByField(typeChild, bodyField)
        ) continue;
        // Skip typedef-keyword artifacts: tree-sitter-c's ERROR recovery parses
        // the `typedef` keyword as a type_identifier, flattening a typedef
        // enum/struct's enumerators/fields into field_identifier declarators.
        // Without this, UV_IGNORE / UV_DIRENT_UNKNOWN / uv_stdio_flags etc.
        // become garbage field nodes named after the enumerators.
        if (typeChild && typeChild.type === 'type_identifier' && typeChild.text === 'typedef') continue;
        // Skip macro_type_specifier artifacts: a macro function invocation
        // misparsed as a field type (e.g. uv_process_get_pid(...)), producing a
        // garbage field named after the macro's return typedef (e.g. uv_pid_t).
        if (typeChild && typeChild.type === 'macro_type_specifier') continue;
      }
      this.visitNode(child);
    }
    this.nodeStack.pop();
  }

  /**
   * nodes (named by their property key). Shared by the two object-of-functions
   * shapes in extractVariable: the object as a direct const value, and the
   * object returned by a store-initializer call. Handles both `key: () => {}` /
   * `key: function() {}` pairs and method shorthand `key() {}`.
   */
  private extractObjectLiteralFunctions(obj: SyntaxNode): void {
    for (let i = 0; i < obj.namedChildCount; i++) {
      const member = obj.namedChild(i);
      if (!member) continue;
      if (member.type === 'pair') {
        const key = getChildByField(member, 'key');
        const value = getChildByField(member, 'value');
        if (key && value && (value.type === 'arrow_function' || value.type === 'function_expression')) {
          this.extractFunction(value, this.objectKeyName(key));
        }
      } else if (member.type === 'method_definition') {
        // Method shorthand: `{ fetchUser() {...} }`. extractMethod deliberately
        // skips object-literal methods, so route through extractFunction with an
        // explicit name (method_definition exposes a `body` field, so resolveBody
        // falls through to it and the node spans the full method).
        const key = getChildByField(member, 'name');
        if (key) this.extractFunction(member, this.objectKeyName(key));
      }
    }
  }

  /** Property-key text with surrounding quotes stripped (`'foo'` → `foo`). */
  private objectKeyName(key: SyntaxNode): string {
    return getNodeText(key, this.source).replace(/^['"`]|['"`]$/g, '');
  }

  /**
   * Given a `call_expression` initializer (`create((set, get) => ({...}))`),
   * find the object literal RETURNED by a function argument — descending through
   * nested call_expression arguments so middleware wrappers are unwrapped
   * (`create(persist((set, get) => ({...}), {...}))`, devtools, immer,
   * subscribeWithSelector). Returns null when no such object is found — the
   * common case for ordinary call initializers — so this stays cheap and silent
   * rather than guessing. Keyed purely on AST shape; no library names.
   */
  private findInitializerReturnedObject(callNode: SyntaxNode, depth = 0): SyntaxNode | null {
    if (depth > 4) return null;
    const args = getChildByField(callNode, 'arguments');
    if (!args) return null;
    for (let i = 0; i < args.namedChildCount; i++) {
      const arg = args.namedChild(i);
      if (!arg) continue;
      if (arg.type === 'arrow_function' || arg.type === 'function_expression') {
        const obj = this.functionReturnedObject(arg);
        if (obj) return obj;
      } else if (arg.type === 'call_expression') {
        const obj = this.findInitializerReturnedObject(arg, depth + 1);
        if (obj) return obj;
      }
    }
    return null;
  }

  /**
   * The object literal a function expression returns — either the `=> ({...})`
   * arrow form (a parenthesized_expression wrapping an object) or a
   * `=> { return {...} }` block. Returns null for any other body shape.
   */
  private functionReturnedObject(fnNode: SyntaxNode): SyntaxNode | null {
    const body = getChildByField(fnNode, 'body');
    if (!body) return null;
    const asObject = (n: SyntaxNode | null): SyntaxNode | null => {
      if (!n) return null;
      if (n.type === 'object' || n.type === 'object_expression') return n;
      if (n.type === 'parenthesized_expression') {
        for (let i = 0; i < n.namedChildCount; i++) {
          const inner = asObject(n.namedChild(i));
          if (inner) return inner;
        }
      }
      return null;
    };
    // `(set, get) => ({...})` — body is the (parenthesized) object directly.
    const direct = asObject(body);
    if (direct) return direct;
    // `(set, get) => { return {...} }` — scan top-level return statements.
    if (body.type === 'statement_block') {
      for (let i = 0; i < body.namedChildCount; i++) {
        const stmt = body.namedChild(i);
        if (stmt?.type !== 'return_statement') continue;
        for (let j = 0; j < stmt.namedChildCount; j++) {
          const obj = asObject(stmt.namedChild(j));
          if (obj) return obj;
        }
      }
    }
    return null;
  }

  /**
   * Extract a variable declaration (const, let, var, etc.)
   *
   * Extracts top-level and module-level variable declarations.
   * Captures the variable name and first 100 chars of initializer in signature for searchability.
   */
  private extractVariable(node: SyntaxNode): void {
    if (!this.extractor) return;

    // Different languages have different variable declaration structures
    // TypeScript/JavaScript: lexical_declaration contains variable_declarator children
    // Python: assignment has left (identifier) and right (value)
    // Go: var_declaration, short_var_declaration, const_declaration

    const isConst = this.extractor.isConst?.(node) ?? false;
    const kind: NodeKind = isConst ? 'constant' : 'variable';
    const docstring = getPrecedingDocstring(node, this.source);
    const isExported = this.extractor.isExported?.(node, this.source) ?? false;

    // Extract variable declarators based on language
    if (this.language === 'typescript' || this.language === 'javascript' ||
        this.language === 'tsx' || this.language === 'jsx') {
      // Handle lexical_declaration and variable_declaration
      // These contain one or more variable_declarator children
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'variable_declarator') {
          const nameNode = getChildByField(child, 'name');
          const valueNode = getChildByField(child, 'value');

          if (nameNode) {
            // Skip destructured patterns (e.g., `let { x, y } = $props()` in Svelte)
            // These produce ugly multi-line names like "{ class: className }"
            if (nameNode.type === 'object_pattern' || nameNode.type === 'array_pattern') {
              continue;
            }
            const name = getNodeText(nameNode, this.source);
            // Arrow functions / function expressions: extract as function instead of variable
            if (valueNode && (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression')) {
              this.extractFunction(valueNode);
              continue;
            }

            // Capture first 100 chars of initializer for context (stored in signature for searchability)
            const initValue = valueNode ? getNodeText(valueNode, this.source).slice(0, 100) : undefined;
            const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;

            const varNode = this.createNode(kind, name, child, {
              docstring,
              signature: initSignature,
              isExported,
            });

            // Extract type annotation references (e.g., const x: ITextModel = ...)
            if (varNode) {
              this.extractVariableTypeAnnotation(child, varNode.id);
            }

            // Exported const object-of-functions — extract each function-valued
            // property as a function named by its key + walk its body so its
            // calls are captured. Two shapes, both keyed on AST shape (not on any
            // library name):
            //   `export const actions = { default: async () => {} }` — object is
            //     the DIRECT value (SvelteKit form actions / handler maps / route
            //     tables).
            //   `export const useStore = create((set, get) => ({ fetchUser:
            //     async () => {} }))` — object is RETURNED by an initializer call,
            //     possibly through middleware wrappers (persist/devtools/immer).
            //     Covers Zustand/Redux/Pinia/MobX stores generically. Without
            //     this, store actions exist only as object-literal properties —
            //     never nodes — so `node`/`callers` on `fetchUser` return "not
            //     found" and the agent Reads the store to reconstruct the flow.
            // Scoped to EXPORTED consts to exclude inline-object noise
            // (`ctx.set({...})`) the object-method skip deliberately avoids.
            const objectOfFns =
              valueNode && (valueNode.type === 'object' || valueNode.type === 'object_expression')
                ? valueNode
                : valueNode?.type === 'call_expression'
                  ? this.findInitializerReturnedObject(valueNode)
                  : null;
            const extractObjectMethods = isExported && !!objectOfFns;

            // Visit the initializer body for calls — EXCEPT object literals (their
            // function-valued properties are extracted below) and the store-factory
            // call whose returned object we extract method-by-method below (walking
            // the whole call would re-visit those method arrows and mis-attribute
            // their inner calls to the file/module scope).
            if (valueNode &&
                valueNode.type !== 'object' &&
                valueNode.type !== 'object_expression' &&
                !(extractObjectMethods && valueNode.type === 'call_expression')) {
              this.visitFunctionBody(valueNode, '');
            }

            if (extractObjectMethods && objectOfFns) {
              this.extractObjectLiteralFunctions(objectOfFns);
            }
          }
        }
      }
    } else if (this.language === 'python' || this.language === 'ruby') {
      // Python/Ruby assignment: left = right
      const left = getChildByField(node, 'left') || node.namedChild(0);
      const right = getChildByField(node, 'right') || node.namedChild(1);

      if (left && left.type === 'identifier') {
        const name = getNodeText(left, this.source);
        // Skip if name starts with lowercase and looks like a function call result
        // Python constants are usually UPPER_CASE
        const initValue = right ? getNodeText(right, this.source).slice(0, 100) : undefined;
        const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;

        this.createNode(kind, name, node, {
          docstring,
          signature: initSignature,
        });
      }
    } else if (this.language === 'go') {
      // Go: var_declaration, short_var_declaration, const_declaration
      // These can have multiple identifiers on the left
      const specs = node.namedChildren.filter(c =>
        c.type === 'var_spec' || c.type === 'const_spec'
      );

      for (const spec of specs) {
        const nameNode = spec.namedChild(0);
        let varNode: Node | null = null;
        if (nameNode && nameNode.type === 'identifier') {
          const name = getNodeText(nameNode, this.source);
          const valueNode = spec.namedChildCount > 1 ? spec.namedChild(spec.namedChildCount - 1) : null;
          const initValue = valueNode ? getNodeText(valueNode, this.source).slice(0, 100) : undefined;
          const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;

          varNode = this.createNode(node.type === 'const_declaration' ? 'constant' : 'variable', name, spec, {
            docstring,
            signature: initSignature,
          });
        }
        // Walk the initializer so composite literals and calls in a
        // package-level `var Query Binding = queryBinding{}` (a registry of
        // implementations) or `var c = pkg.New()` are extracted as
        // instantiates/calls dependencies — the body walker only covers
        // initializers inside functions, not these top-level declarations.
        // Scope the walk to the declared symbol so a call inside an anonymous
        // func_literal initializer — a cobra `RunE: func(){…}` handler, a
        // goroutine or callback closure — attributes to the var instead of
        // leaking to the file node (which reads as "no caller"), issue #693.
        const valueField = getChildByField(spec, 'value');
        if (valueField) {
          if (varNode) this.nodeStack.push(varNode.id);
          this.visitFunctionBody(valueField, varNode?.id ?? '');
          if (varNode) this.nodeStack.pop();
        }
      }

      // Handle short_var_declaration (:=)
      if (node.type === 'short_var_declaration') {
        const left = getChildByField(node, 'left');
        const right = getChildByField(node, 'right');

        if (left) {
          // Can be expression_list with multiple identifiers
          const identifiers = left.type === 'expression_list'
            ? left.namedChildren.filter(c => c.type === 'identifier')
            : [left];

          for (const id of identifiers) {
            const name = getNodeText(id, this.source);
            const initValue = right ? getNodeText(right, this.source).slice(0, 100) : undefined;
            const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;

            this.createNode('variable', name, node, {
              docstring,
              signature: initSignature,
            });
          }
        }
      }
    } else if (this.language === 'lua' || this.language === 'luau') {
      // Lua/Luau: variable_declaration → assignment_statement → variable_list
      //      (name: identifier...) = expression_list. `local x, y = 1, 2`
      //      declares multiple names; only plain identifiers are locals.
      const assign = node.namedChildren.find((c) => c.type === 'assignment_statement') ?? node;
      const varList = assign.namedChildren.find((c) => c.type === 'variable_list');
      const exprList = assign.namedChildren.find((c) => c.type === 'expression_list');
      const values = exprList ? exprList.namedChildren : [];
      const names = varList ? varList.namedChildren.filter((c) => c.type === 'identifier') : [];
      names.forEach((nameNode, i) => {
        const name = getNodeText(nameNode, this.source);
        if (!name) return;
        const valueNode = values[i];
        const initValue = valueNode ? getNodeText(valueNode, this.source).slice(0, 100) : undefined;
        const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;
        this.createNode(kind, name, nameNode, { docstring, signature: initSignature, isExported });
      });
    } else if (this.language === 'c' || this.language === 'cpp') {
      // C/C++ declaration: type specifier + declarator(s).
      //
      // Each declarator may appear as init_declarator (when there is an initializer,
      // e.g. `int x = 5`), as identifier directly (no initializer, `int x`), or
      // wrapped in pointer_declarator / array_declarator (`int *p`, `int arr[10]`).
      // Multiple declarators are comma-separated siblings (`int x, y, z`).
      //
      // Skip declarators that contain function_declarator (forward declarations like
      // `int foo();` — these are function declarations, not variables).

      /** Descend through declarator wrappers to find the identifier. Returns the
       *  identifier node, or the deepest unwrapped node if no identifier found. */
      const unwrapDeclarator = (n: SyntaxNode): SyntaxNode | null => {
        if (n.type === 'identifier') return n;
        if (n.type === 'init_declarator') {
          const d = getChildByField(n, 'declarator');
          return d ? unwrapDeclarator(d) : null;
        }
        if (n.type === 'pointer_declarator' || n.type === 'array_declarator' ||
            n.type === 'reference_declarator') {
          const inner = getChildByField(n, 'declarator') || n.namedChild(0);
          const result = inner ? unwrapDeclarator(inner) : null;
          // When unrecognized macros appear before the declaration
          // (e.g. EXTERN_STDC_BEGIN ADA_DEV_IDCVT_TABLE_STRU g_var[] = {}),
          // tree-sitter puts a macro name as the declarator-field identifier
          // and the real variable name inside an ERROR child.  Check ERROR
          // children and prefer an identifier that differs from the one the
          // declarator field returned.
          if (result?.type === 'identifier') {
            for (const child of n.namedChildren) {
              if (child.type === 'ERROR') {
                for (const errChild of child.namedChildren) {
                  if (errChild.type === 'identifier') {
                    if (getNodeText(errChild, this.source) !== getNodeText(result, this.source)) {
                      return errChild;
                    }
                  }
                }
              }
            }
          }
          return result ?? null;
        }
        if (n.type === 'parenthesized_declarator') {
          for (let i = 0; i < n.namedChildCount; i++) {
            const child = n.namedChild(i);
            if (child) {
              const result = unwrapDeclarator(child);
              if (result) return result;
            }
          }
          return null;
        }
        // C++ qualified_identifier: `ClassName::static_member` or
        // `NS::Class::member` — extract the last identifier (the member
        // name after the final `::`). Recurse to handle nested qualified
        // identifiers where the deepest identifier may be 2+ levels down.
        if (n.type === 'qualified_identifier') {
          const findLastId = (qn: SyntaxNode): SyntaxNode | null => {
            let last: SyntaxNode | null = null;
            for (let i = 0; i < qn.namedChildCount; i++) {
              const c = qn.namedChild(i);
              if (c?.type === 'identifier') last = c;
              if (c?.type === 'qualified_identifier') {
                const nested = findLastId(c);
                if (nested) last = nested;
              }
            }
            return last;
          };
          return findLastId(n) ?? n;
        }
        // function_declarator: unwrap through the `declarator` field to reach
        // the identifier (or further pointer/array wrapping). Needed when
        // pointer_declarator wraps function_declarator, e.g.
        // `const char* uv_version_string(void)` where getChildByField returns
        // the function_declarator itself as the inner declarator.
        if (n.type === 'function_declarator') {
          const inner = getChildByField(n, 'declarator');
          return inner ? unwrapDeclarator(inner) : n;
        }
        // function_declarator or unrecognized — stop here
        return n;
      };

      const hasFunctionDeclarator = (n: SyntaxNode): boolean => {
        if (n.type === 'function_declarator') return true;
        for (let i = 0; i < n.namedChildCount; i++) {
          const child = n.namedChild(i);
          if (child && hasFunctionDeclarator(child)) return true;
        }
        return false;
      };

      // Node types that are declarators (not type specifiers / qualifiers)
      const DECLARATOR_TYPES = new Set([
        'init_declarator', 'identifier', 'pointer_declarator',
        'array_declarator', 'reference_declarator', 'function_declarator',
        'parenthesized_declarator', 'qualified_identifier',
      ]);

      // Track whether this declaration uses `extern`. An `extern` declarator
      // WITH an initializer is a definition (C: `extern T g_x = ...;`), extracted
      // normally. An `extern` declarator WITHOUT an initializer is extracted as a
      // declaration node (isDeclaration=true) — mirroring how `extern` function
      // prototypes are kept as the public API signature. This was previously
      // skipped unconditionally on the assumption the definition lives in another
      // indexed file, which lost the symbol entirely when that file wasn't
      // indexed (or its parse was broken by macro pollution) — the header's
      // `extern` decl was the only place the symbol existed. The header↔.c pair
      // is bridged by a `defines` edge in cCppVarDeclDefEdges.
      const isExtern = this.hasStorageClass(node, 'extern');

      outer: for (const child of node.namedChildren) {
        if (!DECLARATOR_TYPES.has(child.type)) continue;
        const declaratorKind: NodeKind = (
          this.extractor.isDeclaratorConst?.(node, child) ?? isConst
        ) ? 'constant' : 'variable';

        // Handle function declarations (forward declarations, prototypes).
        // Tree-sitter parses `int foo();` as `declaration` containing a
        // `function_declarator` — not as `function_definition`. Extract the
        // function name from inside the function_declarator so headers get
        // function nodes for their public API.
        if (hasFunctionDeclarator(child)) {
          // function_declarator inside a `declaration` has a `declarator` field
          // (e.g. `int foo();` → function_declarator → declarator → identifier).
          // When tree-sitter-c misparses the prototype as `field_declaration`
          // (triggered by multi-line #define leaks like UV_HANDLE_FIELDS), the
          // function_declarator uses a bare `field_identifier` child instead.
          let innerDecl = getChildByField(child, 'declarator');
          if (!innerDecl) {
            innerDecl = child.namedChildren.find(c => c.type === 'field_identifier') ?? null;
          }
          // C++ reference-return prototype: tree-sitter-cpp parses `T& foo();`
          // as `declaration → reference_declarator → function_declarator → identifier`
          // (structurally identical to the pointer-return `pointer_declarator`
          // form). `reference_declarator` DOES expose its inner declarator via the
          // `declarator` field (fieldNameForChild returns "declarator"), but
          // `childForFieldName("declarator")` returns null on `reference_declarator`
          // — a web-tree-sitter/grammar quirk that does NOT affect
          // `pointer_declarator`. So `getChildByField` comes back empty here, and
          // without this fallback the reference-return prototype (`T& foo();`,
          // `T&& foo();`, `ostream& operator<<(...)`) at file/namespace scope is
          // dropped entirely (the .cpp definition survives via extractName's
          // namedChild(0) fallback; class methods survive via extractField's
          // by-type unwrap — only this free-function prototype path lacked it).
          // `unwrapDeclarator` already handles reference_declarator through its
          // own `namedChild(0)` fallback, so passing the wrapper itself through
          // resolves the inner function_declarator → identifier.
          if (!innerDecl) {
            innerDecl = child;
          }
          if (innerDecl) {
            const idNode = unwrapDeclarator(innerDecl);
            if (idNode && (idNode.type === 'identifier' || idNode.type === 'field_identifier')) {
              const rawFnName = cppCallableDeclaratorName(node, this.source)
                ?? getNodeText(idNode, this.source);
              const fnName = this.language === 'cpp'
                ? normalizeCppCallableName(
                  rawFnName,
                  this.extractor.getReceiverType?.(node, this.source),
                )
                : rawFnName;
              if (fnName && !C_CPP_KEYWORD_NAMES.has(fnName)
                && !this.extractor.isMisparsedFunction?.(fnName, node, this.fileMacroNames)) {
                // Guard against tree-sitter error-recovery `declaration` nodes
                // that span an entire namespace/file (caused by macro
                // replacement erasing braces, or by the Most Vexing Parse
                // triggering recovery). A real prototype is never > 100 lines
                // or > 2000 bytes; when the declaration node is oversized,
                // use the function_declarator (`child`) for both the node
                // position and the signature — that is the real prototype
                // location and text, not the error-recovery blob.
                const declSpan = node.endPosition.row - node.startPosition.row;
                const declLen = node.endIndex - node.startIndex;
                const oversized = declSpan > 100 || declLen > 2000;
                const posNode = oversized ? child : node;
                const signature = oversized
                  ? this.source.substring(child.startIndex, child.endIndex)
                  : this.source.substring(node.startIndex, node.endIndex);
                this.createNode('function', fnName, posNode, {
                  docstring,
                  signature,
                  isExported: isExported || !isExtern,
                  isDeclaration: true,
                });
              }
            }
          }
          continue;
        }

        // Extern variable declarations are no longer skipped — see the isExtern
        // note above. A bodiless `extern` declarator becomes a declaration node
        // (isDeclaration=true); an `extern` declarator with an initializer is a
        // definition and is extracted as such.
        const hasInit = child.type === 'init_declarator' && !!getChildByField(child, 'value');
        const isExternDecl = isExtern && !hasInit;

        const resolved = unwrapDeclarator(child);

        // When init_declarator has ERROR children containing identifiers
        // that DIFFER from the one unwrapDeclarator returned, tree-sitter
        // has misparsed macros as the identifier and the real variable name
        // is in the ERROR recovery node.
        // e.g.  extern RRE_ATTRIBUTE_VISIBILITY VOS_UINT32 g_var = 0;
        //       init_declarator → identifier "VOS_UINT32" ← macro
        //                      → ERROR → identifier "g_var" ← real name
        if (resolved?.type === 'identifier' && child.type === 'init_declarator') {
          for (const c of child.namedChildren) {
            if (c.type === 'ERROR') {
              for (const ec of c.namedChildren) {
                if (ec.type === 'identifier' &&
                    getNodeText(ec, this.source) !== getNodeText(resolved, this.source)) {
                  const errName = getNodeText(ec, this.source);
                  if (errName && !C_CPP_KEYWORD_NAMES.has(errName)) {
                    const valueNode = getChildByField(child, 'value');
                    const initValue = valueNode
                      ? getNodeText(valueNode, this.source).slice(0, 100) : undefined;
                    const initSignature = initValue
                      ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;
                    this.createNode(declaratorKind, errName, ec, {
                      docstring,
                      signature: initSignature,
                      isExported,
                      isDeclaration: isExternDecl,
                    });
                  }
                  break; // exit ERROR children loop — already created the node
                }
              }
              // If we found a conflicting ERROR identifier, skip to next
              // named child (continue the outer for loop)
              if (c.namedChildren.some(
                (ec: SyntaxNode) => ec.type === 'identifier' &&
                  getNodeText(ec, this.source) !== getNodeText(resolved, this.source)
              )) {
                continue outer; // continue outer for loop (next child)
              }
            }
          }
        }

        if (!resolved || resolved.type !== 'identifier') continue;

        const name = getNodeText(resolved, this.source);
        if (!name) continue;

        // Filter C/C++ keywords that tree-sitter misparses as variable
        // declarator names (e.g. `if` from `else if (MACRO(...))`).
        if (C_CPP_KEYWORD_NAMES.has(name)) continue;

        // Initializer only lives on init_declarator
        const valueNode = child.type === 'init_declarator'
          ? getChildByField(child, 'value') : null;
        const initValue = valueNode
          ? getNodeText(valueNode, this.source).slice(0, 100) : undefined;
        const initSignature = initValue
          ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;

        this.createNode(declaratorKind, name, resolved, {
          docstring,
          signature: initSignature,
          isExported,
          isDeclaration: isExternDecl,
        });
      }
    } else {
      // Generic fallback for other languages
      // Try to find identifier children
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'identifier' || child?.type === 'variable_declarator') {
          const name = child.type === 'identifier'
            ? getNodeText(child, this.source)
            : extractName(child, this.source, this.extractor);

          if (name && name !== '<anonymous>') {
            this.createNode(kind, name, child, {
              docstring,
              isExported,
            });
          }
        }
      }
    }
  }

  /**
   * Extract a type alias (e.g. `export type X = ...` in TypeScript).
   * For languages like Go, resolveTypeAliasKind detects when the type_spec
   * wraps a struct or interface definition and creates the correct node kind.
   * Returns true if children should be skipped (struct/interface handled body visiting).
   */
  private extractTypeAlias(node: SyntaxNode): boolean {
    if (!this.extractor) return false;

    const name = extractName(node, this.source, this.extractor);
    if (name === '<anonymous>') return false;
    const docstring = getPrecedingDocstring(node, this.source);
    const isExported = this.extractor.isExported?.(node, this.source);

    // Check if this type alias is actually a struct or interface definition
    // (e.g. Go: `type Foo struct { ... }` is a type_spec wrapping struct_type)
    const resolvedKind = this.extractor.resolveTypeAliasKind?.(node, this.source);

    if (resolvedKind === 'struct') {
      const structNode = this.createNode('struct', name, node, { docstring, isExported });
      if (!structNode) return true;
      // Visit body children for field extraction
      this.nodeStack.push(structNode.id);
      // Try Go-style 'type' field first, then find inner struct child (C typedef struct)
      const typeChild = getChildByField(node, 'type')
        || this.findChildByTypes(node, this.extractor.structTypes);
      if (typeChild) {
        const anonymousName = (this.language === 'c' || this.language === 'cpp')
          ? anonymousCppTypeName(typeChild)
          : null;
        if (anonymousName) this.createNode('struct', anonymousName, typeChild);
        // Extract struct embedding (e.g. Go: `type DB struct { *Head; Queryable }`)
        this.extractInheritance(typeChild, structNode.id);
        const body = getChildByField(typeChild, this.extractor.bodyField) || typeChild;
        for (let i = 0; i < body.namedChildCount; i++) {
          const child = body.namedChild(i);
          if (child) this.visitNode(child);
        }
      }
      this.nodeStack.pop();
      this.emitTypedefAliasNodes(node, structNode, name);
      return true;
    }

    if (resolvedKind === 'enum') {
      const enumNode = this.createNode('enum', name, node, { docstring, isExported });
      if (!enumNode) return true;
      this.nodeStack.push(enumNode.id);
      // Find the inner enum type child (e.g. C: typedef enum { ... } name)
      const innerEnum = this.findChildByTypes(node, this.extractor.enumTypes);
      if (innerEnum) {
        const anonymousName = (this.language === 'c' || this.language === 'cpp')
          ? anonymousCppTypeName(innerEnum)
          : null;
        if (anonymousName) this.createNode('enum', anonymousName, innerEnum);
        this.extractInheritance(innerEnum, enumNode.id);
        const body = this.extractor.resolveBody?.(innerEnum, this.extractor.bodyField)
          ?? getChildByField(innerEnum, this.extractor.bodyField);
        if (body) {
          const memberTypes = this.extractor.enumMemberTypes;
          for (let i = 0; i < body.namedChildCount; i++) {
            const child = body.namedChild(i);
            if (!child) continue;
            if (memberTypes?.includes(child.type)) {
              this.extractEnumMembers(child);
            } else {
              this.visitNode(child);
            }
          }
        }
      }
      this.nodeStack.pop();
      this.emitTypedefAliasNodes(node, enumNode, name);
      return true;
    }

    if (resolvedKind === 'interface') {
      const kind: NodeKind = this.extractor.interfaceKind ?? 'interface';
      const interfaceNode = this.createNode(kind, name, node, { docstring, isExported });
      if (!interfaceNode) return true;
      // Extract interface inheritance from the inner type node
      const typeChild = getChildByField(node, 'type');
      if (typeChild) this.extractInheritance(typeChild, interfaceNode.id);
      // Go: extract the interface's method specs as `method` nodes so implicit
      // interface satisfaction (a struct's method set ⊇ the interface's) and
      // impl-navigation can see the contract. Go has no `implements` keyword, so
      // without the interface's method set there's nothing to match against.
      if (this.language === 'go' && typeChild) {
        this.extractGoInterfaceMethods(typeChild, interfaceNode.id);
      }
      return true;
    }

    const typeAliasNode = this.createNode('type_alias', name, node, {
      docstring,
      isExported,
    });

    // Extract type references from the alias value (e.g., `type X = ITextModel | null`)
    if (typeAliasNode && this.TYPE_ANNOTATION_LANGUAGES.has(this.language)) {
      // The value is everything after the `=`, which is typically the last named child
      // In tree-sitter TS: type_alias_declaration has name + value children
      const value = getChildByField(node, 'value');
      if (value) {
        this.extractTypeRefsFromSubtree(value, typeAliasNode.id);
        // `type X = { foo: T; bar(): T }` — make the members first-class
        // property/method nodes under the type alias so `recorder.stop()`
        // can attach the call edge to `RecorderHandle.stop` instead of
        // an unrelated class method picked by path-proximity (#359).
        if (this.language === 'typescript' || this.language === 'tsx') {
          this.extractTsTypeAliasMembers(value, typeAliasNode);
          // `type List = [ Service<'name', Req, Resp>, … ]` — surface each
          // entry's string-literal name as a searchable member (issue #634).
          this.extractTsTupleContractNames(value, typeAliasNode);
        }
      }
    }
    this.emitTypedefAliasNodes(node, typeAliasNode, name);
    return false;
  }

  /**
   * 收集 C/C++ typedef 声明的全部名字：type_definition 的直接 type_identifier
   * 子节点（即各 typedef 别名），以及 struct_specifier / enum_specifier 的标签名。
   * tree-sitter 的 type_definition.declarator 字段只指向第一个 declarator，
   * 其余别名是兄弟 type_identifier 子节点、tag 在 specifier 的 name 字段，
   * 它们都没有字段指向 —— 本方法把它们一次性收集齐，供补建节点。
   */
  private collectTypedefNames(node: SyntaxNode): { aliases: string[]; tag?: string } {
    const aliases: string[] = [];
    let tag: string | undefined;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'type_identifier') {
        const name = getNodeText(child, this.source);
        if (name) aliases.push(name);
      } else if (child.type === 'struct_specifier' || child.type === 'enum_specifier') {
        const nameNode = getChildByField(child, 'name');
        if (nameNode && nameNode.type === 'type_identifier') {
          tag = getNodeText(nameNode, this.source);
        }
      }
    }
    return { aliases, tag };
  }

  /**
   * 为 typedef 多别名声明补建被丢弃的别名 / 标签节点（不加边、不设 signature）。
   * 主节点（第一个 declarator，已含字段）由 extractTypeAlias 上游逻辑建立，
   * primaryName 为主名；此处仅为「其余别名」和「struct/enum tag 名」各建一个
   * kind=type_alias 节点，使其能被 query / codegraph_search / codegraph_node 命中。
   * 节点定位取自 type_definition 整块，故 codegraph_node <别名> 带 includeCode 时
   * 可看到完整 typedef 声明源码。
   *
   * 仅作用于 C / C++ / ObjC 的 type_definition —— 只有 typedef 支持「多 declarator」
   * 语法；其他语言的 type_alias（Kotlin/Swift/Scala/Luau/Go）是单别名，多收会把
   * 别名的值类型误当声明名。与主名相同者（如 `typedef struct Foo {...} Foo;`）去重跳过。
   */
  private emitTypedefAliasNodes(
    typeDefNode: SyntaxNode,
    primaryNode: Node | null,
    primaryName: string,
  ): void {
    if (!primaryNode) return;
    if (this.language !== 'c' && this.language !== 'cpp' && this.language !== 'objc') return;
    if (typeDefNode.type !== 'type_definition') return;

    const { aliases, tag } = this.collectTypedefNames(typeDefNode);
    const seen = new Set<string>([primaryName]);
    const emit = (aliasName: string) => {
      if (!aliasName || seen.has(aliasName)) return;
      seen.add(aliasName);
      this.createNode('type_alias', aliasName, typeDefNode, {
        isExported: primaryNode.isExported,
      });
    };
    for (const a of aliases) emit(a);
    if (tag) emit(tag);
  }

  /**
   * Extract the method specs of a Go `interface_type` body as `method` nodes
   * contained by the interface (e.g. `Marshal`, `Unmarshal` of a `Core`
   * interface). tree-sitter-go names these `method_elem` (newer) or
   * `method_spec` (older). Embedded interfaces (`Reader` inside `ReadWriter`)
   * are `type_identifier`s, not methods, and are left to inheritance extraction.
   */
  private extractGoInterfaceMethods(interfaceType: SyntaxNode, ifaceId: string): void {
    this.nodeStack.push(ifaceId);
    for (let i = 0; i < interfaceType.namedChildCount; i++) {
      const m = interfaceType.namedChild(i);
      if (!m || (m.type !== 'method_elem' && m.type !== 'method_spec')) continue;
      const nameNode = getChildByField(m, 'name') ?? m.namedChild(0);
      if (!nameNode) continue;
      const mname = getNodeText(nameNode, this.source);
      if (mname) {
        this.createNode('method', mname, m, {
          signature: this.extractor?.getSignature?.(m, this.source),
        });
      }
    }
    this.nodeStack.pop();
  }

  /**
   * Surface the members of a TypeScript `type X = { ... }` (or intersection
   * thereof) as `property` / `method` nodes under the type-alias node. Only
   * walks the immediate object_type / intersection operands so anonymous
   * nested object types inside generic arguments (`Promise<{ ok: true }>`)
   * don't produce phantom members.
   */
  private extractTsTypeAliasMembers(value: SyntaxNode, typeAliasNode: Node): void {
    const objectTypes: SyntaxNode[] = [];
    if (value.type === 'object_type') {
      objectTypes.push(value);
    } else if (value.type === 'intersection_type') {
      for (let i = 0; i < value.namedChildCount; i++) {
        const op = value.namedChild(i);
        if (op && op.type === 'object_type') objectTypes.push(op);
      }
    } else {
      return;
    }

    this.nodeStack.push(typeAliasNode.id);
    for (const objType of objectTypes) {
      for (let i = 0; i < objType.namedChildCount; i++) {
        const child = objType.namedChild(i);
        if (!child) continue;
        if (child.type !== 'property_signature' && child.type !== 'method_signature') continue;

        const nameNode = getChildByField(child, 'name');
        const memberName = nameNode ? getNodeText(nameNode, this.source) : '';
        if (!memberName) continue;

        // `foo: () => T` and `foo(): T` are functionally a method on the
        // type contract. Treat the property_signature with a function-typed
        // annotation as a method too so call sites can resolve to it.
        const memberKind: NodeKind = child.type === 'method_signature'
          ? 'method'
          : this.isTsFunctionTypedProperty(child) ? 'method' : 'property';

        const docstring = getPrecedingDocstring(child, this.source);
        const signature = getNodeText(child, this.source);
        this.createNode(memberKind, memberName, child, {
          docstring,
          signature,
          qualifiedName: `${typeAliasNode.name}::${memberName}`,
        });

        // Emit `references` edges from the type alias to types named in the
        // member's signature, matching the interface-member behavior added in
        // #432. We attach refs to the type-alias parent (consistent with
        // interface property_signature treatment).
        this.extractTypeAnnotations(child, typeAliasNode.id);
      }
    }
    this.nodeStack.pop();
  }

  /**
   * Surface the string-literal "names" of a TypeScript service/contract
   * registry written as a tuple of generic instantiations:
   *
   *   type MyServiceList = [
   *     Service<'query_apply_record', Req, Resp>,
   *     Service<'apply_confirm', Req, Resp>,
   *   ];
   *
   * Each `Service<'name', …>` tags an entry with a string-literal name that a
   * dynamic factory (`createService<MyServiceList>()`) turns into a callable
   * property (`api.query_apply_record(…)`). Static extraction otherwise never
   * sees that name — it's a type argument, not a declaration — so
   * `codegraph query query_apply_record` returned nothing (issue #634). We emit
   * each name as a `method` node under the type alias (qualifiedName
   * `MyServiceList::query_apply_record`) so it's searchable and resolvable as a
   * symbol. (A call through the proxy, `api.query_apply_record(…)`, still
   * resolves to the imported `api` binding — the receiver's type isn't known —
   * so this fixes discoverability, not the per-method call edge.)
   *
   * Scope is deliberately narrow to avoid noise: only a string literal that is
   * a DIRECT type argument of a `generic_type` that is itself a DIRECT element
   * of a `tuple_type`. This excludes utility types (`Pick`/`Omit`/`Record` are
   * never written as tuples) and string args nested deeper
   * (`Service<'a', Pick<U, 'id'>>` yields only `a`, never `id`). Names must be
   * valid identifiers, which also rules out route paths / arbitrary strings.
   */
  private extractTsTupleContractNames(value: SyntaxNode, typeAliasNode: Node): void {
    const tuples: SyntaxNode[] = [];
    const collectTuples = (n: SyntaxNode, depth: number): void => {
      if (depth > 6) return; // a type expression is shallow; cap defensively
      if (n.type === 'tuple_type') tuples.push(n);
      for (let i = 0; i < n.namedChildCount; i++) {
        const c = n.namedChild(i);
        if (c) collectTuples(c, depth + 1);
      }
    };
    collectTuples(value, 0);
    if (tuples.length === 0) return;

    this.nodeStack.push(typeAliasNode.id);
    for (const tuple of tuples) {
      for (let i = 0; i < tuple.namedChildCount; i++) {
        const entry = tuple.namedChild(i);
        if (!entry || entry.type !== 'generic_type') continue;
        const typeArgs = getChildByField(entry, 'type_arguments');
        if (!typeArgs) continue;
        for (let j = 0; j < typeArgs.namedChildCount; j++) {
          const arg = typeArgs.namedChild(j);
          if (!arg || arg.type !== 'literal_type') continue;
          // literal_type wraps the actual literal; only a string is a name.
          const strNode = arg.namedChild(0);
          if (!strNode || strNode.type !== 'string') continue;
          const name = getNodeText(strNode, this.source)
            .trim()
            .replace(/^['"`]/, '')
            .replace(/['"`]$/, '');
          if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) continue;
          const signature = getNodeText(entry, this.source).replace(/\s+/g, ' ').trim().slice(0, 120);
          this.createNode('method', name, entry, {
            signature,
            qualifiedName: `${typeAliasNode.name}::${name}`,
          });
        }
      }
    }
    this.nodeStack.pop();
  }

  /**
   * `foo: () => T` → property_signature whose type_annotation contains a
   * `function_type`. Treat that as a method-shaped contract member, since
   * the call site `obj.foo()` has identical semantics to `bar(): T`.
   */
  private isTsFunctionTypedProperty(propertySignature: SyntaxNode): boolean {
    const typeAnno = getChildByField(propertySignature, 'type');
    if (!typeAnno) return false;
    for (let i = 0; i < typeAnno.namedChildCount; i++) {
      const inner = typeAnno.namedChild(i);
      if (inner && inner.type === 'function_type') return true;
    }
    return false;
  }

  // extractExportedVariables removed — the walker now descends into
  // export_statement children and the inner declaration's dedicated
  // extractor (extractVariable, extractFunction, extractClass, etc.)
  // handles the symbol with isExported=true via parent-walk in the
  // language extractor's isExported predicate.

  /**
   * Extract an import
   *
   * Creates an import node with the full import statement stored in signature for searchability.
   * Also creates unresolved references for resolution purposes.
   */
  private extractImport(node: SyntaxNode): void {
    if (!this.extractor) return;

    const importText = getNodeText(node, this.source).trim();

    // Try language-specific hook first
    if (this.extractor.extractImport) {
      const info = this.extractor.extractImport(node, this.source);
      if (info) {
        this.createNode('import', info.moduleName, node, {
          signature: info.signature,
        });
        // Create unresolved reference unless the hook handled it
        if (!info.handledRefs && info.moduleName && this.nodeStack.length > 0) {
          const parentId = this.nodeStack[this.nodeStack.length - 1];
          if (parentId) {
            this.unresolvedReferences.push({
              fromNodeId: parentId,
              referenceName: info.moduleName,
              referenceKind: 'imports',
              line: node.startPosition.row + 1,
              column: node.startPosition.column,
            });
          }
        }
        // Link each imported binding to its definition so imported-but-not-
        // called/typed symbols still record a cross-file dependency (TS/JS only).
        if (
          this.language === 'typescript' || this.language === 'tsx' ||
          this.language === 'javascript' || this.language === 'jsx'
        ) {
          const parentId = this.nodeStack[this.nodeStack.length - 1];
          if (parentId) this.emitImportBindingRefs(node, parentId);
        }
        // Python `from module import X, Y` — link each imported name to its
        // definition (covers `__init__.py` re-export barrels, which are just
        // `from .sub import X`). Same recall gap as TS: a name imported and
        // used in a non-call position created no dependency edge.
        if (this.language === 'python' && node.type === 'import_from_statement') {
          const parentId = this.nodeStack[this.nodeStack.length - 1];
          if (parentId) this.emitPyFromImportRefs(node, parentId);
        }
        // Rust `use crate::m::Item;` / `pub use self::sub::Item;` — link each
        // imported leaf to its definition. Covers `pub use` re-export hubs
        // (a `mod.rs` re-exporting submodule items, e.g. tokio's `fs/mod.rs`)
        // and items imported but used in non-call/non-type positions.
        if (this.language === 'rust' && node.type === 'use_declaration') {
          const parentId = this.nodeStack[this.nodeStack.length - 1];
          if (parentId) this.emitRustUseBindingRefs(node, parentId);
        }
        // PHP `use Foo\Bar\Baz;` — link to the namespace-qualified definition so
        // an imported-but-DI-injected contract (Laravel's pattern) records a
        // cross-file dependency. Grouped imports are handled in their own branch.
        if (this.language === 'php' && node.type === 'namespace_use_declaration') {
          const parentId = this.nodeStack[this.nodeStack.length - 1];
          if (parentId) this.emitPhpUseRefs(node, parentId);
        }
        // Ruby `require "lib/foo"` / `require_relative "../foo"` — resolve to the
        // required FILE so a file pulled in only by `require` (config-loaded
        // components, gems that don't autoload) records a cross-file dependency.
        if (this.language === 'ruby' && node.type === 'call') {
          const parentId = this.nodeStack[this.nodeStack.length - 1];
          if (parentId) this.emitRubyRequireRefs(node, parentId);
        }
        return;
      }
      // Hook returned null — fall through to multi-import inline handlers only
      // (hook returning null means "I didn't handle this" for multi-import cases,
      // NOT "use generic fallback" — the hook already declined)
    }

    // Multi-import cases that create multiple nodes (can't be expressed with single-return hook)

    // Python import_statement: import os, sys (creates one import per module)
    if (this.language === 'python' && node.type === 'import_statement') {
      const importParentId = this.nodeStack[this.nodeStack.length - 1];
      // A bare `import a.b.c` of an internal module (the standard Django
      // `AppConfig.ready(): import myapp.signals` registration pattern, and any
      // `import pkg.mod` used for its side effects) had no edge to the module
      // file — only `from x import y` was linked. Push an `imports` ref (like
      // Go) so the resolver maps the dotted path to its file. Stdlib/external
      // modules naturally don't resolve (no `os.py` file node in the repo).
      const pushModuleRef = (dotted: SyntaxNode): void => {
        if (!importParentId) return;
        this.unresolvedReferences.push({
          fromNodeId: importParentId,
          referenceName: getNodeText(dotted, this.source),
          referenceKind: 'imports',
          line: dotted.startPosition.row + 1,
          column: dotted.startPosition.column,
        });
      };
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'dotted_name') {
          this.createNode('import', getNodeText(child, this.source), node, {
            signature: importText,
          });
          pushModuleRef(child);
        } else if (child?.type === 'aliased_import') {
          const dottedName = child.namedChildren.find(c => c.type === 'dotted_name');
          if (dottedName) {
            this.createNode('import', getNodeText(dottedName, this.source), node, {
              signature: importText,
            });
            pushModuleRef(dottedName);
          }
        }
      }
      return;
    }

    // Go imports: single or grouped (creates one import per spec)
    if (this.language === 'go') {
      const parentId = this.nodeStack.length > 0 ? this.nodeStack[this.nodeStack.length - 1] : null;
      const extractFromSpec = (spec: SyntaxNode): void => {
        const stringLiteral = spec.namedChildren.find(c => c.type === 'interpreted_string_literal');
        if (stringLiteral) {
          const importPath = getNodeText(stringLiteral, this.source).replace(/['"]/g, '');
          if (importPath) {
            this.createNode('import', importPath, spec, {
              signature: getNodeText(spec, this.source).trim(),
            });
            // Create unresolved reference so the resolver can create imports edges
            if (parentId) {
              this.unresolvedReferences.push({
                fromNodeId: parentId,
                referenceName: importPath,
                referenceKind: 'imports',
                line: spec.startPosition.row + 1,
                column: spec.startPosition.column,
              });
            }
          }
        }
      };

      const importSpecList = node.namedChildren.find(c => c.type === 'import_spec_list');
      if (importSpecList) {
        for (const spec of importSpecList.namedChildren.filter(c => c.type === 'import_spec')) {
          extractFromSpec(spec);
        }
      } else {
        const importSpec = node.namedChildren.find(c => c.type === 'import_spec');
        if (importSpec) {
          extractFromSpec(importSpec);
        }
      }
      return;
    }

    // PHP grouped imports: use X\{A, B} (creates one import per item)
    if (this.language === 'php') {
      const namespacePrefix = node.namedChildren.find(c => c.type === 'namespace_name');
      const useGroup = node.namedChildren.find(c => c.type === 'namespace_use_group');
      if (namespacePrefix && useGroup) {
        const prefix = getNodeText(namespacePrefix, this.source);
        const useClauses = useGroup.namedChildren.filter((c: SyntaxNode) =>
          c.type === 'namespace_use_group_clause' || c.type === 'namespace_use_clause'
        );
        for (const clause of useClauses) {
          const nsName = clause.namedChildren.find((c: SyntaxNode) => c.type === 'namespace_name');
          const name = nsName
            ? nsName.namedChildren.find((c: SyntaxNode) => c.type === 'name')
            : clause.namedChildren.find((c: SyntaxNode) => c.type === 'name');
          if (name) {
            const fullPath = `${prefix}\\${getNodeText(name, this.source)}`;
            this.createNode('import', fullPath, node, {
              signature: importText,
            });
            const parentId = this.nodeStack[this.nodeStack.length - 1];
            if (parentId) this.pushPhpUseRef(fullPath, parentId, node);
          }
        }
        return;
      }
    }

    // If a hook exists but returned null, it intentionally declined this node — don't create fallback
    if (this.extractor.extractImport) return;

    // Generic fallback for languages without hooks
    this.createNode('import', importText, node, {
      signature: importText,
    });
  }

  /**
   * Emit one `imports` reference per named/default import binding (TS/JS family),
   * attributed to the file node — so the resolver links each imported symbol to
   * the file that DEFINES it.
   *
   * Importing a symbol IS a dependency, but extraction only emits references for
   * calls, instantiations, type annotations, and inheritance. A symbol that's
   * imported and then only re-exported (`export { X } from './x'`), placed in a
   * registry array (`[expressResolver, …]`), passed as an argument, or used in
   * JSX produced NO cross-file edge at all — so the providing file showed a
   * false "0 dependents" and was invisible to blast-radius / `affected`. The
   * resolver maps the local name (alias-aware) to the provider's definition and
   * creates a cross-file `imports` edge; `getFileDependents` picks it up, while
   * `getImpactRadius` keeps it as a bounded leaf (the importing file node).
   *
   * Namespace imports (`import * as NS`) bind a whole module: `NS.member` calls
   * resolve on their own, but a namespace used ONLY via a value-member read
   * (`NS.SOME_CONST`) would leave no edge — so we also emit the namespace local
   * name, which the resolver links to the module FILE as a dependency backstop.
   */
  private emitImportBindingRefs(node: SyntaxNode, fromNodeId: string): void {
    const clause = node.namedChildren.find((c) => c.type === 'import_clause');
    if (!clause) return; // side-effect import (`import './x'`) — no bindings

    const pushRef = (nameNode: SyntaxNode | null | undefined): void => {
      if (!nameNode) return;
      const name = getNodeText(nameNode, this.source);
      if (!name) return;
      this.unresolvedReferences.push({
        fromNodeId,
        referenceName: name,
        referenceKind: 'imports',
        line: nameNode.startPosition.row + 1,
        column: nameNode.startPosition.column,
      });
    };

    for (const child of clause.namedChildren) {
      if (child.type === 'identifier') {
        // default import: `import Foo from './x'`
        pushRef(child);
      } else if (child.type === 'named_imports') {
        // `import { A, B as C } from './x'` — link the LOCAL name (alias if any)
        for (const spec of child.namedChildren) {
          if (spec.type !== 'import_specifier') continue;
          pushRef(getChildByField(spec, 'alias') ?? getChildByField(spec, 'name') ?? spec.namedChild(0));
        }
      } else if (child.type === 'namespace_import') {
        // `import * as NS from './x'` — emit NS so the module-import backstop can
        // record the file dependency even if NS is only used by value-member read.
        pushRef(child.namedChildren.find((c) => c.type === 'identifier') ?? child.namedChild(0));
      }
    }
  }

  /**
   * Emit one `imports` reference per re-exported binding of a
   * `export { A, B as C } from './y'` statement, attributed to the file node —
   * so a barrel that re-exports from another module records a dependency on it.
   *
   * Links the SOURCE-side name (`A`, the `name` field — not the local alias
   * `C`), since that is what the source module defines. `export * from './y'`
   * has no named bindings to attribute and `export { default as X }` can't be
   * name-matched, so both are skipped.
   */
  private emitReExportRefs(node: SyntaxNode, fromNodeId: string): void {
    const clause = node.namedChildren.find((c) => c.type === 'export_clause');
    if (!clause) return; // `export * from './y'` — no named bindings
    for (const spec of clause.namedChildren) {
      if (spec.type !== 'export_specifier') continue;
      const nameNode = getChildByField(spec, 'name') ?? spec.namedChild(0);
      if (!nameNode) continue;
      const name = getNodeText(nameNode, this.source);
      if (!name || name === 'default') continue;
      this.unresolvedReferences.push({
        fromNodeId,
        referenceName: name,
        referenceKind: 'imports',
        line: nameNode.startPosition.row + 1,
        column: nameNode.startPosition.column,
      });
    }
  }

  /**
   * Emit one `imports` reference per binding of a Rust `use` declaration —
   * `use crate::m::Item`, `use crate::m::{A, B as C}`, `pub use self::sub::Item`.
   * Emits the FULL path (e.g. `self::sub::Item`, not just `Item`) so the resolver
   * can resolve the module prefix to a file and find the leaf symbol there —
   * disambiguating common-name re-exports (`pub use self::read::read`, where the
   * leaf `read` collides with many same-named symbols). Falls back to name-match
   * on the leaf when the path can't be resolved. `use ...::*` has no leaf binding.
   */
  private emitRustUseBindingRefs(node: SyntaxNode, fromNodeId: string): void {
    const paths: { text: string; node: SyntaxNode }[] = [];
    const join = (prefix: string, seg: string): string => (prefix ? `${prefix}::${seg}` : seg);
    const collect = (n: SyntaxNode, prefix: string): void => {
      switch (n.type) {
        case 'identifier':
          paths.push({ text: join(prefix, getNodeText(n, this.source)), node: n });
          break;
        case 'scoped_identifier': {
          // Full scoped path (`a::b::C`); combine with any outer group prefix.
          const full = getNodeText(n, this.source).trim();
          paths.push({ text: prefix ? `${prefix}::${full}` : full, node: n });
          break;
        }
        case 'scoped_use_list': {
          // `path::{ ... }` — the group's path becomes the prefix for each item.
          const pathNode = getChildByField(n, 'path');
          const seg = pathNode ? getNodeText(pathNode, this.source).trim() : '';
          const newPrefix = seg ? join(prefix, seg) : prefix;
          const list = getChildByField(n, 'list') ?? n.namedChildren.find((c) => c.type === 'use_list');
          if (list) collect(list, newPrefix);
          break;
        }
        case 'use_list':
          for (let i = 0; i < n.namedChildCount; i++) {
            const c = n.namedChild(i);
            if (c) collect(c, prefix);
          }
          break;
        case 'use_as_clause': {
          // `Path as Alias` → link the source path (the definition), not the alias.
          const p = getChildByField(n, 'path') ?? n.namedChild(0);
          if (p) collect(p, prefix);
          break;
        }
        // use_wildcard → no specific binding to link.
      }
    };
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c) collect(c, '');
    }
    for (const p of paths) {
      // The leaf must be a real name (skip a path that is only `self`/`super`/`crate`).
      const leaf = p.text.split('::').pop();
      if (!leaf || leaf === 'self' || leaf === 'super' || leaf === 'crate' || leaf === '*') continue;
      this.unresolvedReferences.push({
        fromNodeId,
        referenceName: p.text,
        referenceKind: 'imports',
        line: p.node.startPosition.row + 1,
        column: p.node.startPosition.column,
      });
    }
  }

  /**
   * Emit an `imports` reference for a single PHP `use Foo\Bar\Baz;` (grouped
   * imports `use Foo\{A, B}` are handled where their per-item nodes are created).
   * The reference targets the namespace-qualified `Foo\Bar::Baz` form classes are
   * stored under (see the PHP `namespace` capture), so it resolves to the RIGHT
   * definition — Laravel has many same-named contracts (`Factory`, `Dispatcher`,
   * `Guard`) across namespaces that a bare-name match can't disambiguate.
   */
  private emitPhpUseRefs(node: SyntaxNode, fromNodeId: string): void {
    const clause = node.namedChildren.find((c: SyntaxNode) => c.type === 'namespace_use_clause');
    if (!clause) return;
    const qn = clause.namedChildren.find((c: SyntaxNode) => c.type === 'qualified_name')
      ?? clause.namedChildren.find((c: SyntaxNode) => c.type === 'name');
    if (qn) this.pushPhpUseRef(getNodeText(qn, this.source), fromNodeId, node);
  }

  /**
   * Ruby `require`/`require_relative` → an `imports` ref to the required FILE.
   * `require "sidekiq/fetch"` is load-path-relative (matched by file-path suffix
   * via {@link matchByFilePath}); `require_relative "../foo"` is resolved against
   * this file's directory. Bare gem/stdlib requires (`require "json"`, no slash)
   * are skipped — they're external. The path form (a `/` + `.rb`) makes the ref
   * resolve to the file node, so a file pulled in only by `require` — not by a
   * resolved constant/call — still records a cross-file dependency.
   */
  private emitRubyRequireRefs(node: SyntaxNode, fromNodeId: string): void {
    const method = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
    const mname = method ? getNodeText(method, this.source) : '';
    if (mname !== 'require' && mname !== 'require_relative') return;
    const argList = node.namedChildren.find((c: SyntaxNode) => c.type === 'argument_list');
    const str = argList?.namedChildren.find((c: SyntaxNode) => c.type === 'string');
    const content = str?.namedChildren.find((c: SyntaxNode) => c.type === 'string_content');
    if (!content) return;
    const req = getNodeText(content, this.source).trim();
    if (!req) return;

    let refPath: string;
    if (mname === 'require_relative') {
      const slash = this.filePath.lastIndexOf('/');
      const dir = slash >= 0 ? this.filePath.slice(0, slash) : '';
      refPath = path.posix.normalize(dir ? `${dir}/${req}` : req);
    } else {
      refPath = req; // load-path require — suffix-matched against the file path
    }
    if (!refPath.includes('/')) return; // bare gem/stdlib require — external
    if (!refPath.endsWith('.rb')) refPath += '.rb';
    this.unresolvedReferences.push({
      fromNodeId,
      referenceName: refPath,
      referenceKind: 'imports',
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
    });
  }

  /** Convert a PHP FQN `Foo\Bar\Baz` to the stored `Foo\Bar::Baz` and emit an `imports` ref. */
  private pushPhpUseRef(fqn: string, fromNodeId: string, node: SyntaxNode): void {
    const clean = fqn.replace(/^\\/, '');
    const lastSep = clean.lastIndexOf('\\');
    if (lastSep < 0) return; // global-namespace class — already matches by simple name
    this.unresolvedReferences.push({
      fromNodeId,
      referenceName: `${clean.slice(0, lastSep)}::${clean.slice(lastSep + 1)}`,
      referenceKind: 'imports',
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
    });
  }

  /**
   * Emit one `imports` reference per name imported in a Python
   * `from module import A, B as C` statement, attributed to the file node — so
   * the resolver links each imported name to the module that DEFINES it.
   *
   * Same recall gap as TS: extraction only emitted references for calls,
   * instantiations, and inheritance, so a name imported and then used in a
   * non-call position (a list/dict literal, a default argument, a decorator
   * target, or simply re-exported through an `__init__.py` barrel) produced no
   * cross-file edge — the providing module showed a false "0 dependents". Links
   * the LOCAL name (alias when present, since that's what the resolver's import
   * mapping keys on); `from module import *` has no names to attribute.
   */
  private emitPyFromImportRefs(node: SyntaxNode, fromNodeId: string): void {
    const moduleNameNode = getChildByField(node, 'module_name');
    for (const child of node.namedChildren) {
      // Skip the `from <module>` part itself and `import *`.
      if (moduleNameNode &&
          child.startIndex === moduleNameNode.startIndex &&
          child.endIndex === moduleNameNode.endIndex) continue;
      if (child.type === 'wildcard_import') continue;

      let nameNode: SyntaxNode | null | undefined = null;
      if (child.type === 'aliased_import') {
        nameNode = getChildByField(child, 'alias') ?? getChildByField(child, 'name') ?? child.namedChild(0);
      } else if (child.type === 'dotted_name') {
        nameNode = child;
      }
      if (!nameNode) continue;

      const raw = getNodeText(nameNode, this.source);
      // Imported names are simple identifiers; defensively take the last segment.
      const local = raw.includes('.') ? raw.split('.').pop()! : raw;
      if (!local) continue;
      this.unresolvedReferences.push({
        fromNodeId,
        referenceName: local,
        referenceKind: 'imports',
        line: nameNode.startPosition.row + 1,
        column: nameNode.startPosition.column,
      });
    }
  }

  /**
   * Extract a function call
   */
  private extractCall(node: SyntaxNode): void {
    if (this.nodeStack.length === 0) return;

    const callerId = this.nodeStack[this.nodeStack.length - 1];
    if (!callerId) return;

    // Get the function/method being called
    let calleeName = '';

    // Java/Kotlin method_invocation has 'object' + 'name' fields instead of 'function'
    // PHP member_call_expression has 'object' + 'name', scoped_call_expression has 'scope' + 'name'
    const nameField = getChildByField(node, 'name');
    const objectField = getChildByField(node, 'object') || getChildByField(node, 'scope');

    if (nameField && objectField && (node.type === 'method_invocation' || node.type === 'member_call_expression' || node.type === 'scoped_call_expression')) {
      // Method call with explicit receiver: receiver.method() / $receiver->method() / ClassName::method()
      const methodName = getNodeText(nameField, this.source);
      // Java `this.userbo.toLogin2()` parses as method_invocation(object=field_access(this, userbo)).
      // Without unwrapping, receiverName is `this.userbo` and the name-matcher's
      // single-dot receiver regex fails. Pull out the immediate field after `this.`
      // so the receiver is the field name (`userbo`), which the resolver can then
      // look up in the enclosing class's field declarations.
      // PHP static-factory fluent chain: `Cls::for($x)->method()` — the receiver
      // is itself a static call, so resolution must infer the method's class
      // from what `Cls::for` RETURNS (its `: self` / `: static` / `: Type`),
      // #608 (mirrors the C++ chain fix in #645). Encode `<Cls::factory>().<method>`;
      // the `().` marker lets the PHP resolver split it. The receiver text
      // (`Cls::for('x')`) carries the args, so without this it degrades to an
      // unresolvable string and the call edge is dropped.
      if (methodName && this.language === 'php' && objectField.type === 'scoped_call_expression') {
        const innerScope = getChildByField(objectField, 'scope');
        const innerName = getChildByField(objectField, 'name');
        if (innerScope && innerName) {
          calleeName = `${getNodeText(innerScope, this.source)}::${getNodeText(innerName, this.source)}().${methodName}`;
        } else {
          calleeName = methodName;
        }
        if (calleeName) {
          this.unresolvedReferences.push({
            fromNodeId: callerId,
            referenceName: calleeName,
            referenceKind: 'calls',
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
          });
        }
        return;
      }

      // Java static-factory / fluent chain: `Foo.getInstance().bar()` — the
      // receiver is itself a method call, so resolution must infer bar's class
      // from what `Foo.getInstance` RETURNS (its declared return type), the
      // #645/#608 mechanism. Encode `<inner-receiver>.<inner-method>().<method>`;
      // the `().` marker lets the Java chain resolver split it, and normalizing to
      // empty parens drops any factory args (`Foo.create(cfg).bar()`) that would
      // otherwise leave a `(cfg)` in the receiver text and break the split.
      if (
        methodName &&
        this.language === 'java' &&
        objectField.type === 'method_invocation'
      ) {
        const innerObj = getChildByField(objectField, 'object');
        const innerName = getChildByField(objectField, 'name');
        if (innerObj && innerName) {
          calleeName = `${getNodeText(innerObj, this.source)}.${getNodeText(innerName, this.source)}().${methodName}`;
          this.unresolvedReferences.push({
            fromNodeId: callerId,
            referenceName: calleeName,
            referenceKind: 'calls',
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
          });
          return;
        }
      }

      let receiverName: string;
      if (objectField.type === 'field_access') {
        const inner = getChildByField(objectField, 'object');
        const fld = getChildByField(objectField, 'field');
        if (inner && fld && (inner.type === 'this' || inner.type === 'this_expression')) {
          receiverName = getNodeText(fld, this.source);
        } else {
          receiverName = getNodeText(objectField, this.source);
        }
      } else {
        receiverName = getNodeText(objectField, this.source);
      }
      // Strip PHP $ prefix from variable names
      receiverName = receiverName.replace(/^\$/, '');

      if (methodName) {
        // Skip self/this/parent/static receivers — they don't aid resolution
        const SKIP_RECEIVERS = new Set(['self', 'this', 'cls', 'super', 'parent', 'static']);
        if (SKIP_RECEIVERS.has(receiverName)) {
          calleeName = methodName;
        } else {
          calleeName = `${receiverName}.${methodName}`;
        }
      }
    } else if (node.type === 'message_expression') {
      // ObjC message expressions emit one `method` field child per selector
      // keyword: `[obj a:1 b:2 c:3]` has three `method=identifier` siblings.
      // Joining them with `:` reconstructs the full selector and matches the
      // multi-part selector names produced by the ObjC method_definition
      // extractor (`extractObjcMethodName` in languages/objc.ts). Without this
      // join, multi-keyword call sites only emitted the first keyword and never
      // resolved to their target methods (e.g. `GET:parameters:headers:...` had
      // zero callers despite obviously being called).
      const methodKeywords: string[] = [];
      for (let i = 0; i < node.namedChildCount; i++) {
        if (node.fieldNameForNamedChild(i) === 'method') {
          const kw = node.namedChild(i);
          if (kw) methodKeywords.push(getNodeText(kw, this.source));
        }
      }
      if (methodKeywords.length > 0) {
        // A selector keyword takes a `:` when it has an argument. A SINGLE
        // keyword can be unary (`[c reset]` → `reset`) OR take one argument
        // (`[c storeImage:k]` → `storeImage:`) — distinguished by whether the
        // message has a `:` token. Without this, every single-argument message
        // (the most common form: `addObject:`, `storeImage:`, …) was named
        // without the colon and never matched its `storeImage:` method.
        let hasColon = false;
        for (let i = 0; i < node.childCount; i++) {
          if (node.child(i)?.type === ':') { hasColon = true; break; }
        }
        const methodName: string = hasColon
          ? methodKeywords.map((k) => `${k}:`).join('')
          : (methodKeywords[0] as string);
        const receiverField = getChildByField(node, 'receiver');
        const SKIP_RECEIVERS = new Set(['self', 'super']);
        if (receiverField && receiverField.type !== 'message_expression') {
          const receiverName = getNodeText(receiverField, this.source);
          if (receiverName && !SKIP_RECEIVERS.has(receiverName)) {
            calleeName = `${receiverName}.${methodName}`;
            // A CLASS-message receiver (`[SDImageCache alloc]`,
            // `[SDImageCache sharedCache]`) is a capitalized class name. The
            // call resolves the method (`alloc`/`sharedCache`), but the CLASS
            // itself — whose @interface lives in the header — would otherwise
            // never be referenced. Emit a `references` edge to it so a class
            // used only via class messages (alloc/init, singletons, factories)
            // and its header record a dependent.
            if (/^[A-Z][A-Za-z0-9_]*$/.test(receiverName)) {
              this.unresolvedReferences.push({
                fromNodeId: callerId,
                referenceName: receiverName,
                referenceKind: 'references',
                line: receiverField.startPosition.row + 1,
                column: receiverField.startPosition.column,
              });
            }
          } else {
            calleeName = methodName;
          }
        } else {
          calleeName = methodName;
        }
      }
    } else {
      const func = getChildByField(node, 'function') || node.namedChild(0);

      if (func) {
        if (func.type === 'member_expression' || func.type === 'attribute' || func.type === 'selector_expression' || func.type === 'navigation_expression' || func.type === 'field_expression') {
          // Method call: obj.method() or obj.field.method()
          // Go uses selector_expression with 'field', JS/TS uses member_expression with 'property'
          // Kotlin uses navigation_expression with navigation_suffix > simple_identifier
          // C/C++ use field_expression for both `obj.method()` and `ptr->method()`
          let property = getChildByField(func, 'property') || getChildByField(func, 'field');
          if (!property) {
            const child1 = func.namedChild(1);
            // Kotlin: navigation_suffix wraps the method name — extract simple_identifier from it
            if (child1?.type === 'navigation_suffix') {
              property = child1.namedChildren.find((c: SyntaxNode) => c.type === 'simple_identifier') ?? child1;
            } else {
              property = child1;
            }
          }
          if (property) {
            const methodName = getNodeText(property, this.source);
            // Include receiver name for qualified resolution (e.g., console.print → "console.print")
            // This helps the resolver distinguish method calls from bare function calls
            // (e.g., Python's console.print() vs builtin print())
            // Skip self/this/cls as they don't aid resolution
            const receiver =
              getChildByField(func, 'object') ||
              getChildByField(func, 'operand') ||
              getChildByField(func, 'argument') ||
              func.namedChild(0);
            const SKIP_RECEIVERS = new Set(['self', 'this', 'cls', 'super']);
            if (receiver && (receiver.type === 'identifier' || receiver.type === 'simple_identifier' || receiver.type === 'field_identifier')) {
              const receiverName = getNodeText(receiver, this.source);
              if (!SKIP_RECEIVERS.has(receiverName)) {
                calleeName = `${receiverName}.${methodName}`;
              } else {
                calleeName = methodName;
              }
            } else if (
              (this.language === 'cpp' ||
                this.language === 'c' ||
                this.language === 'kotlin' ||
                this.language === 'swift' ||
                this.language === 'rust' ||
                this.language === 'go' ||
                this.language === 'scala') &&
              receiver &&
              receiver.type === 'call_expression'
            ) {
              // Receiver that is itself a call — `Foo::instance().bar()`,
              // `openSession()->run()`, `mgr.view().render()` (C/C++),
              // `Foo.getInstance().bar()` (Kotlin) / `Foo.make().draw()` (Swift),
              // `Foo::new().bar()` (Rust), or `New().Method()` (Go). Keep the inner
              // call so resolution can infer bar()'s class from what the inner call
              // RETURNS (#645/#608). Encode as `<innerCallee>().<method>`; the `().`
              // marker never appears in an ordinary ref, so the resolver can detect
              // and split it. Other languages keep the bare-name behavior below.
              let innerCallee: string;
              let reencode: boolean;
              if (this.language === 'kotlin' || this.language === 'swift') {
                // tree-sitter-kotlin/swift expose the inner callee as the
                // call_expression's first named child (a navigation_expression
                // `Foo.getInstance`, or a bare identifier for a free/constructor call).
                const innerNav = receiver.namedChild(0);
                innerCallee = innerNav ? getNodeText(innerNav, this.source).replace(/\s+/g, '') : '';
                // Only re-encode a CLASS / companion-factory / constructor chain,
                // whose receiver chain starts with a capitalized type
                // (`Foo.getInstance().bar()`, `Foo().bar()`). An instance chain
                // (`list.filter{}.map{}`) has a lowercase receiver whose type we
                // can't recover here — re-encoding it would only drop the edge (no
                // chain resolution, no bare-name fallback), regressing recall in
                // fluent codebases. Leave those to the bare-name path.
                reencode = /^[A-Z]/.test(innerCallee);
              } else {
                const innerFn = getChildByField(receiver, 'function');
                innerCallee = innerFn
                  ? getNodeText(innerFn, this.source).replace(/->/g, '.').replace(/\s+/g, '')
                  : '';
                // Rust: only re-encode an associated-function chain
                // (`Foo::new().bar()`), whose inner callee is a path/`scoped_identifier`.
                // Go: only a bare package-level factory chain (`New().Method()`),
                // whose inner callee is an `identifier`. An instance chain
                // (`x.foo().bar()` Rust, `obj.Method().Other()` Go) keeps bare-name —
                // the resolver can't recover a variable's type, so re-encoding would
                // only drop the edge. C/C++ re-encode any inner.
                if (this.language === 'rust') reencode = innerFn?.type === 'scoped_identifier';
                else if (this.language === 'go') reencode = innerFn?.type === 'identifier';
                // Scala: only a companion-factory / case-class-apply chain whose
                // receiver chain starts with a capitalized type (`Foo.create().bar()`,
                // `Foo(args).bar()`). An instance chain (`list.map().filter()`) has a
                // lowercase receiver whose type we can't recover — leave it bare.
                else if (this.language === 'scala') reencode = /^[A-Z]/.test(innerCallee);
                else reencode = !!innerCallee;
              }
              calleeName = reencode ? `${innerCallee}().${methodName}` : methodName;
            } else {
              calleeName = methodName;
            }
          }
        } else if (func.type === 'scoped_identifier' || func.type === 'scoped_call_expression') {
          // Scoped call: Module::function()
          calleeName = getNodeText(func, this.source);
        } else if (this.language === 'csharp' && func.type === 'member_access_expression') {
          // C# member call `recv.Method(...)`. When the receiver is itself a call
          // — a chained factory `Foo.Create(args).Bar()` — encode `inner().Bar`
          // with normalized empty parens so resolution can infer Bar's class from
          // what `Foo.Create` RETURNS (#645/#608). A non-call receiver keeps the
          // full member-access text (the existing `recv.Method` behavior).
          const recv = getChildByField(func, 'expression');
          const nameNode = getChildByField(func, 'name');
          const methodName = nameNode ? getNodeText(nameNode, this.source) : '';
          if (recv && recv.type === 'invocation_expression' && methodName) {
            const innerFunc = getChildByField(recv, 'function');
            const innerCallee = innerFunc ? getNodeText(innerFunc, this.source).replace(/\s+/g, '') : '';
            calleeName = innerCallee ? `${innerCallee}().${methodName}` : methodName;
          } else {
            calleeName = getNodeText(func, this.source);
          }
        } else {
          calleeName = getNodeText(func, this.source);
        }
      }
    }

    // Parenthesized type conversions — Go `(*T)(x)` / `(T)(x)` (and a
    // parenthesized callee generally) parse as a call whose "function" is a
    // parenthesized type/expression, so the callee text is the un-resolvable
    // literal `(*T)`. Normalize to the inner name so it resolves to `T` (a real
    // dependency on the converted-to type) instead of dropping on the floor.
    if (calleeName) {
      const conv = calleeName.match(/^\(\s*\*?\s*([A-Za-z_][\w.]*)\s*\)$/);
      if (conv && conv[1]) calleeName = conv[1];
    }

    if (calleeName) {
      this.unresolvedReferences.push({
        fromNodeId: callerId,
        referenceName: calleeName,
        referenceKind: 'calls',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
  }

  /**
   * `new Foo(...)` / `Foo::new(...)` / object_creation_expression —
   * emit an `instantiates` reference to the class name. The resolver
   * then links it to the class node, producing the `instantiates`
   * edge that powers "what creates instances of X" queries.
   *
   * Children are still walked so nested calls inside the constructor
   * arguments (`new Foo(bar())`) get their own `calls` references.
   */
  private extractInstantiation(node: SyntaxNode): void {
    if (this.nodeStack.length === 0) return;
    const fromId = this.nodeStack[this.nodeStack.length - 1];
    if (!fromId) return;

    // The class name is in the `constructor`/`type`/first-named-child
    // depending on grammar.
    const ctor =
      getChildByField(node, 'constructor') ||
      getChildByField(node, 'type') ||
      getChildByField(node, 'name') ||
      node.namedChild(0);
    if (!ctor) return;

    // Go composite literals: `Widget{...}` (same package) and `pkga.Widget{...}`
    // (cross-package). Only a directly-named struct type is a meaningful
    // instantiation target — skip slice/map/array literals (`[]T{}`,
    // `map[K]V{}`) whose `type` field is a composite type, not a named type.
    // Unlike `new ns.Foo()`, KEEP the package qualifier (`pkga.Widget`) so the
    // Go cross-package resolver can disambiguate it to the right package's type.
    if (node.type === 'composite_literal') {
      if (ctor.type !== 'type_identifier' && ctor.type !== 'qualified_type') return;
      let goType = getNodeText(ctor, this.source).trim();
      const brIdx = goType.indexOf('['); // strip Go generic args: `Box[T]{}` -> `Box`
      if (brIdx > 0) goType = goType.slice(0, brIdx).trim();
      if (goType) {
        this.unresolvedReferences.push({
          fromNodeId: fromId,
          referenceName: goType,
          referenceKind: 'instantiates',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
      return;
    }

    // Scala: `new Monoid[Int] { ... }` — the constructor is a `generic_type`
    // (or qualified `stable_type_identifier`) using `[...]` type args, which the
    // generic `<...>` strip below misses. Unwrap to the base type name.
    if (node.type === 'instance_expression') {
      const name = scalaBaseTypeName(ctor, this.source);
      if (name) {
        this.unresolvedReferences.push({
          fromNodeId: fromId,
          referenceName: name,
          referenceKind: 'instantiates',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
      return;
    }

    let className = getNodeText(ctor, this.source);
    // Strip type-argument suffix first: `new Map<K, V>()` would
    // otherwise produce className 'Map<K, V>' (the constructor
    // field is a `generic_type` node) and resolution would fail
    // because no class is named with the angle-bracket suffix.
    const ltIdx = className.indexOf('<');
    if (ltIdx > 0) className = className.slice(0, ltIdx);
    // For namespaced/qualified constructors (`new ns.Foo()`,
    // `new ns::Foo()`) keep the trailing identifier — that's what
    // matches a class node in the index.
    const lastDot = Math.max(
      className.lastIndexOf('.'),
      className.lastIndexOf('::')
    );
    if (lastDot >= 0) className = className.slice(lastDot + 1).replace(/^[:.]/, '');
    className = className.trim();

    if (className) {
      this.unresolvedReferences.push({
        fromNodeId: fromId,
        referenceName: className,
        referenceKind: 'instantiates',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
  }

  /**
   * Static-member / value-read pass. A type/enum/class used only via a member
   * VALUE — `Enum.value`, `Type.CONST`, `Colors.red`, `Foo::BAR` — recorded no
   * edge, because the body walker only handled CALLS (`Type.method()`). So a
   * type referenced only by an enum value or a static field looked like nothing
   * depended on it (the residual frontier across Dart/Java/C#/Swift/Kotlin/PHP).
   * Emit a `references` edge to the capitalized receiver. Gated to languages
   * where types are Capitalized by convention, and skipped when the access is a
   * call's callee (the call extractor already links the method).
   */
  private extractStaticMemberRef(node: SyntaxNode): void {
    if (!STATIC_MEMBER_LANGS.has(this.language)) return;
    if (this.nodeStack.length === 0) return;
    const ownerId = this.nodeStack[this.nodeStack.length - 1];
    if (!ownerId) return;

    // Dart structures member access as an `identifier` + a sibling `selector`,
    // not a single node. A value-read selector (no `argument_part`) whose
    // previous sibling is a capitalized identifier is `Enum.value`.
    if (this.language === 'dart') {
      if (node.type !== 'selector') return;
      if (node.namedChildren.some((c: SyntaxNode) => c.type === 'argument_part')) return;
      const prev = node.previousNamedSibling;
      if (prev?.type === 'identifier' && /^[A-Z][A-Za-z0-9_]*$/.test(prev.text)) {
        this.pushStaticMemberRef(prev.text, ownerId, prev);
      }
      return;
    }

    if (!MEMBER_ACCESS_TYPES.has(node.type)) return;

    // Skip `Type.method()` — the access is the callee of a call, already linked.
    const parent = node.parent;
    if (parent && this.extractor!.callTypes.includes(parent.type)) {
      const callee =
        getChildByField(parent, 'function') ??
        getChildByField(parent, 'method') ??
        parent.namedChild(0);
      if (callee && callee.startIndex === node.startIndex) return;
    }

    // The receiver must be a SIMPLE capitalized identifier — `Type.X`, not the
    // nested `a.B.c` (whose own head member-access is visited separately) nor a
    // lowercase `obj.field` / `pkg.func`.
    const recv =
      getChildByField(node, 'object') ??
      getChildByField(node, 'expression') ??
      getChildByField(node, 'scope') ??
      node.namedChild(0);
    if (!recv) return;
    const t = recv.type;
    if (
      t === 'identifier' || t === 'type_identifier' || t === 'simple_identifier' ||
      t === 'name' || t === 'scoped_type_identifier'
    ) {
      const text = getNodeText(recv, this.source);
      if (/^[A-Z][A-Za-z0-9_]*$/.test(text)) this.pushStaticMemberRef(text, ownerId, recv);
    }
  }

  private pushStaticMemberRef(name: string, ownerId: string, node: SyntaxNode): void {
    this.unresolvedReferences.push({
      fromNodeId: ownerId,
      referenceName: name,
      referenceKind: 'references',
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
    });
  }

  /**
   * Find a `class_body` child of an `object_creation_expression` — the
   * marker for an anonymous class (`new T() { ... }`). Returns the body
   * node so the caller can walk it as the anon class's members.
   */
  private findAnonymousClassBody(node: SyntaxNode): SyntaxNode | null {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      // Java: `class_body`. C# uses the same node kind.
      if (child && (child.type === 'class_body' || child.type === 'declaration_list')) {
        return child;
      }
    }
    return null;
  }

  /**
   * Extract a Java/C# anonymous class — `new T() { ...members }`. Emits a
   * `class` node named `<T$anon@line>`, an `extends` reference to T (so
   * Phase 5.5 interface-impl can bridge), and walks the body so its
   * `method_declaration` members become method nodes under the anon class.
   *
   * Why this matters: without anon-class extraction, the overrides inside
   * a lambda-returned `new T() { @Override int foo(){...} }` are not nodes,
   * so a call through T.foo (the abstract parent method) has no static
   * target — the agent has to Read the file to find the implementation.
   */
  private extractAnonymousClass(node: SyntaxNode, body: SyntaxNode): void {
    if (!this.extractor) return;

    // The instantiated type sits in the same field/position that
    // extractInstantiation reads from. Use the same lookup so the anon
    // class's `extends` target matches the `instantiates` edge.
    const typeNode =
      getChildByField(node, 'constructor') ||
      getChildByField(node, 'type') ||
      getChildByField(node, 'name') ||
      node.namedChild(0);
    let typeName = typeNode ? getNodeText(typeNode, this.source) : 'Object';
    const ltIdx = typeName.indexOf('<');
    if (ltIdx > 0) typeName = typeName.slice(0, ltIdx);
    const lastDot = Math.max(typeName.lastIndexOf('.'), typeName.lastIndexOf('::'));
    if (lastDot >= 0) typeName = typeName.slice(lastDot + 1).replace(/^[:.]/, '');
    typeName = typeName.trim() || 'Object';

    const anonName = `<${typeName}$anon@${node.startPosition.row + 1}>`;
    const classNode = this.createNode('class', anonName, node, {});
    if (!classNode) return;

    // The anonymous class implicitly extends/implements the named type.
    // We can't tell at extraction time whether T is a class or an interface,
    // so emit `extends`. Resolution will still bind T to whatever it is, and
    // Phase 5.5 (which already handles both `extends` and `implements`) will
    // bridge T's methods to the override names found in the anon body.
    this.unresolvedReferences.push({
      fromNodeId: classNode.id,
      referenceName: typeName,
      referenceKind: 'extends',
      line: typeNode?.startPosition.row ?? node.startPosition.row,
      column: typeNode?.startPosition.column ?? node.startPosition.column,
    });

    // Walk the body's children so method_declaration nodes inside become
    // method nodes scoped to the anon class.
    this.nodeStack.push(classNode.id);
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (child) this.visitNode(child);
    }
    this.nodeStack.pop();
  }

  /**
   * Scan `declNode` and its preceding siblings (within the parent's
   * named children) for decorator nodes, emitting a `decorates`
   * reference from `decoratedId` to each decorator's function name.
   *
   * Why preceding siblings: in TypeScript, `@Foo class Bar {}` parses
   * as an `export_statement` (or top-level wrapper) with the
   * `decorator` as a child *before* the `class_declaration` — so the
   * decorator isn't a child of the class itself. For methods/
   * properties, the decorator IS a direct child of the declaration,
   * so we also scan declNode.namedChildren.
   *
   * Idempotent across grammars: if neither location yields decorators
   * (most non-decorator-using languages), the function is a no-op.
   */
  private extractDecoratorsFor(declNode: SyntaxNode, decoratedId: string): void {
    const consider = (n: SyntaxNode | null): void => {
      if (!n) return;
      // `marker_annotation` is Java's grammar for arg-less annotations
      // (`@Override`, `@Deprecated`); `attribute` is Swift's grammar for
      // attributes and PROPERTY WRAPPERS (`@objc`, `@Argument`, `@Published`,
      // `@State`). Without these, those usages would be silently skipped.
      if (
        n.type !== 'decorator' &&
        n.type !== 'annotation' &&
        n.type !== 'marker_annotation' &&
        n.type !== 'attribute'
      ) {
        return;
      }
      // Find the leading identifier: skip the `@` punct, unwrap
      // a call_expression if the decorator is invoked with args.
      let target: SyntaxNode | null = null;
      for (let i = 0; i < n.namedChildCount; i++) {
        const child = n.namedChild(i);
        if (!child) continue;
        if (child.type === 'call_expression') {
          const fn = getChildByField(child, 'function') ?? child.namedChild(0);
          if (fn) target = fn;
          if (target) break;
        }
        if (
          child.type === 'identifier' ||
          child.type === 'member_expression' ||
          child.type === 'scoped_identifier' ||
          child.type === 'navigation_expression' ||
          child.type === 'user_type' ||      // swift attribute → user_type (`@Argument`)
          child.type === 'type_identifier'
        ) {
          target = child;
          break;
        }
      }
      if (!target) return;
      let name = getNodeText(target, this.source);
      const lt = name.indexOf('<'); // strip generic args: `@Argument<T>` → `Argument`
      if (lt > 0) name = name.slice(0, lt);
      const lastDot = Math.max(name.lastIndexOf('.'), name.lastIndexOf('::'));
      if (lastDot >= 0) name = name.slice(lastDot + 1).replace(/^[:.]/, '');
      name = name.trim();
      if (!name) return;
      this.unresolvedReferences.push({
        fromNodeId: decoratedId,
        referenceName: name,
        referenceKind: 'decorates',
        line: n.startPosition.row + 1,
        column: n.startPosition.column,
      });
    };

    // 1. Decorators that are direct children of the declaration
    //    (method/property style, also some grammars for class).
    for (let i = 0; i < declNode.namedChildCount; i++) {
      const child = declNode.namedChild(i);
      consider(child);
      // Java/Kotlin/C# put annotations INSIDE a `modifiers` node
      // (`@MyAnno public class X` → class_declaration → modifiers → annotation),
      // so descend into it — otherwise every annotation usage is silently
      // dropped and annotation types show zero dependents.
      if (child && child.type === 'modifiers') {
        for (let j = 0; j < child.namedChildCount; j++) {
          consider(child.namedChild(j));
        }
      }
    }

    // 2. Decorators that are PRECEDING siblings of the declaration
    //    inside the parent's children (TypeScript class style).
    //    Walk BACKWARDS from the declaration and stop at the first
    //    non-decorator sibling — without that stop, decorators
    //    belonging to an EARLIER unrelated declaration leak in
    //    (e.g. `@A class Foo {} @B class Bar {}` would otherwise
    //    attribute @A to Bar).
    //
    //    Note on identity: tree-sitter web bindings return fresh JS
    //    wrapper objects from `parent`/`namedChild` navigation, so
    //    `sibling === declNode` is unreliable — `startIndex` does
    //    the matching instead.
    const parent = declNode.parent;
    if (parent) {
      const declStart = declNode.startIndex;
      let declIdx = -1;
      for (let i = 0; i < parent.namedChildCount; i++) {
        const sibling = parent.namedChild(i);
        if (sibling && sibling.startIndex === declStart) {
          declIdx = i;
          break;
        }
      }
      if (declIdx > 0) {
        for (let j = declIdx - 1; j >= 0; j--) {
          const sibling = parent.namedChild(j);
          if (!sibling) continue;
          if (sibling.type !== 'decorator' && sibling.type !== 'annotation' && sibling.type !== 'marker_annotation') {
            break; // non-decorator separator → stop consuming
          }
          consider(sibling);
        }
      }
    }
  }

  /**
   * Visit function body and extract calls (and structural nodes).
   *
   * In addition to call expressions, this also detects class/struct/enum
   * definitions inside function bodies. This handles two cases:
   *   1. Local class/struct/enum definitions (valid in C++, Java, etc.)
   *   2. C++ macro misparsing — macros like NLOHMANN_JSON_NAMESPACE_BEGIN cause
   *      tree-sitter to interpret the namespace block as a function_definition,
   *      hiding real class/struct/enum nodes inside the "function body".
   */
  /**
   * Rocket route-registration macros — `routes![a::b::handler, c::d::other]`
   * and `catchers![not_found]`. Tree-sitter leaves a macro body as a flat
   * `token_tree` of raw tokens (`identifier`, `::`, `,`), so the handler paths
   * are never seen as references and each handler fn looks like it has no caller
   * — it's mounted by Rocket at runtime, not called by in-repo code, so its file
   * shows 0 dependents. Walk the token tree, reconstruct each comma-separated
   * path, and emit a `references` edge; the Rust path resolver
   * (`resolveRustPathReference`) then links it to the handler fn. The handler
   * names are explicit in source, so this is precise static extraction, not a
   * heuristic — no false edges (resolution still validates each path).
   */
  private extractRustRouteMacro(node: SyntaxNode): void {
    if (this.language !== 'rust') return;
    const macroName = node.namedChild(0);
    if (!macroName) return;
    const name = getNodeText(macroName, this.source);
    if (name !== 'routes' && name !== 'catchers') return;
    const tokenTree = node.namedChildren.find((c: SyntaxNode) => c.type === 'token_tree');
    if (!tokenTree) return;
    const fromId = this.nodeStack[this.nodeStack.length - 1];
    if (!fromId) return;

    // The token tree is a flat stream: `[ id :: id :: id , id … ]`. Group runs
    // of `identifier` tokens (the `::` joiners are anonymous) into one path; a
    // `,` (or the closing `]`) ends a path.
    let parts: string[] = [];
    let line = 0;
    let column = 0;
    const flush = (): void => {
      if (parts.length > 0) {
        this.unresolvedReferences.push({
          fromNodeId: fromId,
          referenceName: parts.join('::'),
          referenceKind: 'references',
          line,
          column,
        });
        parts = [];
      }
    };
    for (let i = 0; i < tokenTree.childCount; i++) {
      const t = tokenTree.child(i);
      if (!t) continue;
      if (t.type === 'identifier') {
        if (parts.length === 0) {
          line = t.startPosition.row + 1;
          column = t.startPosition.column;
        }
        parts.push(getNodeText(t, this.source));
      } else if (t.type === ',') {
        flush();
      }
    }
    flush();
  }

  private visitFunctionBody(
    body: SyntaxNode,
    _functionId: string,
    leakedGlobalNames?: Set<string>,
    preVisitedNodes?: Set<number>,
  ): void {
    if (!this.extractor) return;

    const visitForCallsAndStructure = (node: SyntaxNode): void => {
      const nodeType = node.type;

      // Rocket route-registration macros (`routes![…]` / `catchers![…]`): the
      // handler paths live in a raw token tree the call walker can't see.
      if (nodeType === 'macro_invocation') this.extractRustRouteMacro(node);

      // C/C++: function-body-local `#define` directives. tree-sitter parses
      // `#define` inside a compound_statement as preproc_def /
      // preproc_function_def, but visitFunctionBody — unlike visitNode —
      // had no macroTypes branch, so function-local macros were silently
      // dropped AND their parameter identifiers fell through to the default
      // identifier handling below, emitting spurious `references` edges
      // (macro params treated as external variable refs). Extract the macro
      // and stop: macro bodies/params are not sub-symbols and must not be
      // walked (mirrors visitNode's macroTypes + skipChildren behavior).
      if (this.extractor!.macroTypes?.includes(nodeType)) {
        this.extractMacro(node);
        return;
      }

      if (this.extractor!.callTypes.includes(nodeType)) {
        this.extractCall(node);
      } else if (INSTANTIATION_KINDS.has(nodeType)) {
        // `new Foo()` inside a function body — emit an `instantiates`
        // reference. Without this branch the body walker only knew
        // about `call_expression`, so constructor invocations
        // produced no graph edges at all.
        this.extractInstantiation(node);
        // Anonymous class with body: `new T() { ... }` (Java/C#). Extract as
        // a class so interface-impl synthesis (Phase 5.5) can bridge T's
        // methods to the overrides — same rationale as in visitNode.
        const anonBody = this.findAnonymousClassBody(node);
        if (anonBody) {
          this.extractAnonymousClass(node, anonBody);
          return;
        }
      } else if (this.extractor!.extractBareCall) {
        const calleeName = this.extractor!.extractBareCall(node, this.source);
        if (calleeName && this.nodeStack.length > 0) {
          const callerId = this.nodeStack[this.nodeStack.length - 1];
          if (callerId) {
            this.unresolvedReferences.push({
              fromNodeId: callerId,
              referenceName: calleeName,
              referenceKind: 'calls',
              line: node.startPosition.row + 1,
              column: node.startPosition.column,
            });
          }
        }
      }

      // Static-member / value-read: `Enum.value`, `Type.CONST`, `Foo::BAR`.
      this.extractStaticMemberRef(node);

      // Local variable type annotations inside a body — `const items: Foo[] = []`,
      // `const x: SomeType = svc.load()`. We deliberately do NOT create nodes for
      // locals (that would explode the graph — the data-flow frontier we leave
      // uncovered), but the TYPE a local is annotated with is a real dependency of
      // the enclosing function, so attribute a `references` edge to it. Without
      // this, a function that uses a type ONLY in its body (very common — e.g. a
      // resolver building `const nodes: Node[] = []`) produced no edge to that
      // type, so impact / `affected` missed the dependency entirely. We fall
      // through to the default recursion below so the initializer's calls (and any
      // nested declarators) are still walked.
      if (
        nodeType === 'variable_declarator' &&
        this.TYPE_ANNOTATION_LANGUAGES.has(this.language)
      ) {
        const ownerId = this.nodeStack[this.nodeStack.length - 1];
        if (ownerId) this.extractVariableTypeAnnotation(node, ownerId);
      }

      // Nested NAMED functions inside a body — function declarations and named
      // function expressions like `.on('mount', function onmount(){})` — become
      // their own nodes so the graph can link to them (callback handlers, local
      // helpers). Anonymous arrows/expressions fall through to the default
      // recursion below, keeping their inner calls attributed to the enclosing
      // function: this bounds the new nodes to NAMED functions only (no explosion,
      // no lost edges). extractFunction walks the nested body itself, so we return.
      if (this.extractor!.functionTypes.includes(nodeType)) {
        // Skip if already extracted at file scope by body-leak handling (Layer 1)
        if (!preVisitedNodes?.has(node.startIndex)) {
          const nestedName = extractName(node, this.source, this.extractor!);
          if (nestedName && nestedName !== '<anonymous>') {
            // extractFunction clears currentLocalNames internally, so save
            // the outer function's set and restore it after the nested
            // function completes.
            const savedLocalNames = new Set(this.currentLocalNames);
            this.extractFunction(node);
            this.currentLocalNames = savedLocalNames;
            return;
          }
        }
      }

      // Extract structural nodes found inside function bodies.
      // Each extract method visits its own children, so we return after extracting.
      // Skip if already extracted at file scope by body-leak handling (Layer 1).
      if (!preVisitedNodes?.has(node.startIndex)) {
        if (this.extractor!.classTypes.includes(nodeType)) {
          const classification = this.extractor!.classifyClassNode?.(node) ?? 'class';
          if (classification === 'struct') this.extractStruct(node);
          else if (classification === 'enum') this.extractEnum(node);
          else if (classification === 'interface') this.extractInterface(node);
          else if (classification === 'trait') this.extractClass(node, 'trait');
          else this.extractClass(node);
          return;
        }
        if (this.extractor!.structTypes.includes(nodeType)) {
          this.extractStruct(node);
          return;
        }
        if (this.extractor!.enumTypes.includes(nodeType)) {
          this.extractEnum(node);
          return;
        }
        if (this.extractor!.interfaceTypes.includes(nodeType)) {
          this.extractInterface(node);
          return;
        }
      }

      // Collect local variable names from declarations encountered during
      // the body traversal. When a `declaration` node is visited before its
      // children, the extracted names are already in currentLocalNames by
      // the time identifier children are checked — so `int x = g_var;`
      // correctly adds "x" before checking "g_var" against the shadow set.
      if (
        nodeType === 'declaration' &&
        (this.language === 'c' || this.language === 'cpp')
      ) {
        let hasG_PrefixVar = false;
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (!child) continue;
          const name = this.extractVarNameFromDeclarator(child);
          if (!name) continue;

          // Layer 2: g_ prefix global variable fallback.  When a function
          // body is known to be leaked (leakedGlobalNames was passed by
          // Layer 1), a variable named like g_xxx is almost certainly a
          // global that tree-sitter misplaced.  Extract it at file scope
          // and don't shadow it for reference tracking.
          // Only applies when the body is confirmed leaked — in a normal
          // body, g_ locals are legitimate shadowing declarations.
          if (
            leakedGlobalNames !== undefined &&
            name.length > 3 && name.startsWith('g_') && /^g_[a-zA-Z]/.test(name)
          ) {
            hasG_PrefixVar = true;
            continue; // don't add to currentLocalNames — it's a global
          }

          // Don't add leaked global names (Layer 1) to currentLocalNames
          if (!leakedGlobalNames?.has(name)) {
            this.currentLocalNames.add(name);
          }
        }

        // Extract g_ prefixed variables even inside function bodies
        if (hasG_PrefixVar) {
          const saved = this.nodeStack.pop();
          this.extractVariable(node);
          if (saved) this.nodeStack.push(saved);
        }

        // Don't return — children (initializers, etc.) may contain
        // identifiers that still need reference tracking.
      }

      // Global variable reference tracking (C/C++ only): bare `identifier`
      // nodes that are not shadowed by a local variable/parameter and not
      // the callee of a call_expression (already handled by extractCall)
      // emit a `references` edge. Resolution matches only names that
      // resolve to actual variable/constant nodes in the index.
      if (
        nodeType === 'identifier' &&
        (this.language === 'c' || this.language === 'cpp')
      ) {
        // Skip identifiers that are the function target of a call expression
        // — those are already handled by extractCall.
        const parent = node.parent;
        if (parent && (parent.type === 'call_expression' || parent.type === 'macro_invocation')) {
          // Inside call_expression — handled by extractCall
        } else {
          const identName = getNodeText(node, this.source);
          if (
            identName &&
            !this.currentLocalNames.has(identName) &&
            this.nodeStack.length > 0
          ) {
            const callerId = this.nodeStack[this.nodeStack.length - 1];
            if (callerId) {
              this.unresolvedReferences.push({
                fromNodeId: callerId,
                referenceName: identName,
                referenceKind: 'references',
                line: node.startPosition.row + 1,
                column: node.startPosition.column,
              });
            }
          }
        }
      }

      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) {
          visitForCallsAndStructure(child);
        }
      }
    };

    visitForCallsAndStructure(body);
  }

  /**
   * Given a declarator node (init_declarator, pointer_declarator,
   * array_declarator, identifier, etc.), find the terminal identifier name.
   * Returns undefined for function_declarator (function declarations).
   */
  /** Check whether a declaration node has a specific storage-class specifier (e.g. "extern", "static"). */
  private hasStorageClass(node: SyntaxNode, keyword: string): boolean {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c?.type === 'storage_class_specifier' && c.text === keyword) return true;
    }
    return false;
  }

  private extractVarNameFromDeclarator(node: SyntaxNode): string | undefined {
    if (node.type === 'identifier' || node.type === 'field_identifier') {
      return getNodeText(node, this.source) || undefined;
    }
    if (node.type === 'function_declarator') return undefined;
    if (
      node.type === 'init_declarator' ||
      node.type === 'pointer_declarator' ||
      node.type === 'array_declarator' ||
      node.type === 'reference_declarator'
    ) {
      const inner = getChildByField(node, 'declarator') || node.namedChild(0);
      if (inner) return this.extractVarNameFromDeclarator(inner);
    }
    return undefined;
  }

  /**
   * Extract inheritance relationships
   */
  private extractInheritance(node: SyntaxNode, classId: string): void {
    // Objective-C @interface MyClass : NSObject <ProtoA, ProtoB>
    if (node.type === 'class_interface') {
      const superclass = getChildByField(node, 'superclass');
      if (superclass) {
        const name = getNodeText(superclass, this.source);
        this.unresolvedReferences.push({
          fromNodeId: classId,
          referenceName: name,
          referenceKind: 'extends',
          line: superclass.startPosition.row + 1,
          column: superclass.startPosition.column,
        });
      }
      for (let j = 0; j < node.namedChildCount; j++) {
        const argList = node.namedChild(j);
        if (argList?.type !== 'parameterized_arguments') continue;
        for (let k = 0; k < argList.namedChildCount; k++) {
          const typeName = argList.namedChild(k);
          if (!typeName) continue;
          const typeId = typeName.namedChildren.find(
            (c: SyntaxNode) => c.type === 'type_identifier' || c.type === 'identifier'
          );
          if (!typeId) continue;
          const protocolName = getNodeText(typeId, this.source);
          this.unresolvedReferences.push({
            fromNodeId: classId,
            referenceName: protocolName,
            referenceKind: 'implements',
            line: typeId.startPosition.row + 1,
            column: typeId.startPosition.column,
          });
        }
      }
      return;
    }

    // Look for extends/implements clauses
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;

      if (
        child.type === 'extends_clause' ||
        child.type === 'superclass' ||
        child.type === 'base_clause' || // PHP class extends
        child.type === 'extends_interfaces' // Java interface extends
      ) {
        // Scala: `extends A[X] with B with C` packs EVERY supertype into the
        // one extends_clause (separated by `with`), each a `generic_type` /
        // `type_identifier` / `stable_type_identifier`. The generic path below
        // takes only namedChild(0) and keeps the full text (`A[X]`), so a
        // parameterized supertype — every typeclass in cats/algebra — never
        // matched and `with`-mixed traits past the first were dropped. Iterate
        // all supertypes and unwrap each to its base type name.
        if (this.language === 'scala') {
          for (const target of child.namedChildren) {
            const name = scalaBaseTypeName(target, this.source);
            if (name) {
              this.unresolvedReferences.push({
                fromNodeId: classId,
                referenceName: name,
                referenceKind: 'extends',
                line: target.startPosition.row + 1,
                column: target.startPosition.column,
              });
            }
          }
          continue;
        }
        // Dart: `class C extends Base with M1, M2` — the `superclass` node holds
        // the extends type as a direct `type_identifier` AND a `mixins` child
        // listing the `with` mixins (and `class C with M` has ONLY mixins, no
        // extends type). The generic `namedChild(0)` path would read the
        // `mixins` node itself as the superclass and drop every mixin — yet
        // mixins are Dart's core composition mechanism (Flutter is built on
        // them). Emit `extends` for the base and `implements` for each mixin.
        if (this.language === 'dart' && child.type === 'superclass') {
          for (const t of child.namedChildren) {
            if (t.type === 'mixins') {
              for (const m of t.namedChildren) {
                if (m.type === 'type_identifier') {
                  this.unresolvedReferences.push({
                    fromNodeId: classId,
                    referenceName: getNodeText(m, this.source),
                    referenceKind: 'implements',
                    line: m.startPosition.row + 1,
                    column: m.startPosition.column,
                  });
                }
              }
            } else if (t.type === 'type_identifier') {
              this.unresolvedReferences.push({
                fromNodeId: classId,
                referenceName: getNodeText(t, this.source),
                referenceKind: 'extends',
                line: t.startPosition.row + 1,
                column: t.startPosition.column,
              });
            }
          }
          continue;
        }
        // Extract parent class/interface names
        // Java uses type_list wrapper: superclass -> type_identifier, extends_interfaces -> type_list -> type_identifier
        const typeList = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_list');
        const targets = typeList ? typeList.namedChildren : [child.namedChild(0)];
        for (const target of targets) {
          if (target) {
            const name = getNodeText(target, this.source);
            this.unresolvedReferences.push({
              fromNodeId: classId,
              referenceName: name,
              referenceKind: 'extends',
              line: target.startPosition.row + 1,
              column: target.startPosition.column,
            });
          }
        }
      }

      // C++ base classes: `class Derived : public Base, private Other` →
      // base_class_clause holds access specifiers + base type(s). Emit an extends
      // ref per base type (skip the public/private/protected keywords).
      if (child.type === 'base_class_clause') {
        for (const t of child.namedChildren) {
          if (
            t.type === 'type_identifier' ||
            t.type === 'qualified_identifier' ||
            t.type === 'template_type'
          ) {
            this.unresolvedReferences.push({
              fromNodeId: classId,
              referenceName: getNodeText(t, this.source),
              referenceKind: 'extends',
              line: t.startPosition.row + 1,
              column: t.startPosition.column,
            });
          }
        }
      }

      if (
        child.type === 'implements_clause' ||
        child.type === 'class_interface_clause' ||
        child.type === 'super_interfaces' || // Java class implements
        child.type === 'interfaces' // Dart
      ) {
        // Extract implemented interfaces
        // Java uses type_list wrapper: super_interfaces -> type_list -> type_identifier
        const typeList = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_list');
        const targets = typeList ? typeList.namedChildren : child.namedChildren;
        for (const iface of targets) {
          if (iface) {
            const name = getNodeText(iface, this.source);
            this.unresolvedReferences.push({
              fromNodeId: classId,
              referenceName: name,
              referenceKind: 'implements',
              line: iface.startPosition.row + 1,
              column: iface.startPosition.column,
            });
          }
        }
      }

      // Python superclass list: `class Flask(Scaffold, Mixin):`
      // argument_list contains identifier children for each parent class
      if (child.type === 'argument_list' && node.type === 'class_definition') {
        for (const arg of child.namedChildren) {
          if (arg.type === 'identifier' || arg.type === 'attribute') {
            const name = getNodeText(arg, this.source);
            this.unresolvedReferences.push({
              fromNodeId: classId,
              referenceName: name,
              referenceKind: 'extends',
              line: arg.startPosition.row + 1,
              column: arg.startPosition.column,
            });
          }
        }
      }

      // Go interface embedding: `type Querier interface { LabelQuerier; ... }`
      // constraint_elem wraps the embedded interface type identifier
      if (child.type === 'constraint_elem') {
        const typeId = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
        if (typeId) {
          const name = getNodeText(typeId, this.source);
          this.unresolvedReferences.push({
            fromNodeId: classId,
            referenceName: name,
            referenceKind: 'extends',
            line: typeId.startPosition.row + 1,
            column: typeId.startPosition.column,
          });
        }
      }

      // Go struct embedding: field_declaration without field_identifier
      // e.g. `type DB struct { *Head; Queryable }` — no field name means embedded type
      if (child.type === 'field_declaration') {
        const hasFieldIdentifier = child.namedChildren.some((c: SyntaxNode) => c.type === 'field_identifier');
        if (!hasFieldIdentifier) {
          const typeId = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
          if (typeId) {
            const name = getNodeText(typeId, this.source);
            this.unresolvedReferences.push({
              fromNodeId: classId,
              referenceName: name,
              referenceKind: 'extends',
              line: typeId.startPosition.row + 1,
              column: typeId.startPosition.column,
            });
          }
        }
      }

      // Rust trait supertraits: `trait SubTrait: SuperTrait + Display { ... }`
      // trait_bounds contains type_identifier, generic_type, or higher_ranked_trait_bound children
      if (child.type === 'trait_bounds') {
        for (const bound of child.namedChildren) {
          let typeName: string | undefined;
          let posNode: SyntaxNode | undefined;

          if (bound.type === 'type_identifier') {
            typeName = getNodeText(bound, this.source);
            posNode = bound;
          } else if (bound.type === 'generic_type') {
            // e.g. `Deserialize<'de>`
            const inner = bound.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
            if (inner) { typeName = getNodeText(inner, this.source); posNode = inner; }
          } else if (bound.type === 'higher_ranked_trait_bound') {
            // e.g. `for<'de> Deserialize<'de>`
            const generic = bound.namedChildren.find((c: SyntaxNode) => c.type === 'generic_type');
            const typeId = generic?.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier')
              ?? bound.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
            if (typeId) { typeName = getNodeText(typeId, this.source); posNode = typeId; }
          }

          if (typeName && posNode) {
            this.unresolvedReferences.push({
              fromNodeId: classId,
              referenceName: typeName,
              referenceKind: 'extends',
              line: posNode.startPosition.row + 1,
              column: posNode.startPosition.column,
            });
          }
        }
      }

      // C#: `class Movie : BaseItem, IPlugin` → base_list with identifier children
      // base_list combines both base class and interfaces in a single colon-separated list.
      // We emit all as 'extends' since the syntax doesn't distinguish them.
      if (child.type === 'base_list') {
        for (const baseType of child.namedChildren) {
          if (baseType) {
            // For generic base types like `ClientBase<T>`, extract just the type name
            const name = baseType.type === 'generic_name'
              ? getNodeText(baseType.namedChildren.find((c: SyntaxNode) => c.type === 'identifier') ?? baseType, this.source)
              : getNodeText(baseType, this.source);
            this.unresolvedReferences.push({
              fromNodeId: classId,
              referenceName: name,
              referenceKind: 'extends',
              line: baseType.startPosition.row + 1,
              column: baseType.startPosition.column,
            });
          }
        }
      }

      // Kotlin: `class Foo : Bar, Baz` → delegation_specifier > user_type > type_identifier
      // Also handles `class Foo : Bar()` → delegation_specifier > constructor_invocation > user_type
      if (child.type === 'delegation_specifier') {
        const userType = child.namedChildren.find((c: SyntaxNode) => c.type === 'user_type');
        const constructorInvocation = child.namedChildren.find((c: SyntaxNode) => c.type === 'constructor_invocation');
        const target = userType ?? constructorInvocation;
        if (target) {
          const typeId = target.type === 'user_type'
            ? target.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier') ?? target
            : target.namedChildren.find((c: SyntaxNode) => c.type === 'user_type')?.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier')
              ?? target.namedChildren.find((c: SyntaxNode) => c.type === 'user_type') ?? target;
          const name = getNodeText(typeId, this.source);
          this.unresolvedReferences.push({
            fromNodeId: classId,
            referenceName: name,
            referenceKind: 'extends',
            line: typeId.startPosition.row + 1,
            column: typeId.startPosition.column,
          });
        }
      }

      // Swift: inheritance_specifier > user_type > type_identifier
      // Used for class inheritance, protocol conformance, and protocol inheritance
      if (child.type === 'inheritance_specifier') {
        const userType = child.namedChildren.find((c: SyntaxNode) => c.type === 'user_type');
        const typeId = userType?.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
        if (typeId) {
          const name = getNodeText(typeId, this.source);
          this.unresolvedReferences.push({
            fromNodeId: classId,
            referenceName: name,
            referenceKind: 'extends',
            line: typeId.startPosition.row + 1,
            column: typeId.startPosition.column,
          });
        }
      }

      // JavaScript class_heritage has bare identifier without extends_clause wrapper
      // e.g. `class Foo extends Bar {}` → class_heritage → identifier("Bar")
      if (
        (child.type === 'identifier' || child.type === 'type_identifier') &&
        node.type === 'class_heritage'
      ) {
        const name = getNodeText(child, this.source);
        this.unresolvedReferences.push({
          fromNodeId: classId,
          referenceName: name,
          referenceKind: 'extends',
          line: child.startPosition.row + 1,
          column: child.startPosition.column,
        });
      }

      // Recurse into container nodes (e.g. field_declaration_list in Go structs,
      // class_heritage in TypeScript which wraps extends_clause/implements_clause)
      if (child.type === 'field_declaration_list' || child.type === 'class_heritage') {
        this.extractInheritance(child, classId);
      }
    }
  }

  /**
   * Rust `impl Trait for Type` — creates an implements edge from Type to Trait.
   * For plain `impl Type { ... }` (no trait), no inheritance edge is needed.
   */
  private extractRustImplItem(node: SyntaxNode): void {
    // Check if this is `impl Trait for Type` by looking for a `for` keyword
    const hasFor = node.children.some(
      (c: SyntaxNode) => c.type === 'for' && !c.isNamed
    );
    if (!hasFor) return;

    // In `impl Trait for Type`, the type_identifiers are:
    // first = Trait name, last = implementing Type name
    // Also handle generic types like `impl<T> Trait for MyStruct<T>`
    const typeIdents = node.namedChildren.filter(
      (c: SyntaxNode) => c.type === 'type_identifier' || c.type === 'generic_type' || c.type === 'scoped_type_identifier'
    );
    if (typeIdents.length < 2) return;

    const traitNode = typeIdents[0]!;
    const typeNode = typeIdents[typeIdents.length - 1]!;

    // Get the trait name (handle scoped paths like std::fmt::Display)
    const traitName = traitNode.type === 'scoped_type_identifier'
      ? this.source.substring(traitNode.startIndex, traitNode.endIndex)
      : getNodeText(traitNode, this.source);

    // Get the implementing type name (extract inner type_identifier for generics)
    let typeName: string;
    if (typeNode.type === 'generic_type') {
      const inner = typeNode.namedChildren.find(
        (c: SyntaxNode) => c.type === 'type_identifier'
      );
      typeName = inner ? getNodeText(inner, this.source) : getNodeText(typeNode, this.source);
    } else {
      typeName = getNodeText(typeNode, this.source);
    }

    // Find the struct/type node for the implementing type
    const typeNodeId = this.findNodeByName(typeName);
    if (typeNodeId) {
      this.unresolvedReferences.push({
        fromNodeId: typeNodeId,
        referenceName: traitName,
        referenceKind: 'implements',
        line: traitNode.startPosition.row + 1,
        column: traitNode.startPosition.column,
      });
    }
  }

  /**
   * Find a previously-extracted node by name (used for back-references like impl blocks)
   */
  private findNodeByName(name: string): string | undefined {
    for (const node of this.nodes) {
      if (node.name === name && (node.kind === 'struct' || node.kind === 'enum' || node.kind === 'class')) {
        return node.id;
      }
    }
    return undefined;
  }

  /**
   * Languages that support type annotations (TypeScript, etc.)
   */
  private readonly TYPE_ANNOTATION_LANGUAGES = new Set([
    'typescript', 'tsx', 'dart', 'kotlin', 'swift', 'rust', 'go', 'java', 'csharp', 'scala', 'php',
  ]);

  /**
   * PHP pseudo-types and `self`/`static`/`parent` that aren't project symbols.
   * (Scalar primitives parse as `primitive_type` and are skipped structurally.)
   */
  private readonly PHP_PSEUDO_TYPES = new Set([
    'self', 'static', 'parent', 'mixed', 'object', 'iterable', 'callable', 'void',
    'null', 'false', 'true', 'never', 'array', 'int', 'float', 'string', 'bool',
  ]);

  /**
   * Built-in/primitive type names that shouldn't create references
   */
  private readonly BUILTIN_TYPES = new Set([
    'string', 'number', 'boolean', 'void', 'null', 'undefined', 'never', 'any', 'unknown',
    'object', 'symbol', 'bigint', 'true', 'false',
    // Rust
    'str', 'bool', 'i8', 'i16', 'i32', 'i64', 'i128', 'isize',
    'u8', 'u16', 'u32', 'u64', 'u128', 'usize', 'f32', 'f64', 'char',
    // Java/C#
    'int', 'long', 'short', 'byte', 'float', 'double', 'char',
    // Go
    'int8', 'int16', 'int32', 'int64', 'uint8', 'uint16', 'uint32', 'uint64',
    'float32', 'float64', 'complex64', 'complex128', 'rune', 'error',
    // Scala (capitalized primitives + ubiquitous stdlib aliases)
    'Int', 'Long', 'Short', 'Byte', 'Float', 'Double', 'Boolean', 'Char', 'Unit',
    'String', 'Any', 'AnyRef', 'AnyVal', 'Nothing', 'Null',
  ]);

  /**
   * Extract type references from type annotations on a function/method/field node.
   * Creates 'references' edges for parameter types, return types, and field types.
   */
  private extractTypeAnnotations(node: SyntaxNode, nodeId: string): void {
    if (!this.extractor) return;
    if (!this.TYPE_ANNOTATION_LANGUAGES.has(this.language)) return;

    // C# tree-sitter doesn't produce `type_identifier` leaves — it uses
    // `identifier`, `predefined_type`, `qualified_name`, `generic_name`,
    // etc. — so the generic walker below emits zero references for it.
    // Dispatch to a C#-aware path that only walks type-position subtrees
    // (the `type` field of a parameter/method/property/field), so
    // parameter NAMES never accidentally surface as type refs (#381).
    if (this.language === 'csharp') {
      this.extractCsharpTypeRefs(node, nodeId);
      return;
    }

    // PHP type-hints are `named_type`/`optional_type`/`union_type` wrapping a
    // `name`/`qualified_name` — never `type_identifier` — so the generic walker
    // below emits nothing for them. Dispatch to a PHP-aware path that walks only
    // type positions (parameter / return / property types), so type-hinted
    // dependencies (the constructor-injected contracts that dominate Laravel) are
    // recorded and a `variable_name` like `$events` never mis-emits as a ref.
    if (this.language === 'php') {
      this.extractPhpTypeRefs(node, nodeId);
      return;
    }

    // Dart: a `method_signature` wraps the real `function_signature` (where the
    // params and return type live), and the return type is a bare
    // `type_identifier` child, not a `type` field — so getChildByField below
    // finds neither. Walk the inner signature: param names / the method name are
    // `identifier` (not `type_identifier`), so only types surface.
    if (this.language === 'dart') {
      let sig: SyntaxNode | undefined = node;
      if (node.type === 'method_signature') {
        sig = node.namedChildren.find(
          (c: SyntaxNode) =>
            c.type === 'function_signature' ||
            c.type === 'getter_signature' ||
            c.type === 'setter_signature' ||
            c.type === 'constructor_signature' ||
            c.type === 'factory_constructor_signature'
        ) ?? node;
      }
      this.extractTypeRefsFromSubtree(sig, nodeId);
      return;
    }

    // Extract parameter type annotations. Scala curries — `def f(a)(implicit
    // M: TC)` has MULTIPLE `parameters` siblings, and the typeclass is almost
    // always in the trailing implicit list — so walk every parameter list, not
    // just getChildByField's first match.
    if (this.language === 'scala') {
      for (const pc of node.namedChildren) {
        if (pc.type === 'parameters') this.extractTypeRefsFromSubtree(pc, nodeId);
      }
    } else {
      const params = getChildByField(node, this.extractor.paramsField || 'parameters');
      if (params) {
        this.extractTypeRefsFromSubtree(params, nodeId);
      }
    }

    // Extract return type annotation
    const returnType = getChildByField(node, this.extractor.returnField || 'return_type');
    if (returnType) {
      this.extractTypeRefsFromSubtree(returnType, nodeId);
    }

    // Scala context bounds / type-parameter bounds: `def f[A: Monoid]`,
    // `[F[_]: Monad]`, `[A <: Foo]` carry the bound type inside `type_parameters`.
    // This is THE pervasive way a typeclass is required in Scala, yet the bound
    // never appears in the value parameters. Param NAMES are `identifier` (not
    // `type_identifier`), so only the bound types surface. Scala-only: in other
    // languages a `type_parameters` child holds declaration names as
    // `type_identifier` (TS `<T>`), which would wrongly surface as refs.
    if (this.language === 'scala') {
      const typeParams = node.namedChildren.find(
        (c: SyntaxNode) => c.type === 'type_parameters'
      );
      if (typeParams) {
        this.extractTypeRefsFromSubtree(typeParams, nodeId);
      }
    }

    // Extract direct type annotation (for class fields like `model: ITextModel`)
    const typeAnnotation = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'type_annotation'
    );
    if (typeAnnotation) {
      this.extractTypeRefsFromSubtree(typeAnnotation, nodeId);
    }
  }

  /**
   * Extract C# type references from a node that owns a type position —
   * a method/constructor declaration, a property declaration, or a
   * field declaration (which wraps `variable_declaration → type`).
   *
   * Walks ONLY into known type fields, so parameter names like
   * `request` in `Build(UserDto request)` are never mis-emitted as
   * type references. Once inside a type subtree, `walkCsharpTypePosition`
   * recognizes C#'s actual type-leaf node kinds (`identifier`,
   * `qualified_name`, `generic_name`, `array_type`, `nullable_type`,
   * `tuple_type`, …) — none of which are `type_identifier`. Closes #381.
   */
  private extractCsharpTypeRefs(node: SyntaxNode, nodeId: string): void {
    // A property's type is under the `type` field; a method/constructor's RETURN
    // type is under `returns` (tree-sitter-c-sharp 0.23.x — older builds used
    // `type` for both). A node carries only one of the two, so checking both
    // covers return types and property types without conflating them.
    const directType = getChildByField(node, 'type') ?? getChildByField(node, 'returns');
    if (directType) this.walkCsharpTypePosition(directType, nodeId);

    // Field declarations wrap declarators in a `variable_declaration`
    // whose `type` field carries the type. The outer `field_declaration`
    // has no `type` field of its own, so the call above is a no-op here
    // and we descend one level.
    const varDecl = node.namedChildren.find((c: SyntaxNode) => c.type === 'variable_declaration');
    if (varDecl) {
      const vdType = getChildByField(varDecl, 'type');
      if (vdType) this.walkCsharpTypePosition(vdType, nodeId);
    }

    // Method / constructor parameters. The field name on
    // `method_declaration` is `parameters`; it points at a
    // `parameter_list` whose `parameter` children each have their own
    // `type` field. Walking ONLY the type field skips parameter NAMES,
    // which would otherwise mis-emit as type references.
    const params = getChildByField(node, 'parameters');
    if (params) {
      for (let i = 0; i < params.namedChildCount; i++) {
        const child = params.namedChild(i);
        if (!child || child.type !== 'parameter') continue;
        const paramType = getChildByField(child, 'type');
        if (paramType) this.walkCsharpTypePosition(paramType, nodeId);
      }
    }
  }

  /**
   * Record the dependencies declared by a C# PRIMARY CONSTRUCTOR
   * (`class Svc(IRepo repo, [FromKeyedServices("k")] ICache cache) { … }`,
   * C# 12+). The parameter list hangs off the class/struct/record declaration
   * as an unnamed-field `parameter_list` child (not the `parameters` field a
   * method uses), so it's found by node type. Each parameter's declared type
   * becomes a `references` edge from the owning type — these are exactly the
   * services a DI-registered type depends on, so impact/blast-radius and
   * "who depends on this contract" now see them. No-op when there's no primary
   * constructor. (#237)
   */
  private extractCsharpPrimaryCtorParamRefs(node: SyntaxNode, ownerId: string): void {
    if (this.language !== 'csharp') return;
    const paramList = node.namedChildren.find((c: SyntaxNode) => c.type === 'parameter_list');
    if (!paramList) return;
    for (let i = 0; i < paramList.namedChildCount; i++) {
      const param = paramList.namedChild(i);
      if (!param || param.type !== 'parameter') continue;
      const paramType = getChildByField(param, 'type');
      if (paramType) this.walkCsharpTypePosition(paramType, ownerId);
    }
  }

  /**
   * Walk a C# subtree that is KNOWN to be in a type position
   * (return type, parameter type, property type, field type, generic
   * argument). Identifiers here are type names, not parameter names.
   */
  private walkCsharpTypePosition(node: SyntaxNode, fromNodeId: string): void {
    // `predefined_type` is int/string/bool/etc. — never a project ref.
    if (node.type === 'predefined_type') return;

    // Bare type name: `Foo` in `Foo bar`, or the `Foo` inside `List<Foo>`.
    if (node.type === 'identifier') {
      const name = getNodeText(node, this.source);
      if (name && !this.BUILTIN_TYPES.has(name)) {
        this.unresolvedReferences.push({
          fromNodeId,
          referenceName: name,
          referenceKind: 'references',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
      return;
    }

    // `Namespace.Foo` → the rightmost identifier is the type. Emit the
    // full qualified name as the reference; the resolver can still match
    // on the trailing simple name when needed.
    if (node.type === 'qualified_name') {
      const text = getNodeText(node, this.source);
      const last = text.split('.').pop() ?? text;
      if (last && !this.BUILTIN_TYPES.has(last)) {
        this.unresolvedReferences.push({
          fromNodeId,
          referenceName: last,
          referenceKind: 'references',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
      return;
    }

    // `(int Code, Foo Payload)` — tuple element has BOTH a `type` and a
    // `name` field; descending into all named children would mis-emit
    // the element name (`Code`, `Payload`) as a type ref. Walk only the
    // type field.
    if (node.type === 'tuple_element') {
      const t = getChildByField(node, 'type');
      if (t) this.walkCsharpTypePosition(t, fromNodeId);
      return;
    }

    // Composite type nodes — recurse into named children. Covers
    // `generic_name` (head identifier + `type_argument_list`),
    // `nullable_type`, `array_type`, `pointer_type`, `tuple_type`,
    // `ref_type`, and any newer wrapping shapes the grammar adds.
    // Identifiers reached here are all type-positional (parameter/field
    // names are gated out before we descend).
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) this.walkCsharpTypePosition(child, fromNodeId);
    }
  }

  /**
   * Extract PHP type references from a method/function/property declaration.
   * Walks ONLY type positions: each parameter's type child (inside
   * `formal_parameters`), the return type, and a property's type — all
   * `named_type` / `optional_type` / `union_type` / … direct children. Parameter
   * and property NAMES are `variable_name` (`$x`), never type nodes, so they
   * can't be mis-emitted.
   */
  private extractPhpTypeRefs(node: SyntaxNode, nodeId: string): void {
    const params = node.namedChildren.find((c: SyntaxNode) => c.type === 'formal_parameters');
    if (params) {
      for (const p of params.namedChildren) {
        // simple_parameter / property_promotion_parameter / variadic_parameter
        for (const c of p.namedChildren) {
          if (PHP_TYPE_NODES.has(c.type)) this.walkPhpTypePosition(c, nodeId);
        }
      }
    }
    // Return type (method/function) and property type are TYPE nodes that are
    // DIRECT children of the declaration.
    for (const c of node.namedChildren) {
      if (PHP_TYPE_NODES.has(c.type)) this.walkPhpTypePosition(c, nodeId);
    }
  }

  /** Walk a PHP subtree KNOWN to be in a type position; emit class/interface refs. */
  private walkPhpTypePosition(node: SyntaxNode, fromNodeId: string): void {
    if (node.type === 'primitive_type') return; // int/string/void/…
    if (node.type === 'name') {
      const name = getNodeText(node, this.source);
      if (name && !this.PHP_PSEUDO_TYPES.has(name)) {
        this.unresolvedReferences.push({
          fromNodeId, referenceName: name, referenceKind: 'references',
          line: node.startPosition.row + 1, column: node.startPosition.column,
        });
      }
      return;
    }
    if (node.type === 'qualified_name') {
      // `App\Contracts\Logger` → match on the trailing simple name (what the
      // class node is stored as, and what a `use` import brings into scope).
      const last = getNodeText(node, this.source).split('\\').pop() ?? '';
      if (last && !this.PHP_PSEUDO_TYPES.has(last)) {
        this.unresolvedReferences.push({
          fromNodeId, referenceName: last, referenceKind: 'references',
          line: node.startPosition.row + 1, column: node.startPosition.column,
        });
      }
      return;
    }
    // optional_type / nullable_type / union_type / intersection_type / named_type → recurse
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) this.walkPhpTypePosition(child, fromNodeId);
    }
  }

  /**
   * Extract type references from a variable's type annotation.
   */
  private extractVariableTypeAnnotation(node: SyntaxNode, nodeId: string): void {
    if (!this.TYPE_ANNOTATION_LANGUAGES.has(this.language)) return;

    // Find type_annotation child (covers TS `: Type`, Rust `: Type`, etc.)
    const typeAnnotation = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'type_annotation'
    );
    if (typeAnnotation) {
      this.extractTypeRefsFromSubtree(typeAnnotation, nodeId);
    }
  }

  /**
   * Recursively walk a subtree and extract all type_identifier references.
   * Handles unions, intersections, generics, arrays, etc.
   */
  private extractTypeRefsFromSubtree(node: SyntaxNode, fromNodeId: string): void {
    if (node.type === 'type_identifier') {
      const typeName = getNodeText(node, this.source);
      if (typeName && !this.BUILTIN_TYPES.has(typeName)) {
        this.unresolvedReferences.push({
          fromNodeId,
          referenceName: typeName,
          referenceKind: 'references',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
      return; // type_identifier is a leaf
    }

    // Recurse into children (handles union_type, intersection_type, generic_type, etc.)
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) {
        this.extractTypeRefsFromSubtree(child, fromNodeId);
      }
    }
  }

  /**
   * Handle Pascal-specific AST structures.
   * Returns true if the node was fully handled and children should be skipped.
   */
  private visitPascalNode(node: SyntaxNode): boolean {
    const nodeType = node.type;

    // Unit/Program/Library → module node
    if (nodeType === 'unit' || nodeType === 'program' || nodeType === 'library') {
      const moduleNameNode = node.namedChildren.find(
        (c: SyntaxNode) => c.type === 'moduleName'
      );
      const name = moduleNameNode ? getNodeText(moduleNameNode, this.source) : '';
      // Fallback to filename without extension if module name is empty
      const moduleName = name || path.basename(this.filePath).replace(/\.[^.]+$/, '');
      this.createNode('module', moduleName, node);
      // Continue visiting children (interface/implementation sections)
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) this.visitNode(child);
      }
      return true;
    }

    // declType wraps declClass/declIntf/declEnum/type-alias
    // The name lives on declType, the inner node determines the kind
    if (nodeType === 'declType') {
      this.extractPascalDeclType(node);
      return true;
    }

    // declUses → import nodes for each unit name
    if (nodeType === 'declUses') {
      this.extractPascalUses(node);
      return true;
    }

    // declConsts → container; visit children for individual declConst
    if (nodeType === 'declConsts') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'declConst') {
          this.extractPascalConst(child);
        }
      }
      return true;
    }

    // declConst at top level (outside declConsts)
    if (nodeType === 'declConst') {
      this.extractPascalConst(node);
      return true;
    }

    // declTypes → container for type declarations
    if (nodeType === 'declTypes') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) this.visitNode(child);
      }
      return true;
    }

    // declVars → container for variable declarations
    if (nodeType === 'declVars') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'declVar') {
          const nameNode = getChildByField(child, 'name');
          if (nameNode) {
            const name = getNodeText(nameNode, this.source);
            this.createNode('variable', name, child);
          }
        }
      }
      return true;
    }

    // defProc in implementation section → extract calls but don't create duplicate nodes
    if (nodeType === 'defProc') {
      this.extractPascalDefProc(node);
      return true;
    }

    // declProp → property node
    if (nodeType === 'declProp') {
      const nameNode = getChildByField(node, 'name');
      if (nameNode) {
        const name = getNodeText(nameNode, this.source);
        const visibility = this.extractor!.getVisibility?.(node);
        this.createNode('property', name, node, { visibility });
      }
      return true;
    }

    // declField → field node
    if (nodeType === 'declField') {
      const nameNode = getChildByField(node, 'name');
      if (nameNode) {
        const name = getNodeText(nameNode, this.source);
        const visibility = this.extractor!.getVisibility?.(node);
        this.createNode('field', name, node, { visibility });
      }
      return true;
    }

    // declSection → visit children (propagates visibility via getVisibility)
    if (nodeType === 'declSection') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) this.visitNode(child);
      }
      return true;
    }

    // exprCall → extract function call reference
    if (nodeType === 'exprCall') {
      this.extractPascalCall(node);
      return true;
    }

    // interface/implementation sections → visit children
    if (nodeType === 'interface' || nodeType === 'implementation') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) this.visitNode(child);
      }
      return true;
    }

    // block (begin..end) → visit for calls
    if (nodeType === 'block') {
      this.visitPascalBlock(node);
      return true;
    }

    return false;
  }

  /**
   * Extract a Pascal declType node (class, interface, enum, or type alias)
   */
  private extractPascalDeclType(node: SyntaxNode): void {
    const nameNode = getChildByField(node, 'name');
    if (!nameNode) return;
    const name = getNodeText(nameNode, this.source);

    // Find the inner type declaration
    const declClass = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'declClass'
    );
    const declIntf = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'declIntf'
    );
    const typeChild = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'type'
    );

    if (declClass) {
      const classNode = this.createNode('class', name, node);
      if (classNode) {
        // Extract inheritance from typeref children of declClass
        this.extractPascalInheritance(declClass, classNode.id);
        // Visit class body
        this.nodeStack.push(classNode.id);
        for (let i = 0; i < declClass.namedChildCount; i++) {
          const child = declClass.namedChild(i);
          if (child) this.visitNode(child);
        }
        this.nodeStack.pop();
      }
    } else if (declIntf) {
      const ifaceNode = this.createNode('interface', name, node);
      if (ifaceNode) {
        // Visit interface members
        this.nodeStack.push(ifaceNode.id);
        for (let i = 0; i < declIntf.namedChildCount; i++) {
          const child = declIntf.namedChild(i);
          if (child) this.visitNode(child);
        }
        this.nodeStack.pop();
      }
    } else if (typeChild) {
      // Check if it contains a declEnum
      const declEnum = typeChild.namedChildren.find(
        (c: SyntaxNode) => c.type === 'declEnum'
      );
      if (declEnum) {
        const enumNode = this.createNode('enum', name, node);
        if (enumNode) {
          // Extract enum members
          this.nodeStack.push(enumNode.id);
          for (let i = 0; i < declEnum.namedChildCount; i++) {
            const child = declEnum.namedChild(i);
            if (child?.type === 'declEnumValue') {
              const memberName = getChildByField(child, 'name');
              if (memberName) {
                this.createNode('enum_member', getNodeText(memberName, this.source), child);
              }
            }
          }
          this.nodeStack.pop();
        }
      } else {
        // Simple type alias: type TFoo = string / type TFoo = Integer
        this.createNode('type_alias', name, node);
      }
    } else {
      // Fallback: could be a forward declaration or simple alias
      this.createNode('type_alias', name, node);
    }
  }

  /**
   * Extract Pascal uses clause into individual import nodes
   */
  private extractPascalUses(node: SyntaxNode): void {
    const importText = getNodeText(node, this.source).trim();
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'moduleName') {
        const unitName = getNodeText(child, this.source);
        this.createNode('import', unitName, child, {
          signature: importText,
        });
        // Create unresolved reference for resolution
        if (this.nodeStack.length > 0) {
          const parentId = this.nodeStack[this.nodeStack.length - 1];
          if (parentId) {
            this.unresolvedReferences.push({
              fromNodeId: parentId,
              referenceName: unitName,
              referenceKind: 'imports',
              line: child.startPosition.row + 1,
              column: child.startPosition.column,
            });
          }
        }
      }
    }
  }

  /**
   * Extract a Pascal constant declaration
   */
  private extractPascalConst(node: SyntaxNode): void {
    const nameNode = getChildByField(node, 'name');
    if (!nameNode) return;
    const name = getNodeText(nameNode, this.source);
    const defaultValue = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'defaultValue'
    );
    const sig = defaultValue ? getNodeText(defaultValue, this.source) : undefined;
    this.createNode('constant', name, node, { signature: sig });
  }

  /**
   * Extract Pascal inheritance (extends/implements) from declClass typeref children
   */
  private extractPascalInheritance(declClass: SyntaxNode, classId: string): void {
    const typerefs = declClass.namedChildren.filter(
      (c: SyntaxNode) => c.type === 'typeref'
    );
    for (let i = 0; i < typerefs.length; i++) {
      const ref = typerefs[i]!;
      const name = getNodeText(ref, this.source);
      this.unresolvedReferences.push({
        fromNodeId: classId,
        referenceName: name,
        referenceKind: i === 0 ? 'extends' : 'implements',
        line: ref.startPosition.row + 1,
        column: ref.startPosition.column,
      });
    }
  }

  /**
   * Extract calls and resolve method context from a Pascal defProc (implementation body).
   * Does not create a new node — the declaration was already captured from the interface section.
   */
  private extractPascalDefProc(node: SyntaxNode): void {
    // Find the matching declaration node by name to use as call parent
    const declProc = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'declProc'
    );
    if (!declProc) return;

    const nameNode = getChildByField(declProc, 'name');
    if (!nameNode) return;
    const fullName = getNodeText(nameNode, this.source).trim();
    // fullName is like "TAuthService.Create"
    const shortName = fullName.includes('.') ? fullName.split('.').pop()! : fullName;
    const fullNameKey = fullName.toLowerCase();
    const shortNameKey = shortName.toLowerCase();

    // Build method index on first use (O(n) once, then O(1) per lookup)
    if (!this.methodIndex) {
      this.methodIndex = new Map();
      for (const n of this.nodes) {
        if (n.kind === 'method' || n.kind === 'function') {
          const nameKey = n.name.toLowerCase();
          // Keep first seen short-name mapping to avoid silently overwriting earlier entries.
          if (!this.methodIndex.has(nameKey)) {
            this.methodIndex.set(nameKey, n.id);
          }

          // For Pascal methods, also index qualified forms (e.g. TAuthService.Create).
          if (n.kind === 'method') {
            const qualifiedParts = n.qualifiedName.split('::');
            if (qualifiedParts.length >= 2) {
              // Create suffix keys so both "Module.Class.Method" and "Class.Method" can resolve.
              for (let i = 0; i < qualifiedParts.length - 1; i++) {
                const scopedName = qualifiedParts.slice(i).join('.').toLowerCase();
                this.methodIndex.set(scopedName, n.id);
              }
            }
          }
        }
      }
    }

    const parentId =
      this.methodIndex.get(fullNameKey) ||
      this.methodIndex.get(shortNameKey) ||
      this.nodeStack[this.nodeStack.length - 1];
    if (!parentId) return;

    // Visit the block for calls
    const block = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'block'
    );
    if (block) {
      this.nodeStack.push(parentId);
      this.visitPascalBlock(block);
      this.nodeStack.pop();
    }
  }

  /**
   * Extract function calls from a Pascal expression
   */
  private extractPascalCall(node: SyntaxNode): void {
    if (this.nodeStack.length === 0) return;
    const callerId = this.nodeStack[this.nodeStack.length - 1];
    if (!callerId) return;

    // Get the callee name — first child is typically the identifier or exprDot
    const firstChild = node.namedChild(0);
    if (!firstChild) return;

    let calleeName = '';
    if (firstChild.type === 'exprDot') {
      // Qualified call: Obj.Method(...)
      const identifiers = firstChild.namedChildren.filter(
        (c: SyntaxNode) => c.type === 'identifier'
      );
      if (identifiers.length > 0) {
        calleeName = identifiers.map((id: SyntaxNode) => getNodeText(id, this.source)).join('.');
      }
    } else if (firstChild.type === 'identifier') {
      calleeName = getNodeText(firstChild, this.source);
    }

    if (calleeName) {
      this.unresolvedReferences.push({
        fromNodeId: callerId,
        referenceName: calleeName,
        referenceKind: 'calls',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }

    // Also visit arguments for nested calls
    const args = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'exprArgs'
    );
    if (args) {
      this.visitPascalBlock(args);
    }
  }

  /**
   * Recursively visit a Pascal block/statement tree for call expressions
   */
  private visitPascalBlock(node: SyntaxNode): void {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'exprCall') {
        this.extractPascalCall(child);
      } else if (child.type === 'exprDot') {
        // Check if exprDot contains an exprCall
        for (let j = 0; j < child.namedChildCount; j++) {
          const grandchild = child.namedChild(j);
          if (grandchild?.type === 'exprCall') {
            this.extractPascalCall(grandchild);
          }
        }
      } else {
        this.visitPascalBlock(child);
      }
    }
  }
}


/**
 * Detect a "pure-macro data header": a C file whose entire content — after
 * masking comments and string/char literals — is whitespace and preprocessor
 * directive lines (with their backslash continuations), holding >= 20
 * object-like #define macros and no function-like macros. tree-sitter-c
 * degenerates to ~O(n²) on such files once macro bodies carry inline block
 * comments or very long rows (measured on synthetic reproducers: 20 macros
 * 16.7s → 40 macros 67.6s; the parse tree collapses to 0-2 macros either way),
 * yet they yield no extractable symbols beyond macro names, so the parse is
 * skipped and macro names are collected via regex instead. Upstream refs
 * tree-sitter-c#196 / tree-sitter#1356 describe related-but-not-identical
 * pathologies and are kept here as context only.
 *
 * Structural whitelist, not a semicolon blacklist. The previous "zero
 * semicolons / zero type keywords" heuristic wrongly skipped files whose real
 * declarations carry no semicolon (`void real_fn(void) {}` loses the function
 * entirely) and counted semicolons/keywords living only inside block comments
 * (a license banner), letting pure data tables fall into the pathological
 * parse. Now every non-blank masked line must be a directive (or a
 * continuation of one), so real code of any shape stays on the normal parse
 * path while semicolons in comments can no longer disqualify a data header.
 * A `#define` at a physical line start inside a continuation chain still
 * counts toward defineCount: real cpp swallows it into the previous macro
 * (dangling-continuation files are malformed), but the author's intent is a
 * macro definition, and counting keeps such files on the fast path instead
 * of re-hitting the pathological parse. Function-like detection is only done
 * on non-continued directive lines, and every counted #define must pass the
 * isFastPathSafeDefineHeader gate (cross-line headers and non-ASCII names
 * fall back to the normal parse, which handles both). C-only. Escape hatch:
 * CODEGRAPH_FORCE_PARSE=1 forces the normal parse path.
 */
/**
 * Controlled plan F: blank block comments that live INSIDE `#define`
 * directives (the directive's own logical line, including its spliced
 * continuation lines) before the parse, for C files the pure-macro fast path
 * did not take (mixed headers: data macros plus real declarations). Macro
 * bodies carrying inline block comments drive tree-sitter-c into ~O(n²)
 * error recovery and the tree collapses (measured: a 105KB mixed header
 * parsed 17.3s and kept 3 of 100+ macros; after blanking, milliseconds and
 * everything kept). A comment is equivalent to whitespace in real cpp
 * semantics, so the transform cannot change what directives mean — only what
 * tree-sitter's approximate preprocessor scanner sees.
 *
 * A SINGLE character-level scan over the original source keeps one global
 * lexical state (block comments, string/char literals, logical-line starts,
 * splicing). Line-by-line classification was tried and wrongly blanked the
 * closing `*\/` of a comment opened OUTSIDE a directive — destroying the
 * comment boundary and swallowing every symbol after it. Now a comment is
 * blanked only when it OPENS while the scanner is genuinely inside a #define
 * logical line; comments opened elsewhere — even when they close on a
 * directive-shaped line — are left byte-for-byte alone.
 *
 * Continuation follows real cpp splicing (GCC initial processing): a backslash
 * continues the logical line only when it IMMEDIATELY precedes the newline —
 * a backslash-then-comment line ending is NOT a continuation, because
 * splicing happens before comments are removed. Blank a comment does not
 * change any continuation decision; it only removes comment content that the
 * scanner mishandles. A comment opened inside a directive that spans lines
 * kills the directive (its opening line had no immediately-preceding-newline
 * backslash), so the in-directive state is dropped at the comment's close.
 * `#define` inside comments or string literals is never a directive.
 *
 * Comments outside directives (real code) are never touched. Macro signatures
 * lose their in-body comments on this path — `originalSource` still holds the
 * full bytes. Returns the input string unchanged when the file has no
 * define-dense directive-body comments.
 */
function blankDefineBodyComments(source: string): string {
  // Same cheap pre-filter as the fast path, widened for single-table files:
  // a header can hold ONE giant data macro instead of many — measured, a
  // single ~11KB backslash-continued body (extern "C" + lint pragmas around
  // it) parses for 17.5s with a collapsed tree, and blanking its in-body
  // comments restores milliseconds. Qualify when the file has >= 20 #define
  // lines OR any single #define directive (its own line plus its continued
  // lines) reaches the size threshold. Continuation is judged loosely here
  // (trailing blanks after the backslash allowed): the pre-filter may only
  // over-trigger, and a triggered scan that finds nothing returns the source
  // unchanged.
  // Count UTF-16 code units excluding line terminators, not UTF-8 bytes.
  const OVERSIZED_DEFINE_CODE_UNITS = 8192;
  let defineLines = 0;
  let continuesDefine = false;
  let directiveSize = 0;
  let hasOversizedDefine = false;
  for (const raw of source.split(/\r?\n/)) {
    const isDefineLine = /^\s*#\s*define\b/.test(raw);
    if (isDefineLine) defineLines++;
    // Membership comes from the PREVIOUS line's continuation. Include the
    // final body line even when it has no backslash, and never accumulate
    // unrelated rows after a completed directive. A define-looking line in
    // a continued body also must not reset that body's size.
    const belongsToDefine: boolean = continuesDefine || isDefineLine;
    directiveSize = continuesDefine
      ? directiveSize + raw.length
      : isDefineLine ? raw.length : 0;
    if (belongsToDefine && directiveSize >= OVERSIZED_DEFINE_CODE_UNITS) {
      hasOversizedDefine = true;
    }
    continuesDefine = belongsToDefine && /\\[ \t]*\r?$/.test(raw);
    // Qualification is file-wide: a subsequent small #define cannot undo
    // it. No further pre-filter work is needed once either gate is met.
    if (defineLines >= 20 || hasOversizedDefine) break;
  }
  if (defineLines < 20 && !hasOversizedDefine) return source;

  let out = '';
  let codeStart = 0;
  let i = 0;
  let inDefine = false;          // scanner is inside a #define logical line
  let atLogicalLineStart = true;  // scanner is at a (spliced) logical-line head
  let inBlockComment = false;     // a block comment is open (opened ANYWHERE)
  let commentStart = -1;
  let commentOpenedInDefine = false;
  let commentSpannedLines = false;
  let literal: string | null = null;
  let changed = false;

  const appendMasked = (start: number, end: number): void => {
    out += source.slice(codeStart, start);
    out += source.slice(start, end).replace(/[^\r\n]/g, ' ');
    codeStart = end;
    changed = true;
  };

  while (i < source.length) {
    const c = source[i]!;

    if (inBlockComment) {
      if (c === '*' && source[i + 1] === '/') {
        const end = i + 2;
        if (commentOpenedInDefine) {
          appendMasked(commentStart, end);
          // A directive-body comment that spans lines means the opening line
          // had no splicing backslash at its end — the directive died there.
          if (commentSpannedLines) inDefine = false;
        }
        inBlockComment = false;
        commentOpenedInDefine = false;
        commentSpannedLines = false;
        i = end;
        continue;
      }
      if (c === '\n') commentSpannedLines = true;
      i++;
      continue;
    }

    if (atLogicalLineStart && !inDefine) {
      // Detect a directive at the logical-line head: blanks, `#`, blanks,
      // `define`, word boundary. Comments and literals never reach here —
      // their content is consumed by the states below — so a `#define` inside
      // a comment or string cannot start a directive.
      let j = i;
      while (source[j] === ' ' || source[j] === '\t' || source[j] === '\r') j++;
      if (source[j] === '#') {
        let k = j + 1;
        while (source[k] === ' ' || source[k] === '\t') k++;
        if (
          source.startsWith('define', k) &&
          !/[A-Za-z0-9_]/.test(source[k + 6] ?? '')
        ) {
          inDefine = true;
        }
      }
      atLogicalLineStart = false;
      continue; // rescan the same offset in normal token mode
    }

    if (literal !== null) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === literal) literal = null;
      else if (c === '\n') literal = null; // literals do not span lines
      i++;
      continue;
    }

    if (c === '"' || c === "'") {
      literal = c;
      i++;
      continue;
    }

    if (c === '/' && source[i + 1] === '/') {
      // Line comment: skip to end of line, keep verbatim (line comments are
      // not part of the observed pathology).
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? source.length : nl;
      continue;
    }

    if (c === '/' && source[i + 1] === '*') {
      inBlockComment = true;
      commentStart = i;
      commentOpenedInDefine = inDefine; // capture the state AT OPEN time
      commentSpannedLines = false;
      i += 2;
      continue;
    }

    if (c === '\\') {
      // Real cpp splicing: the backslash must immediately precede the
      // newline. Anything between the backslash and the newline — including a
      // comment — breaks the continuation, and the logical line ends at the
      // upcoming newline.
      if (source[i + 1] === '\n') {
        i += 2;
        continue; // logical line continues (inDefine stays)
      }
      if (source[i + 1] === '\r' && source[i + 2] === '\n') {
        i += 3;
        continue;
      }
      i++;
      continue;
    }

    if (c === '\n') {
      // Physical line end without a splicing backslash: logical line over.
      inDefine = false;
      atLogicalLineStart = true;
      i++;
      continue;
    }

    i++;
  }

  if (!changed) return source;
  out += source.slice(codeStart);
  return out;
}

/**
 * A `#define` line can only be collected by the regex fast path when its
 * header is fully classifiable on this physical line. Two shapes are NOT
 * safe and must keep the normal parse path:
 *
 * - `#define FN\` — name directly followed by the continuation backslash.
 *   The next line may open a parameter list (`(x) …`), making this a
 *   function-like macro whose header spans lines; the fast path would
 *   truncate its signature to `#define FN` and misclassify it.
 * - a name the fast path cannot extract at all — non-ASCII identifiers
 *   (`#define 宏函数(x)`) match neither the counting rule nor the extraction
 *   regex, while the tree-sitter parse CAN produce the node.
 *
 * Everything else — name then space/`(`/line-end/`\`-after-blanks — proves
 * the name extractable and the header complete on this line.
 */
function isFastPathSafeDefineHeader(trimmed: string): boolean {
  const m = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)/.exec(trimmed);
  if (!m) return false;
  return trimmed[m[0].length] !== '\\';
}

function isPureMacroDataHeader(source: string): boolean {
  if (process.env.CODEGRAPH_FORCE_PARSE === '1') return false;
  // Cheap pre-filter on the raw text: files with few #define lines cannot
  // qualify, and they are the overwhelming majority — skip the masking pass
  // entirely for them (this check runs on every C file). Comment-resident
  // `#define`s inflate this count, which only widens the pre-filter.
  let preCount = 0;
  for (const raw of source.split(/\r?\n/)) {
    if (/^\s*#\s*define\b/.test(raw)) preCount++;
  }
  if (preCount < 20) return false;

  const masked = maskCStyleCommentsAndLiterals(source);
  // The mask is code-unit length-preserving, so raw and masked split into
  // the same line count and any masked index addresses raw identically.
  const maskedLines = masked.split('\n');
  const rawLines = source.split('\n');
  let defineCount = 0;
  let paramMacroCount = 0;
  let inContinuation = false;
  for (let i = 0; i < maskedLines.length; i++) {
    const line = maskedLines[i]!;
    const trimmed = line.trim();
    // Trailing backslash continues the logical line, but only when it really
    // sits at the end of the RAW line too: masking replaces block comments
    // with spaces, which could disguise `#define X \ /* note */` as a
    // continuation and swallow the next line's real declaration — a swallow
    // the tree-sitter parse does not perform. Verify the raw bytes after the
    // backslash are all whitespace.
    const bs = /\\[ \t]*\r?$/.exec(line);
    const isContinued =
      bs !== null && /^[ \t]*\r?$/.test((rawLines[i] ?? '').slice(bs.index + 1));
    if (inContinuation) {
      // Body of the preceding directive — any content is allowed. Count
      // would-be macros so dangling-continuation tables stay on the fast
      // path (see the function doc for why they must not re-qualify for the
      // pathological parse); do not run function-like detection here, but the
      // header-safety gate still applies.
      if (/^#\s*define\b/.test(trimmed)) {
        if (!isFastPathSafeDefineHeader(trimmed)) return false;
        defineCount++;
      }
      inContinuation = isContinued;
      continue;
    }
    // Blank after masking = empty line or a line whose content was entirely
    // comment/literal. It cannot open a continuation (a lone `\` outside a
    // directive is invalid C anyway).
    if (trimmed === '') continue;
    if (!trimmed.startsWith('#')) {
      // Top-level DATA residue — rows a data macro's body left behind when
      // its continuation backslashes were lost or hidden behind a comment.
      // The row must consist ENTIRELY of data tokens (digits, commas, braces,
      // blanks, hex letters/prefix, sign, dot); identifier letters outside
      // hex and every other code character (word keywords, parentheses,
      // semicolons) disqualify it. Real code therefore never matches — even
      // `{} int real_fn(void) { return 0; }` keeps the file on the parse
      // path — while top-level pure data rows are inert either way (they are
      // invalid C, and the normal parse yields only symbol-free ERROR
      // nodes). A residue file on the parse path degenerates badly (a 485KB
      // repro parsed 8.2 minutes for 2 macros), so certified residue rows
      // stay on the fast path. Residue rows never open a continuation: a
      // trailing backslash is just more residue, and the next row is judged
      // on its own. Strip only one raw-confirmed terminal backslash for the
      // data check; embedded backslashes and comment-disguised suffixes must
      // still reject the fast path.
      const residue = bs !== null && isContinued
        ? line.slice(0, bs.index).trim()
        : trimmed;
      if (!/^[\d,{}\s+\-.xXa-fA-F]+$/.test(residue)) return false;
      continue;
    }
    if (/^#\s*define\b/.test(trimmed)) {
      if (!isFastPathSafeDefineHeader(trimmed)) return false;
      defineCount++;
      // Function-like macro: NAME immediately followed by '(' (no space).
      if (/^#\s*define\s+[A-Za-z_]\w*\(/.test(trimmed)) paramMacroCount++;
    }
    inContinuation = isContinued;
  }
  return defineCount >= 20 && paramMacroCount === 0;
}

/**
 * Collect macro names from a source string via regex, used when
 * isPureMacroDataHeader skips the tree-sitter parse. Produces `macro` nodes
 * with the same shape as TreeSitterExtractor.extractMacro, plus `contains`
 * edges from the file node. Recall is actually better than the broken parse
 * path, which only reaches the first macro under the giant preproc_ifdef node
 * before the O(n^2) slowdown swamps it.
 *
 * Directive lines are matched against the comment/literal-masked text (the
 * mask is length-preserving in UTF-16 code units, so offsets index the
 * original identically), so a `#define` written inside a block comment or a
 * string literal cannot become a ghost macro node. Signatures are sliced
 * from the ORIGINAL source at the same offsets, keeping comment content
 * visible in the stored signature.
 */
function extractMacrosByRegex(
  filePath: string,
  source: string,
  language: Language,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const fileId = `file:${filePath}`;
  const lineCount = source.split('\n').length;
  nodes.push({
    id: fileId,
    kind: 'file',
    name: path.basename(filePath),
    qualifiedName: filePath,
    filePath,
    language,
    startLine: 1,
    endLine: lineCount,
    startColumn: 0,
    endColumn: 0,
    isExported: false,
    updatedAt: Date.now(),
  });
  // `^` is line-anchored under the `m` flag, so m.index is the line start.
  // Blank classes are LINE-LOCAL (`[ \t]`, not `\s`): `\s` also matches the
  // newline, so a `#define` preceded by a blank line matched from the blank
  // line's own start — shifting the macro's line number, breaking its
  // column math, and slicing an empty signature. With `[ \t]` the match
  // always begins at the directive's physical line start.
  const masked = maskCStyleCommentsAndLiterals(source);
  const re = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)/gm;
  let m: RegExpExecArray | null;
  // exec() advances monotonically (the pattern always consumes at least one
  // character, so there is no zero-width match to worry about): count newlines
  // between consecutive matches with a cursor instead of re-scanning the whole
  // prefix per macro, keeping the fast path genuinely linear.
  let cursorIndex = 0;
  let cursorLine = 1;
  while ((m = re.exec(masked)) !== null) {
    const name = m[1]!;
    for (let i = cursorIndex; i < m.index; i++) {
      if (masked.charCodeAt(i) === 10) cursorLine++;
    }
    cursorIndex = m.index;
    const line = cursorLine;
    // Column of the macro name within its line: the regex match starts at the
    // line head, so the name's column is just the length of the prefix
    // `  #define ` = m[0]!.length - name.length.
    const startColumn = m[0]!.length - name.length;
    const lineEnd = masked.indexOf('\n', m.index);
    const lineEndIdx = lineEnd === -1 ? masked.length : lineEnd;
    const signature = source
      .slice(m.index, lineEndIdx)
      .replace(/\\\s*$/, '')
      .trimEnd();
    const id = generateNodeId(filePath, 'macro', name, line);
    nodes.push({
      id,
      kind: 'macro',
      name,
      qualifiedName: name,
      filePath,
      language,
      startLine: line,
      endLine: line,
      startColumn,
      endColumn: startColumn + name.length,
      isExported: true,
      signature,
      updatedAt: Date.now(),
    });
    edges.push({ source: fileId, target: id, kind: 'contains' });
  }
  return { nodes, edges };
}

/**
 * Extract nodes and edges from source code.
 *
 * If `frameworkNames` is provided, framework-specific extractors matching
 * those names and the file's language are run after the tree-sitter pass.
 * Their nodes/references/errors are merged into the returned result.
 */
export function extractFromSource(
  filePath: string,
  source: string,
  language?: Language,
  frameworkNames?: string[],
  globalMacroNames?: Set<string>,
  bodylessMacroNames?: Set<string>,
  macroDefinitions?: readonly CppMacroDefinition[],
  parserOverride?: WasmParser,
): ExtractionResult {
  const detectedLanguage = language || detectLanguage(filePath, source);
  const fileExtension = path.extname(filePath).toLowerCase();

  let result: ExtractionResult;

  // Use custom extractor for Svelte
  if (detectedLanguage === 'svelte') {
    const extractor = new SvelteExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'vue') {
    // Use custom extractor for Vue
    const extractor = new VueExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'liquid') {
    // Use custom extractor for Liquid
    const extractor = new LiquidExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'razor') {
    // Use custom extractor for ASP.NET Razor (.cshtml) / Blazor (.razor) markup
    const extractor = new RazorExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'xml') {
    // Custom extractor for MyBatis mapper XML. Non-mapper XML returns just a
    // file node so the watcher tracks it without emitting symbols.
    const extractor = new MyBatisExtractor(filePath, source);
    result = extractor.extract();
  } else if (isFileLevelOnlyLanguage(detectedLanguage)) {
    // No symbol extraction at this stage — files are tracked at the file-record
    // level only. Framework extractors (Drupal routing yml, Spring `@Value`
    // resolution against application.yml/application.properties) run later and
    // add per-file nodes/references when they apply.
    result = { nodes: [], edges: [], unresolvedReferences: [], errors: [], durationMs: 0 };
  } else if (
    detectedLanguage === 'pascal' &&
    (fileExtension === '.dfm' || fileExtension === '.fmx')
  ) {
    // Use custom extractor for DFM/FMX form files
    const extractor = new DfmExtractor(filePath, source);
    result = extractor.extract();
  } else {
    const extractor = new TreeSitterExtractor(
      filePath,
      source,
      detectedLanguage,
      globalMacroNames,
      bodylessMacroNames,
      macroDefinitions,
      parserOverride,
    );
    result = extractor.extract();
  }

  // Framework-specific extraction (routes, middleware, etc.)
  if (frameworkNames && frameworkNames.length > 0) {
    const allResolvers = getAllFrameworkResolvers();
    const applicable = getApplicableFrameworks(
      allResolvers.filter((r) => frameworkNames.includes(r.name)),
      detectedLanguage
    );
    for (const fw of applicable) {
      if (!fw.extract) continue;
      try {
        const fwResult = fw.extract(filePath, source);
        result.nodes.push(...fwResult.nodes);
        result.unresolvedReferences.push(...fwResult.references);
      } catch (err) {
        result.errors.push({
          message: `Framework extractor '${fw.name}' failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          filePath,
          severity: 'warning',
        });
      }
    }
  }

  return result;
}
