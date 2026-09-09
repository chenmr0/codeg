import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';

/**
 * Find the function NAME's `qualified_identifier` (`Foo::bar`) inside a
 * declarator, skipping the `parameter_list` — a parameter with a qualified type
 * (`const std::string& x`) must NOT be mistaken for the method name. Without the
 * skip, a plain free function `std::string TableFileName(const std::string&...)`
 * was named `string` (from the parameter type), so calls to it never resolved
 * and its file looked like nothing depended on it.
 */
function findDeclaratorQualifiedId(declarator: SyntaxNode): SyntaxNode | undefined {
  const queue: SyntaxNode[] = [declarator];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.type === 'qualified_identifier') return current;
    for (let i = 0; i < current.namedChildCount; i++) {
      const child = current.namedChild(i);
      // Don't descend into parameters or the trailing return type — their types
      // (`const std::string&`, `-> std::string`) aren't the function name.
      if (child && child.type !== 'parameter_list' && child.type !== 'trailing_return_type'
        && child.type !== 'template_argument_list') {
        queue.push(child);
      }
    }
  }
  return undefined;
}

function extractCppQualifiedMethodName(node: SyntaxNode, source: string): string | undefined {
  const declarator = getChildByField(node, 'declarator');
  if (!declarator) return undefined;
  const qid = findDeclaratorQualifiedId(declarator);
  if (!qid) return undefined;
  const parts = getNodeText(qid, source).trim().split('::').map(part => part.trim()).filter(Boolean);
  return parts[parts.length - 1];
}

function extractCppReceiverType(node: SyntaxNode, source: string): string | undefined {
  const declarator = getChildByField(node, 'declarator');
  if (!declarator) return undefined;
  const qid = findDeclaratorQualifiedId(declarator);
  if (!qid) return undefined;
  const parts = getNodeText(qid, source).trim().split('::').map(part => part.trim()).filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join('::') : undefined;
}

/**
 * Built-in / non-class return types that can never be a method receiver. We
 * store no `returnType` for these so resolution never tries to resolve a method
 * on `void` / `int` / etc.
 */
const CPP_NON_CLASS_RETURN = new Set([
  'void', 'bool', 'char', 'short', 'int', 'long', 'float', 'double', 'unsigned',
  'signed', 'size_t', 'ssize_t', 'auto', 'wchar_t', 'char8_t', 'char16_t',
  'char32_t', 'int8_t', 'int16_t', 'int32_t', 'int64_t', 'uint8_t', 'uint16_t',
  'uint32_t', 'uint64_t', 'intptr_t', 'uintptr_t', 'nullptr_t',
]);

/**
 * Language keywords can appear in a repository-wide macro union (legacy
 * portability headers sometimes contain declarations such as `#define const`).
 * They can never be statement-macro invocations in an already parseable C/C++
 * token stream, so treating an unrelated definition as globally active only
 * corrupts declarations in other translation units.
 */
const C_CPP_LANGUAGE_KEYWORDS: ReadonlySet<string> = new Set([
  'alignas', 'alignof', 'and', 'and_eq', 'asm', 'atomic_cancel',
  'atomic_commit', 'atomic_noexcept', 'auto', 'bitand', 'bitor', 'bool',
  'break', 'case', 'catch', 'char', 'char8_t', 'char16_t', 'char32_t',
  'class', 'compl', 'concept', 'const', 'consteval', 'constexpr',
  'constinit', 'const_cast', 'continue', 'co_await', 'co_return',
  'co_yield', 'decltype', 'default', 'delete', 'do', 'double',
  'dynamic_cast', 'else', 'enum', 'explicit', 'export', 'extern', 'false',
  'float', 'for', 'friend', 'goto', 'if', 'inline', 'int', 'long',
  'mutable', 'namespace', 'new', 'noexcept', 'not', 'not_eq', 'nullptr',
  'operator', 'or', 'or_eq', 'private', 'protected', 'public', 'reflexpr',
  'register', 'reinterpret_cast', 'requires', 'return', 'short', 'signed',
  'sizeof', 'static', 'static_assert', 'static_cast', 'struct', 'switch',
  'synchronized', 'template', 'this', 'thread_local', 'throw', 'true',
  'try', 'typedef', 'typeid', 'typename', 'union', 'unsigned', 'using',
  'virtual', 'void', 'volatile', 'wchar_t', 'while', 'xor', 'xor_eq',
  '_Alignas', '_Alignof', '_Atomic', '_Bool', '_Complex', '_Generic',
  '_Imaginary', '_Noreturn', '_Static_assert', '_Thread_local',
]);

/**
 * Normalize a C++ return type to the bare class name a method could be called
 * on. Unwraps smart-pointer / optional wrappers to their element type
 * (`std::unique_ptr<Widget>` → `Widget`) so a factory's `->method()` resolves on
 * the pointee. Strips cv-qualifiers, `&`/`*`, namespace qualifiers, and other
 * template args. Returns undefined for primitives / void / `auto` / empty.
 */
export function normalizeCppReturnType(raw: string): string | undefined {
  let t = raw.trim();
  if (!t) return undefined;
  // Unwrap smart pointers / optional to their pointee (the thing you call `->` on).
  const wrapper = t.match(/\b(?:std\s*::\s*)?(?:unique_ptr|shared_ptr|weak_ptr|optional)\s*<\s*([^,>]+?)\s*>/);
  if (wrapper && wrapper[1]) t = wrapper[1];
  t = t
    .replace(/\b(?:const|volatile|typename|struct|class|enum)\b/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[*&]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return undefined;
  const last = t.split('::').filter(Boolean).pop();
  if (!last) return undefined;
  if (CPP_NON_CLASS_RETURN.has(last)) return undefined;
  if (!/^[A-Za-z_]\w*$/.test(last)) return undefined;
  return last;
}

/**
 * A function/method's return type lives in the `function_definition`'s `type`
 * field (`Metrics& Metrics::instance()` → `Metrics`). Constructors, destructors,
 * and conversion operators have no `type` field → undefined.
 */
function extractCppReturnType(node: SyntaxNode, source: string): string | undefined {
  const typeNode = getChildByField(node, 'type');
  if (!typeNode) return undefined;
  return normalizeCppReturnType(getNodeText(typeNode, source));
}

// ---------------------------------------------------------------------------
// C++ template type-parameter extraction (getTypeParameters hook)
//
// tree-sitter-cpp wraps a templated declaration in a `template_declaration`
// node:
//   template_declaration
//     parameters: template_parameter_list
//       type_parameter / non_type_parameter / ...
//     declaration: <class_specifier | function_definition | alias_declaration | …>
//
// The hook returns the bare parameter names of the `template_declaration`(s)
// that DIRECTLY wrap a declaration, so each symbol stores only its OWN
// template parameters — a class template's `T` never leaks onto its ordinary
// member methods. The mechanism is a body-boundary rule (see
// CPP_TEMPLATE_SCOPE_BOUNDARY): walking up from a declaration to its
// template_declaration must not cross a class/struct/enum body
// (`field_declaration_list`) or a function body (`compound_statement`).
// An ordinary member reaches the class's template_declaration only by crossing
// the class body, so it's excluded; a member TEMPLATE reaches its own
// template_declaration without crossing a body, so it keeps its own params.
// Consecutively nested `template_declaration`s (out-of-line member-template
// definition: `template<T> template<U> void C<T>::m(U) {}`) are all collected.
// ---------------------------------------------------------------------------

/**
 * Body node types of a class/struct/enum (its member list) and a function
 * (its compound statement). Crossing one while walking up from a declaration
 * means we've left the declaration's own scope and entered an enclosing
 * class/function — so any `template_declaration` above it belongs to that
 * enclosing entity, NOT to this declaration. This is the guard that stops a
 * class template's `T` from leaking onto its ordinary member methods.
 */
const CPP_TEMPLATE_SCOPE_BOUNDARY = new Set([
  'field_declaration_list', // class/struct/enum body
  'compound_statement',     // function body
]);

/**
 * Node types that carry a template parameter's name. Keyword tokens and
 * `primitive_type` are deliberately excluded so a default value
 * (`typename U = int`) or a non-type parameter's type (`int N`) isn't mistaken
 * for the parameter name.
 */
const CPP_TEMPLATE_NAME_TYPES = new Set([
  'type_identifier',
  'identifier',
  'field_identifier',
]);

/**
 * Field names whose subtrees hold a default value, the parameter's type, the
 * nested template-parameter list of a template-template parameter, or a
 * requires-constraint — none of which is the parameter's own name. Skipped by
 * the controlled-recursion fallback so it can't surface a default type
 * (`typename T = Default`) or an inner template-template param as the name.
 */
const CPP_TEMPLATE_SKIP_FIELDS = new Set([
  'type',
  'default_type',
  'default',
  'value',
  'parameters',
  'constraint',
  'constraint_clause',
  'requirement',
]);

/**
 * Node types whose subtree is a nested parameter/template-parameter list or
 * call argument list — never the outer parameter's own name. Skipped by type
 * during the controlled-recursion fallback (independent of field names, so it
 * also covers anonymous/unnamed-field positions).
 */
const CPP_TEMPLATE_SKIP_TYPES = new Set([
  'template_parameter_list',
  'parameter_list',
  'argument_list',
]);

/**
 * Controlled recursion: find the first name-carrying identifier within `node`.
 *
 * - Unwraps declarator wrappers (`pointer_declarator` / `array_declarator` /
 *   `reference_declarator` / `parenthesized_declarator` / `init_declarator` /
 *   `function_declarator` / `qualified_identifier`) through their `declarator`
 *   field — this resolves a non-type parameter's name (`int N`, `int* P`,
 *   `auto&& R`) without entering its parameter/default sub-trees.
 * - When `allowDescend` is true, scans the node's named children, skipping any
 *   whose field name is in {@link CPP_TEMPLATE_SKIP_FIELDS} (default/type/
 *   nested-params/constraint) or whose type is in {@link CPP_TEMPLATE_SKIP_TYPES}
 *   (nested template_parameter_list / parameter_list / argument_list), so a
 *   template-template parameter's inner `<typename>` names and a default
 *   value's type can't leak out as the outer parameter's name.
 */
function cppFindNameIdentifier(
  node: SyntaxNode,
  source: string,
  allowDescend: boolean,
): string | undefined {
  if (CPP_TEMPLATE_NAME_TYPES.has(node.type)) {
    return getNodeText(node, source);
  }
  if (
    node.type === 'pointer_declarator' ||
    node.type === 'array_declarator' ||
    node.type === 'reference_declarator' ||
    node.type === 'parenthesized_declarator' ||
    node.type === 'init_declarator' ||
    node.type === 'function_declarator' ||
    node.type === 'qualified_identifier'
  ) {
    const inner = node.childForFieldName('declarator') || node.namedChild(0);
    if (inner) return cppFindNameIdentifier(inner, source, allowDescend);
    return undefined;
  }
  if (!allowDescend) return undefined;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (CPP_TEMPLATE_SKIP_TYPES.has(child.type)) continue;
    const fname = node.fieldNameForNamedChild(i);
    if (fname && CPP_TEMPLATE_SKIP_FIELDS.has(fname)) continue;
    const found = cppFindNameIdentifier(child, source, true);
    if (found) return found;
  }
  return undefined;
}

/**
 * Extract the bare name of a single template parameter node
 * (`type_parameter` / `non_type_parameter` / their variadic forms), or
 * undefined when the parameter is anonymous. Never guesses a name for an
 * anonymous parameter.
 *
 * - `type_parameter` (`typename T`, `class C`, `typename... Args`,
 *   `typename U = int`, template-template `template <…> class C`): the name is
 *   the `name` field (a type_identifier).
 * - `non_type_parameter` (`int N`, `int N = 5`, `auto... Vs`): the name lives in
 *   the `declarator` field; declarator wrappers are unwrapped to the identifier.
 * - Fallback: a bounded scan that skips default/type/constraint/nested-list
 *   subtrees (see {@link cppFindNameIdentifier}).
 */
function cppTemplateNameOf(param: SyntaxNode, source: string): string | undefined {
  // 1. `name` field — covers type_parameter variants (packs, defaults,
  //    template-template). The `...` of a pack is an anonymous token sibling,
  //    not the name, so the field still yields the bare identifier.
  const nameNode = param.childForFieldName('name');
  if (nameNode && nameNode.isNamed && CPP_TEMPLATE_NAME_TYPES.has(nameNode.type)) {
    return getNodeText(nameNode, source);
  }
  // 2. `declarator` field — covers non_type_parameter (`int N`).
  const declNode = param.childForFieldName('declarator');
  if (declNode) {
    const id = cppFindNameIdentifier(declNode, source, false);
    if (id) return id;
  }
  // 3. Bounded fallback scan over the parameter's own subtree.
  return cppFindNameIdentifier(param, source, true);
}

/**
 * Collect the parameter names of one `template_parameter_list` in source order,
 * skipping anonymous parameters. A nested `template_parameter_list` (the inner
 * list of a template-template `type_parameter`) may surface as a direct child
 * and is skipped here — its names belong to the inner template-template param,
 * not this list.
 */
function cppTemplateParamListNames(listNode: SyntaxNode, source: string): string[] {
  const names: string[] = [];
  for (let i = 0; i < listNode.namedChildCount; i++) {
    const child = listNode.namedChild(i);
    if (!child) continue;
    if (CPP_TEMPLATE_SKIP_TYPES.has(child.type)) continue;
    const name = cppTemplateNameOf(child, source);
    if (name) names.push(name);
  }
  return names;
}

/**
 * Resolve a `template_declaration`'s `template_parameter_list`, tolerating
 * field-name differences across grammar versions: prefer the `parameters`
 * field, else fall back to the first named child of type
 * `template_parameter_list`.
 */
function cppTemplateListOf(td: SyntaxNode): SyntaxNode | null {
  const paramsField = td.childForFieldName('parameters');
  if (paramsField && paramsField.type === 'template_parameter_list') {
    return paramsField;
  }
  for (let i = 0; i < td.namedChildCount; i++) {
    const child = td.namedChild(i);
    if (child && child.type === 'template_parameter_list') return child;
  }
  return null;
}

/**
 * Find the nearest ancestor `template_declaration` of `node` that is reached
 * WITHOUT crossing a class/function body boundary. Returns null if none. This
 * encodes "the template_declaration that wraps THIS declaration": crossing a
 * body means the node is a member of (or a statement inside) an enclosing
 * templated entity, so the template_declaration above the body belongs to that
 * entity, not to this declaration.
 */
function cppFindOwningTemplateDeclaration(node: SyntaxNode): SyntaxNode | null {
  let current: SyntaxNode | null = node.parent;
  let depth = 0;
  while (current && depth++ < 64) {
    if (CPP_TEMPLATE_SCOPE_BOUNDARY.has(current.type)) {
      return null; // crossed into an enclosing class/function body
    }
    if (current.type === 'template_declaration') {
      return current;
    }
    current = current.parent;
  }
  return null;
}

/**
 * C++ `getTypeParameters` hook. Walks up from a declaration node to the
 * `template_declaration`(s) that directly wrap it — without crossing a class/
 * function body boundary — and returns their parameter names in source order,
 * deduped. Returns undefined when the declaration isn't a template (so
 * non-templated nodes, and C in particular, are unaffected).
 *
 * The chain is collected innermost-first then reversed, so an outer
 * (source-earlier) `template_declaration`'s params precede an inner one's —
 * matching `template <typename T> template <typename U>` source order.
 */
export function cppGetTypeParameters(node: SyntaxNode, source: string): string[] | undefined {
  const chain: string[][] = [];
  let current: SyntaxNode | null = node;
  let depth = 0;
  while (current && depth++ < 32) {
    const td = cppFindOwningTemplateDeclaration(current);
    if (!td) break;
    const list = cppTemplateListOf(td);
    chain.push(list ? cppTemplateParamListNames(list, source) : []);
    current = td; // continue upward for a consecutively nested template_declaration
  }
  if (chain.length === 0) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = chain.length - 1; i >= 0; i--) {
    for (const n of chain[i]!) {
      if (!seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Build a compact function signature for a C/C++ `function_definition` so
 * `codegraph_search` can return parameters (every other language already
 * does via `getSignature`; C/C++ was the lone gap on definitions — prototypes
 * set their signature inline in the walker). Returns `retType name(params)`
 * (e.g. `int foo(int a, char** b)`, `void Foo::bar(int x)`); constructors /
 * destructors / conversion operators have no `type` field and yield just
 * `name(params)`. Whitespace is folded and the result is capped at 200 chars
 * so a heavily-templated signature doesn't dominate the one-line-per-result
 * search output.
 *
 * Only invoked on `function_definition` nodes (definitions with a body) via
 * extractFunction/extractMethod — the prototype path sets signature itself and
 * is unaffected.
 */
function extractCppSignature(node: SyntaxNode, source: string): string | undefined {
  const decl = getChildByField(node, 'declarator');
  if (!decl) return undefined;
  // Find the function_declarator inside the declarator tree. A pointer/
  // reference return wraps the function_declarator (`int* foo(...)`,
  // `std::vector<int>& bar(...)`), and tree-sitter doesn't always expose the
  // inner one via the `declarator` field (a reference_declarator holds it as an
  // untagged named child), so BFS the declarator subtree. Skip `parameter_list`
  // so a callback parameter (`void (*cb)(int)`) — which has its own
  // function_declarator — isn't mistaken for the function being signed.
  let fd: SyntaxNode | undefined;
  const queue: SyntaxNode[] = [decl];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.type === 'function_declarator') { fd = cur; break; }
    for (let i = 0; i < cur.namedChildCount; i++) {
      const c = cur.namedChild(i);
      if (c && c.type !== 'parameter_list') queue.push(c);
    }
  }
  if (!fd) return undefined;
  const typeNode = getChildByField(node, 'type');
  // Slice from the return type's start through the parameter list's end so a
  // pointer/reference return (`int* foo(...)`, `std::vector<int>& bar(...)`)
  // keeps its `*`/`&` — those live in the declarator wrapping the name, not
  // in the `type` field, so joining `type` + `function_declarator` text would
  // drop them. Constructors/destructors/conversion operators have no `type`.
  // A parse-only recovery may blank a trailing member-function `const`, which
  // makes the grammar end function_declarator at `)`. Recover that qualifier
  // from the offset-aligned extraction source without pulling constructor
  // initializer lists or the function body into the signature.
  let signatureEnd = fd.endIndex;
  const trailingText = source.slice(fd.endIndex, Math.min(node.endIndex, fd.endIndex + 256));
  const trailingConst = trailingText.match(/^\s+const\b/);
  if (trailingConst) signatureEnd += trailingConst[0].length;

  let sig = typeNode
    ? source.substring(typeNode.startIndex, signatureEnd)
    : source.substring(fd.startIndex, signatureEnd);
  sig = sig.replace(/\s+/g, ' ').trim();
  if (sig.length > 200) sig = sig.slice(0, 200) + '...';
  return sig || undefined;
}

/**
 * Replace a statement-like macro invocation with `0;` (padded to the same
 * byte length, newlines preserved) so tree-sitter's C/C++ parser doesn't
 * close the enclosing compound_statement early. The original text is the
 * full invocation (e.g. `SWITCH(x)` or `DEFAULT`); we overwrite the first
 * two chars with `0;` and blank the rest to spaces, keeping any `\n`s so
 * line numbers and byte offsets stay identical.
 */
function replaceWithSemicolon(text: string): string {
  const chars = [...text];
  if (chars.length >= 2) {
    chars[0] = '0';
    chars[1] = ';';
    for (let i = 2; i < chars.length; i++) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  } else if (chars.length === 1) {
    // Single-char macro → null statement.
    chars[0] = ';';
  }
  return chars.join('');
}

/**
 * Hide only a C++ member function's trailing `const` from the parser. In a
 * damaged class, tree-sitter-cpp can treat a run of otherwise valid
 * `method() const { ... }` definitions as top-level functions and close the
 * class early. Removing the cv-qualifier for parsing repairs that ambiguity.
 *
 * This is deliberately much narrower than treating a repository-wide
 * `#define const` as active everywhere: prefix uses (`const T value`,
 * `fn(const T&)`) remain untouched. The caller uses this output only for the
 * parse tree and keeps the unmodified token for signatures/source extraction.
 */
function maskCppTrailingMethodConst(source: string): string {
  const isIdentPart = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  let chars: string[] | null = null;
  let i = 0;
  while (i <= source.length - 5) {
    if (
      source.startsWith('const', i) &&
      (i === 0 || !isIdentPart(source[i - 1] ?? '')) &&
      !isIdentPart(source[i + 5] ?? '')
    ) {
      let previous = i - 1;
      while (previous >= 0 && /\s/.test(source[previous]!)) previous--;
      if (source[previous] === ')') {
        let next = i + 5;
        while (next < source.length && /\s/.test(source[next]!)) next++;
        const nextChar = source[next] ?? '';
        const nextWordMatch = source.slice(next).match(/^[A-Za-z_]\w*/);
        const nextWord = nextWordMatch?.[0] ?? '';
        const followsMethodQualifier =
          nextChar === '{' || nextChar === ';' || nextChar === '&' ||
          nextChar === '=' || nextChar === '-' || nextChar === '[' ||
          nextWord === 'noexcept' || nextWord === 'override' ||
          nextWord === 'final' || nextWord === 'requires' ||
          nextWord === 'volatile';
        if (followsMethodQualifier) {
          chars ??= source.split('');
          for (let j = i; j < i + 5; j++) chars[j] = ' ';
          i += 5;
          continue;
        }
      }
    }
    i++;
  }
  return chars?.join('') ?? source;
}

/**
 * Pre-parse transform for C/C++: replace statement-level macro invocations
 * with `0;` so tree-sitter's parser doesn't close the compound_statement
 * early on macros that expand to brace-balanced code WITHOUT a trailing
 * semicolon (e.g. open5gs SWITCH/CASE/DEFAULT/END in lib/core/ogs-macros.h).
 *
 * Tree-sitter's C/C++ grammars lack a preprocessor, so a bare `SWITCH(x)`
 * (no trailing `;`) parses as a call_expression that triggers error
 * recovery; as errors accumulate the parser eventually closes the function
 * body prematurely, dropping every subsequent call/statement into the
 * translation_unit. Replacing the invocation with a legal `0;` expression
 * statement keeps the compound_statement open so visitFunctionBody can
 * still walk every case body.
 *
 * A macro invocation is "statement-like" (and thus replaced) when ALL of:
 *   1. the identifier is in the known macro set (`macroNames`)
 *   2. paren depth is 0 (not inside a call/arg list — excludes macro
 *      constants used as arguments like `CASE(MACRO_CONST)` or
 *      `foo(x, MACRO_CONST)`)
 *   3. NOT inside an initializer list / aggregate body (braceStack top is
 *      not `true`) — excludes `NULL` in `{ NULL, 0 }`, `OB_X | 0x10` in
 *      `{ ... }`, macros in `enum E { A = MACRO }`, C++ `int x{ MACRO }`,
 *      `return { MACRO }`, etc.  Class/struct/namespace bodies are classified
 *      as `false` (allow replace) because they contain method bodies with
 *      statement-level macros and class-level macros like `TO_STRING_KV(...)`.
 *   4. NOT followed by `;` (no trailing semicolon → not a regular call;
 *      tree-sitter already handles those)
 *   5. NOT followed by `{` (preserves the existing isMisparsedFunction
 *      pattern `MACRO(params) { body }` — replacing it would break that
 *      mechanism)
 *   6. NOT followed by `,` (initializer-list element pattern — safety net
 *      for compound literals `(type){ MACRO, ... }` whose `{` was preceded
 *      by `)` and misclassified as a function body)
 *
 * String/char literals, line/block comments, and preprocessor directives
 * are skipped verbatim. The output preserves the exact byte length of the
 * input (replaced text is space-padded, newlines kept) so node positions
 * and getNodeText remain correct.
 */
/**
 * C/C++ keywords must never be rewritten merely because an unrelated file
 * defines a same-named macro.  In particular a C helper that defines
 * `final(a, b, c)` must not turn every C++ `class X final` into `class X 0;`.
 * Contextual C++ keywords are included as well because they are legal tokens
 * in declaration positions even though the preprocessor technically permits
 * a macro with the same spelling.
 */
const C_CPP_RESERVED_MACRO_TOKENS: ReadonlySet<string> = new Set([
  'alignas', 'alignof', 'and', 'and_eq', 'asm', 'auto', 'bitand', 'bitor',
  'bool', 'break', 'case', 'catch', 'char', 'char8_t', 'char16_t', 'char32_t',
  'class', 'compl', 'concept', 'const', 'consteval', 'constexpr', 'constinit',
  'const_cast', 'continue', 'co_await', 'co_return', 'co_yield', 'decltype',
  'default', 'delete', 'do', 'double', 'dynamic_cast', 'else', 'enum',
  'explicit', 'export', 'extern', 'false', 'final', 'float', 'for', 'friend',
  'goto', 'if', 'inline', 'int', 'long', 'mutable', 'namespace', 'new',
  'noexcept', 'not', 'not_eq', 'nullptr', 'operator', 'or', 'or_eq', 'override',
  'private', 'protected', 'public', 'register', 'reinterpret_cast', 'requires',
  'return', 'short', 'signed', 'sizeof', 'static', 'static_assert',
  'static_cast', 'struct', 'switch', 'template', 'this', 'thread_local',
  'throw', 'true', 'try', 'typedef', 'typeid', 'typename', 'union', 'unsigned',
  'using', 'virtual', 'void', 'volatile', 'wchar_t', 'while', 'xor', 'xor_eq',
]);

/** Declaration-only macro conventions used by common C/C++ toolchains. */
function looksLikeDeclarationModifierMacro(name: string): boolean {
  return /(?:API|ABI|DLL|EXPORT|IMPORT|PUBLIC|VISIBILITY|VISIBLE|DECLSPEC|ATTRIBUTE|ATTR|CALL|CDECL|STDCALL|FASTCALL|NODISCARD|NORETURN|NOEXCEPT|VTABLE|DEPRECATED|UNUSED|INLINE)/.test(name);
}

function preprocessStatementMacros(source: string, macroNames?: Set<string>, bodylessMacroNames?: Set<string>): string {
  const hasKnownMacros = !!macroNames?.size || !!bodylessMacroNames?.size;
  if (!hasKnownMacros) {
    // Most C/C++ files need no source rewrite. Keep the zero-macro fast path,
    // but still run the scanner for the three grammar-recovery shapes that do
    // not depend on a locally visible #define: a macro-shaped class head, a
    // conditional inside a real type body, or an operator< definition.
    const hasUnknownClassHeadModifier = /\b(?:class|struct)\s+(?:[A-Z_][A-Z0-9_]*\b|[A-Za-z_]\w*\s*\()/m.test(source);
    const hasConditionalTypeBody = /\b(?:class|struct)\s+[A-Za-z_]\w*(?:\s*::\s*[A-Za-z_]\w*)*(?:\s+final)?(?:\s*:[^{;]+)?\s*\{[\s\S]*#\s*(?:if|ifdef|ifndef|elif|else|endif)\b/m.test(source);
    const hasLessThanOperator = /\boperator\s*<\s*\(/m.test(source);
    if (!hasUnknownClassHeadModifier && !hasConditionalTypeBody && !hasLessThanOperator) {
      return source;
    }
  }

  const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
  const isIdentPart = (c: string) => /[A-Za-z0-9_]/.test(c);

  // Safe char access — returns '' for out-of-bounds (correct for all
  // equality comparisons below; the loop guards ensure we never push the
  // empty string from an out-of-range read).
  const at = (idx: number): string => (idx >= 0 && idx < source.length) ? source[idx]! : '';
  // Macro names are preprocessing TOKENS, never substrings of a larger C/C++
  // identifier. The scanner normally consumes a whole identifier in its
  // statement-macro branch, but contexts where replacement is disabled (most
  // importantly enum bodies and parenthesized declarators) advance one byte at
  // a time. Without this left-boundary check, `#define IN` is retried at the
  // `I` inside `SYNCETH_TYPE_IN` and erases the suffix, producing the bogus
  // symbol `SYNCETH_TYPE_`.
  const isIdentTokenStart = (idx: number): boolean =>
    isIdentStart(at(idx)) && (idx === 0 || !isIdentPart(at(idx - 1)));
  const isBodylessMacro = (name: string): boolean =>
    !!bodylessMacroNames?.has(name) && !C_CPP_LANGUAGE_KEYWORDS.has(name);
  const isStatementMacro = (name: string): boolean =>
    !!macroNames?.has(name) && !C_CPP_LANGUAGE_KEYWORDS.has(name);

  const out: string[] = [];
  let i = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  // Brace context stack — records the KIND of each `{` so macro-replacement
  // decisions can distinguish contexts that share the same parenDepth:
  //   'init'      initializer list / aggregate body  `{ NULL, 0 }`  → don't replace
  //   'enum'      enum body (enumerator initializers)             → don't replace
  //   'struct'    struct body (C field list OR C++ class-style)   → see below
  //   'class'     class body                                      → see below
  //   'stmt'      function body / statement block                 → replace OK
  //   'namespace' namespace body                                  → replace OK
  // In 'struct'/'class' bodies: function-like macros `MACRO(...)` are statement
  // macros and ARE replaced (C++ debug macros like TO_STRING_KV(...) sit at
  // class-body top level and must become `0;` or tree-sitter swallows the class).
  // But an object-like macro `MACRO` on its own line is a FIELD macro member
  // (C `typedef struct { VOS_MSG_HEADER ... }`) — replacing it with `0;` makes
  // the field list illegal and the whole struct is lost. So object-like macros
  // are kept verbatim here; the replace decision is in the identifier handler.
  type BraceKind = 'init' | 'enum' | 'struct' | 'class' | 'stmt' | 'namespace';
  interface BraceFrame {
    kind: BraceKind;
    parenDepthAtOpen: number;
    bracketDepthAtOpen: number;
    // tree-sitter-cpp can parse `operator<` itself, but confuses a member
    // comparison in its body (`a.value < b.value`) with a template-method
    // suffix. Keep this flag scoped to that operator body (and nested blocks)
    // so the offset-preserving recovery cannot affect ordinary functions.
    rewriteMemberLessThan: boolean;
    // A conditional that contributes only a declaration modifier can split a
    // member declaration in a way the grammar cannot represent. Once that
    // shape is proven for a class, nested conditional directives in the same
    // class are flattened as well so partial if/else statements do not make
    // error recovery discard the enclosing type.
    flattenConditionalDirectives: boolean;
    // Directly-written enum members need one narrow exception to project-wide
    // bodyless-macro blanking: an unrelated `#define MEMBER` must not erase the
    // declaration's name. This flag stays true through the initializer and is
    // reset only at the next direct enum-list comma.
    enumMemberSeen: boolean;
  }
  const braceStack: BraceFrame[] = [];
  // Set after a C++ `class`/`struct` token until the actual type name is seen.
  // Modifier macros in this narrow slot must expand to whitespace, not to the
  // statement placeholder `0;`.
  let expectingCppTypeName = false;
  // Keep the class/struct body classification from the declaration keyword to
  // its opening brace. A fixed-size backward scan cannot cover generated class
  // heads with very long inheritance lists.
  let pendingCppTypeBodyKind: 'class' | 'struct' | null = null;
  let pendingCppTypeNameSeen = false;
  let pendingCppTypeAllowsIdentifiers = false;
  // `class` inside `template<class T>` introduces a template parameter, not a
  // class body. Track only angle brackets opened by the `template` keyword so
  // those tokens do not arm pendingCppTypeBodyKind.
  let awaitingTemplateParameterList = false;
  let templateParameterDepth = 0;
  // Armed by an `operator<(` declarator and consumed by its definition body.
  // A declaration ending in `;` clears it without changing any source.
  let pendingLessThanOperatorBody = false;

  // Scan back over `out` to find the last non-whitespace character — used to
  // classify a `{` as function body (preceded by ')', ':', ';', '}') vs
  // initializer list (preceded by '=', ',', '(', identifier, etc.).
  const prevNonSpaceChar = (): string => {
    let k = out.length - 1;
    while (k >= 0 && /\s/.test(out[k]!)) k--;
    return k >= 0 ? out[k]! : '';
  };
  // Scan back over `out` to find the last complete identifier token — used to
  // recognize keywords like `return`, `do`, `else`, `try` before a `{`.
  const prevWord = (): string => {
    let k = out.length - 1;
    while (k >= 0 && /\s/.test(out[k]!)) k--;
    let end = k + 1;
    while (k >= 0 && isIdentPart(out[k]!)) k--;
    return out.slice(k + 1, end).join('');
  };
  // Scan back from the pending `{` to find the nearest type/namespace keyword.
  // Class/struct bodies use the structural pending state below; this fallback
  // remains necessary for enum (including `enum class`) and namespace bodies.
  const findTypeKeyword = (): string => {
    let k = out.length - 1;
    while (k >= 0 && /\s/.test(out[k]!)) k--;
    // Limit the backward scan to avoid O(n²) on large files — a type keyword
    // (class/struct/enum/namespace) always appears within a few hundred chars
    // of the `{` it introduces (type name + optional inheritance/templates).
    const limit = k - 512;
    while (k >= 0 && k > limit) {
      const ch = out[k]!;
      if (isIdentPart(ch)) {
        const end = k + 1;
        while (k >= 0 && isIdentPart(out[k]!)) k--;
        const word = out.slice(k + 1, end).join('');
        if (word === 'class' || word === 'struct' || word === 'enum' || word === 'namespace') {
          // `enum class Foo {` / `enum struct Foo {` are scoped enums — the
          // body is an enum body (enumerator initializers), not a class body.
          if (word === 'class' || word === 'struct') {
            let k2 = k;
            while (k2 >= 0 && /\s/.test(out[k2]!)) k2--;
            if (k2 >= 0 && isIdentPart(out[k2]!)) {
              const end2 = k2 + 1;
              while (k2 >= 0 && isIdentPart(out[k2]!)) k2--;
              if (out.slice(k2 + 1, end2).join('') === 'enum') return 'enum';
            }
          }
          return word;
        }
        // Not a type keyword — skip whitespace and continue scanning.
        while (k >= 0 && /\s/.test(out[k]!)) k--;
      } else if (ch === ';' || ch === '}' || ch === '{' || ch === ')') {
        return '';
      } else {
        k--;
      }
    }
    return '';
  };

  const n = source.length;

  const skipTrivia = (start: number): number => {
    let k = start;
    while (k < n) {
      while (k < n && /\s/.test(at(k))) k++;
      if (at(k) === '/' && at(k + 1) === '/') {
        const end = source.indexOf('\n', k + 2);
        return end === -1 ? n : skipTrivia(end + 1);
      }
      if (at(k) === '/' && at(k + 1) === '*') {
        const end = source.indexOf('*/', k + 2);
        k = end === -1 ? n : end + 2;
        continue;
      }
      break;
    }
    return k;
  };

  const knownRewritableMacro = (name: string): boolean =>
    !C_CPP_RESERVED_MACRO_TOKENS.has(name) &&
    (!!macroNames?.has(name) || !!bodylessMacroNames?.has(name));

  const followingIdentifier = (start: number): string | null => {
    const k = skipTrivia(start);
    if (!isIdentTokenStart(k)) return null;
    let end = k + 1;
    while (end < n && isIdentPart(at(end))) end++;
    return source.slice(k, end);
  };

  // Look past a run of declaration modifiers for the identifier that is
  // structurally followed by a class body/inheritance clause. This lets an
  // indexer recover common multi-token heads such as
  // `class WARN_UNUSED DLL_PUBLIC Name {` even when included macro definitions
  // are unavailable. The terminating class-head punctuation is required, so
  // an elaborated use like `class APIClient value;` is not rewritten.
  const hasLaterCppClassHead = (start: number): boolean => {
    let k = skipTrivia(start);
    while (k < n && isIdentTokenStart(k)) {
      let end = k + 1;
      while (end < n && isIdentPart(at(end))) end++;
      let after = skipTrivia(end);
      if (at(after) === '(') {
        let depth = 1;
        after++;
        while (after < n && depth > 0) {
          if (at(after) === '(') depth++;
          else if (at(after) === ')') depth--;
          after++;
        }
        after = skipTrivia(after);
      }
      if (at(after) === '{' || (at(after) === ':' && at(after + 1) !== ':')) return true;
      const continuation = followingIdentifier(after);
      if (continuation === 'final') return true;
      if (!isIdentTokenStart(after)) return false;
      k = after;
    }
    return false;
  };

  const isFirstNonWhitespaceOnLine = (idx: number): boolean => {
    let k = idx - 1;
    while (k >= 0 && at(k) !== '\n' && at(k) !== '\r') {
      if (at(k) !== ' ' && at(k) !== '\t') return false;
      k--;
    }
    return true;
  };

  const currentBraceFrame = (): BraceFrame | undefined =>
    braceStack.length > 0 ? braceStack[braceStack.length - 1] : undefined;

  const hasMemberAccessOnLeft = (operatorIndex: number): boolean => {
    let k = operatorIndex - 1;
    while (k >= 0 && /\s/.test(at(k))) k--;
    if (!isIdentPart(at(k))) return false;
    while (k >= 0 && isIdentPart(at(k))) k--;
    while (k >= 0 && /\s/.test(at(k))) k--;
    return at(k) === '.' || (at(k) === '>' && at(k - 1) === '-');
  };

  const isLikelyMemberTemplateSuffix = (openIndex: number): boolean => {
    let depth = 1;
    let k = openIndex + 1;
    while (k < n) {
      if (at(k) === '<') depth++;
      else if (at(k) === '>') {
        depth--;
        if (depth === 0) {
          const next = skipTrivia(k + 1);
          return at(next) === '(' || at(next) === '{'
            || (at(next) === ':' && at(next + 1) === ':');
        }
      } else if (depth === 1 && (at(k) === ';' || at(k) === '{' || at(k) === '}')) {
        return false;
      }
      k++;
    }
    return false;
  };

  const startsSplitModifierConditional = (directiveIndex: number): boolean => {
    const rest = source.slice(directiveIndex);
    const match = rest.match(
      /^#\s*(?:if|ifdef|ifndef)\b[^\r\n]*(?:\r?\n)[ \t]*(?:(?:constexpr|consteval|constinit|explicit|inline|virtual|static|friend)|[A-Z_][A-Z0-9_]*(?:[ \t]*\([^\r\n]*\))?)(?:[ \t]+(?:(?:constexpr|consteval|constinit|explicit|inline|virtual|static|friend)|[A-Z_][A-Z0-9_]*(?:[ \t]*\([^\r\n]*\))?))*[ \t]*(?:\r?\n)[ \t]*#\s*endif\b/
    );
    if (!match) return false;
    const next = skipTrivia(directiveIndex + match[0].length);
    return isIdentTokenStart(next) || at(next) === '~';
  };

  const isDirectEnumBody = (frame: BraceFrame | undefined): frame is BraceFrame =>
    frame?.kind === 'enum' &&
    parenDepth === frame.parenDepthAtOpen &&
    bracketDepth === frame.bracketDepthAtOpen;

  // Return the next token that determines whether an identifier is the enum
  // member's declared name. Trivia, C/C++ attributes, and following bodyless
  // postfix macros disappear before parsing and therefore do not change the
  // decision. Examples:
  //   MEMBER [[deprecated]],  -> ','  (MEMBER is the declared name)
  //   MEMBER EMPTY_ATTR,      -> ','  (MEMBER is the declared name)
  //   EMPTY_ATTR MEMBER,      -> 'M'  (EMPTY_ATTR is a prefix; blank it)
  const nextEnumStructuralToken = (start: number): number => {
    let k = start;
    while (k < n) {
      while (k < n && /\s/.test(at(k))) k++;

      if (at(k) === '/' && at(k + 1) === '/') {
        const end = source.indexOf('\n', k + 2);
        k = end === -1 ? n : end + 1;
        continue;
      }
      if (at(k) === '/' && at(k + 1) === '*') {
        const end = source.indexOf('*/', k + 2);
        k = end === -1 ? n : end + 2;
        continue;
      }

      // Enumerator attributes follow the identifier in C++/C23. Skip balanced
      // `[[...]]` groups so a colliding name before an attribute is preserved.
      if (at(k) === '[' && at(k + 1) === '[') {
        let depth = 1;
        k += 2;
        while (k < n && depth > 0) {
          if (at(k) === '[' && at(k + 1) === '[') {
            depth++;
            k += 2;
          } else if (at(k) === ']' && at(k + 1) === ']') {
            depth--;
            k += 2;
          } else if (at(k) === '"' || at(k) === "'") {
            const quote = at(k);
            k++;
            while (k < n) {
              if (at(k) === '\\') {
                k += 2;
              } else if (at(k) === quote) {
                k++;
                break;
              } else {
                k++;
              }
            }
          } else {
            k++;
          }
        }
        continue;
      }

      if (bodylessMacroNames && isIdentTokenStart(k)) {
        let end = k + 1;
        while (end < n && isIdentPart(at(end))) end++;
        if (isBodylessMacro(source.slice(k, end))) {
          k = end;
          continue;
        }
      }

      break;
    }
    return k;
  };

  const looksLikeEnumMemberName = (end: number): boolean => {
    const next = at(nextEnumStructuralToken(end));
    return next === '=' || next === ',' || next === '}';
  };

  while (i < n) {
    const c = at(i);

    // Line comment — copy verbatim to end of line.
    if (c === '/' && at(i + 1) === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out.push(source.slice(i, stop));
      i = stop;
      continue;
    }

    // Block comment — copy verbatim through `*/`.
    if (c === '/' && at(i + 1) === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out.push(source.slice(i, stop));
      i = stop;
      continue;
    }

    // String literal — copy verbatim through the closing quote (handle escapes).
    if (c === '"') {
      out.push(c);
      i++;
      while (i < n) {
        const ch = at(i);
        out.push(ch);
        i++;
        if (ch === '\\') {
          if (i < n) {
            out.push(at(i));
            i++;
          }
          continue;
        }
        if (ch === '"') break;
      }
      continue;
    }

    // Char literal — copy verbatim through the closing quote (handle escapes).
    if (c === "'") {
      out.push(c);
      i++;
      while (i < n) {
        const ch = at(i);
        out.push(ch);
        i++;
        if (ch === '\\') {
          if (i < n) {
            out.push(at(i));
            i++;
          }
          continue;
        }
        if (ch === "'") break;
      }
      continue;
    }

    // Preprocessor directive — copy the entire line verbatim (and any
    // line-continuation backslash continuations).
    if (c === '#') {
      // Only treat as preprocessor if at the start of a logical line
      // (only whitespace before it on this line).
      let lineStart = i;
      while (lineStart > 0 && at(lineStart - 1) !== '\n') lineStart--;
      let onlyWs = true;
      for (let k = lineStart; k < i; k++) {
        if (!/\s/.test(at(k))) { onlyWs = false; break; }
      }
      if (onlyWs) {
        // At direct class/struct scope, conditional-compilation branches are
        // alternative declarations. Blank only the directive bytes so both
        // branches remain indexable and split declarations such as
        // `#if X constexpr #endif Constructor()` stay inside their class.
        // Directives inside functions or declarators remain verbatim.
        const frame = currentBraceFrame();
        const isDirectTypeBody = (frame?.kind === 'class' || frame?.kind === 'struct')
          && parenDepth === frame.parenDepthAtOpen
          && bracketDepth === frame.bracketDepthAtOpen;
        const conditionalDirective = /^#\s*(?:if|ifdef|ifndef|elif|else|endif)\b/.test(source.slice(i));
        if (isDirectTypeBody && startsSplitModifierConditional(i) && frame) {
          frame.flattenConditionalDirectives = true;
        }
        const blankDirective = conditionalDirective
          && (isDirectTypeBody || !!frame?.flattenConditionalDirectives);
        while (i < n) {
          const directiveChar = at(i);
          out.push(blankDirective && directiveChar !== '\r' && directiveChar !== '\n' ? ' ' : directiveChar);
          if (at(i) === '\n') {
            // Honor line continuation: a backslash immediately before the
            // newline keeps the directive alive on the next line.  On CRLF
            // files the char before \n is \r, so skip it before checking.
            let p = i - 1;
            if (at(p) === '\r') p--;
            if (at(p) === '\\') { i++; continue; }
            i++;
            break;
          }
          i++;
        }
        continue;
      }
      // Otherwise fall through (an inline `#` outside directives — rare).
    }

    // An anonymous `class { ... }` / `struct { ... }` has no name slot. Do not
    // let the pending name state leak into its first field and erase a field
    // macro. pendingCppTypeBodyKind intentionally remains armed for the brace.
    if (expectingCppTypeName && (c === '{' || c === ';')) {
      expectingCppTypeName = false;
    }

    // C++ class-head modifier macros.  `class VCL_DLLPUBLIC Widget final`
    // needs to become `class               Widget final`; the old generic
    // statement rewrite produced `class 0; Widget final` and lost the whole
    // class body.  A colliding real class name is protected: it is blanked only
    // when another non-keyword identifier follows and can therefore be the
    // actual type name.
    let preserveAsCppTypeName = false;
    if (isIdentTokenStart(i)) {
      let j = i + 1;
      while (j < n && isIdentPart(at(j))) j++;
      const ident = source.slice(i, j);
      if (ident !== 'template' && awaitingTemplateParameterList) {
        // Explicit instantiation uses `template class Foo;` without `<...>`.
        // Do not let that `template` token arm an unrelated later `<`.
        awaitingTemplateParameterList = false;
      }
      if (ident === 'template') {
        awaitingTemplateParameterList = true;
      } else if (ident === 'operator') {
        const operatorToken = skipTrivia(j);
        const afterOperatorToken = skipTrivia(operatorToken + 1);
        const operatorFrameKind = currentBraceFrame()?.kind;
        const inOperatorDeclarationScope = !operatorFrameKind || operatorFrameKind === 'namespace'
          || operatorFrameKind === 'class' || operatorFrameKind === 'struct';
        if (inOperatorDeclarationScope && at(operatorToken) === '<' && at(operatorToken + 1) !== '<'
          && at(operatorToken + 1) !== '=' && at(afterOperatorToken) === '(') {
          pendingLessThanOperatorBody = true;
        }
      } else if ((ident === 'class' || ident === 'struct')
        && templateParameterDepth === 0 && prevWord() !== 'enum') {
        expectingCppTypeName = true;
        pendingCppTypeBodyKind = ident;
        pendingCppTypeNameSeen = false;
        pendingCppTypeAllowsIdentifiers = false;
      } else if (expectingCppTypeName && bracketDepth === 0) {
        let invEnd = j;
        const k = skipTrivia(j);
        if (at(k) === '(') {
          let depth = 1;
          invEnd = k + 1;
          while (invEnd < n && depth > 0) {
            if (at(invEnd) === '(') depth++;
            else if (at(invEnd) === ')') depth--;
            invEnd++;
          }
        }
        const nextIdentStart = skipTrivia(invEnd);
        const nextIdent = followingIdentifier(invEnd);
        let nextIdentEnd = nextIdentStart;
        while (nextIdentEnd < n && isIdentPart(at(nextIdentEnd))) nextIdentEnd++;
        const afterNextIdent = skipTrivia(nextIdentEnd);
        const continuationWord = followingIdentifier(afterNextIdent);
        const hasClassHeadContinuation = at(afterNextIdent) === '{'
          || (at(afterNextIdent) === ':' && at(afterNextIdent + 1) !== ':')
          || continuationWord === 'final';
        const hasModifierEvidence = invEnd > j || hasClassHeadContinuation
          || (knownRewritableMacro(ident) && looksLikeDeclarationModifierMacro(ident))
          || (looksLikeDeclarationModifierMacro(ident) && hasLaterCppClassHead(invEnd));
        // A function-like token or a second identifier followed by a class-head
        // continuation is a modifier macro even when its definition was not
        // indexed. Requiring that evidence preserves elaborated declarations
        // such as `struct Type variable = {...}`.
        if (nextIdent && !C_CPP_RESERVED_MACRO_TOKENS.has(nextIdent) && hasModifierEvidence) {
          out.push(source.slice(i, invEnd).replace(/[^\r\n]/g, ' '));
          i = invEnd;
          continue;
        }
        // No second identifier follows: this token is the actual type name,
        // even if a same-named macro exists elsewhere in the project.
        preserveAsCppTypeName = true;
        expectingCppTypeName = false;
        pendingCppTypeNameSeen = true;
      } else if (pendingCppTypeBodyKind && pendingCppTypeNameSeen && bracketDepth === 0
        && !pendingCppTypeAllowsIdentifiers && ident !== 'final'
        && ident !== 'alignas' && ident !== 'requires'
        && !knownRewritableMacro(ident) && !looksLikeDeclarationModifierMacro(ident)) {
        let previous = i - 1;
        while (previous >= 0 && /\s/.test(at(previous))) previous--;
        const continuesQualifiedName = at(previous) === ':' && at(previous - 1) === ':';
        if (!continuesQualifiedName) {
          // `struct Type variable = {...}` and `struct Type function()` are
          // elaborated type uses. Their later brace is an initializer/function
          // body, not the body of Type itself.
          pendingCppTypeBodyKind = null;
          pendingCppTypeNameSeen = false;
        }
      }
    }

    // Export/visibility/calling-convention macros in declaration scope expand
    // to attributes or nothing. Blank them instead of treating them as
    // statement macros. Function-like attributes are left to the class-head
    // path above because erasing arbitrary `MACRO(...)` here could remove a
    // legitimate expression.
    if (!preserveAsCppTypeName && isIdentTokenStart(i)) {
      let j = i + 1;
      while (j < n && isIdentPart(at(j))) j++;
      const ident = source.slice(i, j);
      const frameKind = currentBraceFrame()?.kind;
      const inDeclarationScope = !frameKind || frameKind === 'namespace' || frameKind === 'class' || frameKind === 'struct';
      const next = skipTrivia(j);
      if (inDeclarationScope && parenDepth === 0 && knownRewritableMacro(ident)
        && looksLikeDeclarationModifierMacro(ident) && at(next) !== '(') {
        out.push(' '.repeat(j - i));
        i = j;
        continue;
      }
    }

    // Bodyless object-like macro (`#define NAME` with empty body, NOT
    // function-like `NAME(...)`) expands to nothing, so blank the whole
    // identifier to spaces (byte-length preserved — keeps offsets/line
    // numbers exact so getNodeText stays correct). This is deliberately NOT
    // gated by parenDepth or general brace context: `BORROW` inside a parameter
    // list `T * BORROW name`, an empty prefix/postfix in an enum, and a bodyless
    // macro inside an initializer must still be blanked. The narrow exception
    // is a directly-written enum member name: the project-wide macro union may
    // contain an unrelated `#define MEMBER`, and erasing the declaration name
    // would silently drop that enum_member. String/char/comment/preprocessor-
    // directive contexts are already skipped above. This runs before the
    // statement-level `0;` logic so a bodyless prefix macro like
    // `typedef SAFE VOS_BOOL (*FnPtr)(...)` is reduced to the clean
    // `typedef  VOS_BOOL (*FnPtr)(...)` shape that tree-sitter parses correctly.
    if (bodylessMacroNames && bodylessMacroNames.size > 0 && isIdentTokenStart(i)) {
      let j = i + 1;
      while (j < n && isIdentPart(at(j))) j++;
      const ident = source.slice(i, j);
      if (!preserveAsCppTypeName && isBodylessMacro(ident)) {
        const frame = currentBraceFrame();
        if (isDirectEnumBody(frame) && !frame.enumMemberSeen && looksLikeEnumMemberName(j)) {
          frame.enumMemberSeen = true;
          out.push(source.slice(i, j));
          i = j;
          continue;
        }
        out.push(' '.repeat(j - i));
        i = j;
        continue;
      }
    }

    // Record ordinary enum names too, including names followed by bodyless
    // postfix attributes. This prevents the postfix token from being mistaken
    // for the member name merely because it is followed by a comma.
    const enumFrame = currentBraceFrame();
    if (isDirectEnumBody(enumFrame) && !enumFrame.enumMemberSeen && isIdentTokenStart(i)) {
      let j = i + 1;
      while (j < n && isIdentPart(at(j))) j++;
      if (looksLikeEnumMemberName(j)) enumFrame.enumMemberSeen = true;
    }

    // Track paren depth.
    if (c === '(') { parenDepth++; out.push(c); i++; continue; }
    if (c === ')') {
      parenDepth--;
      if (pendingCppTypeBodyKind && pendingCppTypeNameSeen) {
        pendingCppTypeBodyKind = null;
        pendingCppTypeNameSeen = false;
      }
      out.push(c);
      i++;
      continue;
    }
    if (c === '[') { bracketDepth++; out.push(c); i++; continue; }
    if (c === ']') { bracketDepth--; out.push(c); i++; continue; }
    if (c === '<' && currentBraceFrame()?.rewriteMemberLessThan
      && hasMemberAccessOnLeft(i) && !isLikelyMemberTemplateSuffix(i)) {
      // Parsing-only substitution for a tree-sitter-cpp ambiguity. `>` has the
      // same byte width and precedence family, so expression/call structure and
      // every source location are retained. The operator-body and member-access
      // guards keep ordinary templates and relational expressions untouched.
      out.push('>');
      i++;
      continue;
    }
    if (c === '<') {
      if (awaitingTemplateParameterList) {
        templateParameterDepth++;
        awaitingTemplateParameterList = false;
      } else if (templateParameterDepth > 0) {
        templateParameterDepth++;
      }
      out.push(c);
      i++;
      continue;
    }
    if (c === '>') {
      if (templateParameterDepth > 0) templateParameterDepth--;
      out.push(c);
      i++;
      continue;
    }
    if (c === ':' && pendingCppTypeBodyKind && pendingCppTypeNameSeen && at(i + 1) !== ':') {
      pendingCppTypeAllowsIdentifiers = true;
    }
    if ((c === '=' || c === '*' || c === '&') && pendingCppTypeBodyKind && pendingCppTypeNameSeen
      && !pendingCppTypeAllowsIdentifiers) {
      pendingCppTypeBodyKind = null;
      pendingCppTypeNameSeen = false;
    }

    // Track brace context — classify each `{` by kind (see braceStack decl).
    if (c === '{') {
      const pc = prevNonSpaceChar();
      const pw = prevWord();
      const tk = findTypeKeyword();
      // The pending state is authoritative for class/struct bodies. A backward
      // scan alone cannot distinguish `struct S {` from the initializer in
      // `struct S value = {`, because both still have a nearby `struct` token.
      // The scan remains useful for enum/namespace bodies.
      let kind: BraceKind;
      if (pendingCppTypeBodyKind) kind = pendingCppTypeBodyKind;
      else if (tk === 'namespace') kind = 'namespace';
      else if (tk === 'enum') kind = 'enum';
      else if (pc === ')' || pc === ':' || pc === ';' || pc === '}' ||
               pw === 'do' || pw === 'else' || pw === 'try' || pw === 'finally') kind = 'stmt';
      else kind = 'init';
      braceStack.push({
        kind,
        parenDepthAtOpen: parenDepth,
        bracketDepthAtOpen: bracketDepth,
        rewriteMemberLessThan: pendingLessThanOperatorBody
          || !!currentBraceFrame()?.rewriteMemberLessThan,
        flattenConditionalDirectives: !!currentBraceFrame()?.flattenConditionalDirectives,
        enumMemberSeen: false,
      });
      pendingLessThanOperatorBody = false;
      pendingCppTypeBodyKind = null;
      expectingCppTypeName = false;
      pendingCppTypeNameSeen = false;
      pendingCppTypeAllowsIdentifiers = false;
      out.push(c);
      i++;
      continue;
    }
    if (c === '}') {
      if (braceStack.length > 0) braceStack.pop();
      out.push(c);
      i++;
      continue;
    }
    if (c === ';') {
      pendingLessThanOperatorBody = false;
      pendingCppTypeBodyKind = null;
      expectingCppTypeName = false;
      pendingCppTypeNameSeen = false;
      pendingCppTypeAllowsIdentifiers = false;
    }

    // Only a direct enum-list comma starts the next member. Commas inside
    // parentheses, attributes, or nested braced initializers leave the current
    // enum frame untouched.
    const commaFrame = currentBraceFrame();
    if (c === ',' && isDirectEnumBody(commaFrame)) {
      commaFrame.enumMemberSeen = false;
    }

    // Identifier at depth 0 — candidate statement-level macro.
    const braceTop = currentBraceFrame()?.kind ?? '';
    const inNoReplace = braceTop === 'init' || braceTop === 'enum';
    if (isIdentTokenStart(i) && parenDepth === 0 && !inNoReplace) {
      let j = i + 1;
      while (j < n && isIdentPart(at(j))) j++;
      const ident = source.slice(i, j);

      if (!preserveAsCppTypeName && isStatementMacro(ident)) {
        // Find the end of the invocation: function-like MACRO(...) includes
        // through the matching `)`; object-like MACRO is just the identifier.
        let invEnd = j;
        let k = j;
        while (k < n && (at(k) === ' ' || at(k) === '\t')) k++;
        // Whether the invocation's arguments contain a `{` (a compound block,
        // e.g. `OX(SMART_VAR(...) { ... })`). When they do, tree-sitter sees
        // those braces directly and parses the invocation as a call_expression
        // without closing the enclosing compound_statement early — so replacing
        // it with `0;` (which blanks the internal `{ }` to spaces) only breaks
        // the parse. Skip replacement for such invocations; verbatim handling
        // is safe and preserves the real function body for callee extraction.
        let hasBrace = false;
        if (k < n && at(k) === '(') {
          let depth = 1;
          invEnd = k + 1;
          while (invEnd < n && depth > 0) {
            const ch = at(invEnd);
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
            else if (ch === '{') hasBrace = true;
            // Don't follow parens inside string/char literals.
            else if (ch === '"') {
              invEnd++;
              while (invEnd < n) {
                if (at(invEnd) === '\\') { invEnd += 2; continue; }
                if (at(invEnd) === '"') { invEnd++; break; }
                invEnd++;
              }
              continue;
            } else if (ch === "'") {
              invEnd++;
              while (invEnd < n) {
                if (at(invEnd) === '\\') { invEnd += 2; continue; }
                if (at(invEnd) === "'") { invEnd++; break; }
                invEnd++;
              }
              continue;
            }
            invEnd++;
          }
        }

        // Find the next non-whitespace token after the invocation.
        let nextIdx = invEnd;
        while (nextIdx < n && (at(nextIdx) === ' ' || at(nextIdx) === '\t' || at(nextIdx) === '\n' || at(nextIdx) === '\r')) nextIdx++;
        const nextTok = nextIdx < n ? at(nextIdx) : '';

        // Invocation arguments contain a compound block (`{ ... }`). tree-sitter
        // already handles these verbatim (the braces are visible to it), so
        // keep the original text — replacing with `0;` would erase the braces
        // and trigger error recovery that swallows the enclosing namespace into
        // a single oversized declaration node (see OX/SMART_VAR pattern).
        if (hasBrace) {
          out.push(source.slice(i, invEnd));
          i = invEnd;
          continue;
        }
        if (nextTok === ';' || nextTok === '{') {
          // Regular call (tree-sitter handles it) or the
          // MACRO(params) { body } pattern (handled by isMisparsedFunction).
          out.push(source.slice(i, invEnd));
          i = invEnd;
          continue;
        }
        if (nextTok === '-' && at(nextIdx + 1) === '>') {
          // A project-global macro may collide with a real C++ method name in
          // a trailing-return declaration: `auto PUT(...) -> void`.
          out.push(source.slice(i, invEnd));
          i = invEnd;
          continue;
        }
        if (nextTok === ',') {
          // Safety net: macro followed by ',' is an initializer-list element
          // pattern, not a statement-level macro.  This catches compound
          // literals `(type){ MACRO, ... }` whose `{` was preceded by ')' and
          // thus misclassified as a function body by braceStack.
          out.push(source.slice(i, invEnd));
          i = invEnd;
          continue;
        }

        // Type / template context — the identifier is used as a type, not a
        // statement-level macro invocation.  Replacing it would corrupt:
        //   `T *ptr` / `T &ref`      (pointer / reference declarator)
        //   `T>` / `T >`             (template parameter close)
        //   `T...>`                  (variadic parameter close, nextTok is '.')
        //   `obj.field`              (member access — rare for macros, safe to keep)
        // These next-token shapes never start a statement that a macro would
        // expand into, so skipping replacement has no downside.  This guard is
        // what prevents the "T-macro pollution" class of bug: when a project
        // `#define`s a common single-letter name (e.g. oceanbase test files
        // `#define T(t1,res) ...`), the global macro scan puts `T` in the set,
        // and without this guard every `template<class T>` / `T *x` in every
        // file gets corrupted into `template<class ;>` / `; *x`, collapsing
        // entire template classes into one misparsed function node.
        if (nextTok === '*' || nextTok === '&' || nextTok === '>' || nextTok === '.') {
          out.push(source.slice(i, invEnd));
          i = invEnd;
          continue;
        }
        // Function-pointer declarator — the identifier is used as the return
        // type of a `TYPE (*name)(params)` / `TYPE (*name[N])(params)` field or
        // typedef, NOT a statement-level macro invocation.  The matching `)` of
        // the (mis)detected `TYPE( ... )` invocation is immediately followed by
        // `(` — the parameter list of the function pointer — which never occurs
        // after a real statement macro (open5gs SWITCH/CASE/DEFAULT/END are
        // followed by `{`/`;`/EOL, never `(`).  Without this guard, a project-
        // wide `#define TYPE ...` (object- OR function-like) puts TYPE in the
        // global macro set, and `TYPE (*name)(params)` in an unrelated file
        // gets replaced with `0;`, destroying the field and the enclosing
        // struct/typedef — the "small module works, full build returns
        // nothing" regression.  Trade-off: the very rare `MACRO(a)(b)` double-
        // call statement macro is kept verbatim (tree-sitter still parses it as
        // a call_expression, no worse than before).
        if (nextTok === '(') {
          out.push(source.slice(i, invEnd));
          i = invEnd;
          continue;
        }
        // Object-like macro (no '(' after the identifier, so invEnd === j)
        // followed by an identifier on the SAME line is a declaration, not a
        // statement macro: `T func()`, `T var = ...`, `T data;`.  The statement-
        // macro pattern `MACRO\n  next_stmt()` has the next token on a DIFFERENT
        // line (coding style: statement macros sit on their own line), which we
        // detect by scanning for a newline between the macro and nextIdx.  This
        // distinguishes `T atoi_negative_unchecked(...)` (return type, same
        // line → keep) from open5gs `DEFAULT\n  ogs_error(...)` (statement
        // macro, next line → replace).  Restricted to object-like (invEnd === j)
        // so function-like `MACRO(args) bar;` on one line still replaces.
        //
        // Guard 2a — SINGLE-CHARACTER macro names: the pollution this guard
        // fixes is single-letter template params (T/U/V) that got `#define`d by
        // a test file and leaked into globalMacroNames.  For single-char macros,
        // ANY same-line identifier signals a declaration context (return type,
        // variable type) — keep verbatim.  Variable declarations whose type
        // macro gets replaced (`T var = ...` → `; var = ...`) are still rescued
        // by the expression_statement→assignment_expression extraction path, so
        // a broad keep here is safe.
        //
        // Guard 2b — MULTI-CHARACTER macro names: when the next identifier on
        // the same line is immediately followed by '(' (function definition /
        // declaration pattern, e.g. `VOS_UINT32 func(int x)`), keep the macro
        // verbatim as a return type.  Without this, `#define VOS_UINT32 uint32_t`
        // in the global macro set causes preParse to replace the return type
        // with `0;`, and tree-sitter-c then misparses `func(int x) {}` as a
        // `macro_type_specifier` instead of `function_definition`, dropping the
        // function entirely.  We only extend to the function-definition pattern
        // (ident + '(') because storage-class macros like `OB_INLINE` followed
        // by `void func()` have the TYPE name (void) — not the function name —
        // as the next identifier; those must still be replaced or tree-sitter
        // misparses the storage-class name as the function name.
        if (invEnd === j) {
          let sameLine = true;
          for (let k = invEnd; k < nextIdx; k++) {
            if (at(k) === '\n') { sameLine = false; break; }
          }
          if (sameLine && nextTok && isIdentStart(nextTok)) {
            if (ident.length === 1) {
              // Guard 2a: single-char macro + same-line identifier → declaration
              out.push(source.slice(i, invEnd));
              i = invEnd;
              continue;
            }
            // Guard 2b: multi-char macro + same-line identifier → the macro is
            // used as a type specifier for a declaration on the same line. We
            // keep it verbatim whenever the identifier is followed by a
            // declarator token: '(' (function def/decl), ';' / '[' / ',' / '='
            // / ':' (variable, array, multi-declaration, initializer, bitfield).
            // Without this, an object-like type macro like #define VOS_UINT32
            // unsigned int in the global set gets replaced with `0;` and the
            // declaration breaks into a bare identifier / subscript / comma
            // expression — `VOS_UINT32 g_x;` → `0; g_x;` drops the variable
            // node entirely (only `= initializer` variables were rescued by
            // the assignment-expression extraction path). Statement-level
            // macros sit on their OWN line (sameLine === false here), so this
            // same-line declarator check never traps a real statement macro.
            let afterIdent = nextIdx + 1;
            while (afterIdent < n && isIdentPart(at(afterIdent))) afterIdent++;
            // Skip whitespace (but not newlines — the declarator must be on
            // the same line as the identifier).
            while (afterIdent < n && (at(afterIdent) === ' ' || at(afterIdent) === '\t')) afterIdent++;
            const declTok = afterIdent < n ? at(afterIdent) : '';
            if (declTok === '(' || declTok === ';' || declTok === '[' || declTok === ',' || declTok === '=' || declTok === ':') {
              out.push(source.slice(i, invEnd));
              i = invEnd;
              continue;
            }
          }
        }

        // Object-like macro (`MACRO`, no parentheses) on its own line inside a
        // struct/class body is a FIELD macro member, not a statement macro —
        // e.g. C `typedef struct { VOS_MSG_HEADER; BBRF_MSG_HEADER; ... }`.
        // Replacing it with `0;` makes the field_declaration_list illegal and
        // tree-sitter loses the whole struct (the user-reported
        // BBRF_SIMPLE_COMM_RESP_STRU regression). Keep it verbatim; tree-sitter
        // parses it as a (possibly mistyped) field but the struct survives and
        // the typedef name is queryable. Function-like macros `MACRO(...)` are
        // NOT covered here (invEnd > j) — those stay statement macros and are
        // replaced below, which C++ class-body debug macros like TO_STRING_KV
        // require to avoid swallowing the class.
        if ((braceTop === 'struct' || braceTop === 'class') && invEnd === j) {
          out.push(source.slice(i, invEnd));
          i = invEnd;
          continue;
        }

        // Cross-file macro unions are only weak evidence in declaration
        // scopes. If the token is embedded in a declaration instead of being
        // the first token on its line (`virtual auto PUT(...)`), preserve it.
        // Function-body statement macros and line-leading class recovery
        // macros remain eligible for replacement.
        const inDeclarationScope = braceTop === '' || braceTop === 'namespace'
          || braceTop === 'struct' || braceTop === 'class';
        if (inDeclarationScope && !isFirstNonWhitespaceOnLine(i)) {
          out.push(source.slice(i, invEnd));
          i = invEnd;
          continue;
        }

        // Statement-level macro → replace with `0;` + spaces.
        out.push(replaceWithSemicolon(source.slice(i, invEnd)));
        i = invEnd;
        continue;
      }

      // Not a known macro — copy the identifier through.
      out.push(ident);
      i = j;
      continue;
    }

    // Default — copy char verbatim.
    out.push(c);
    i++;
  }

  return out.join('');
}

/**
 * Decide whether a function-shaped AST node whose name matches a known
 * `#define` macro is a real function/declaration or a tree-sitter misparse of
 * a macro invocation `MACRO(args) { body }`.
 *
 * C permits a function and a `#define` macro to share a name (a common debug
 * wrapper pattern, e.g. `TlmDynamicMemAlloc`). The old name-only check
 * suppressed every such name, which dropped real function definitions and
 * declarations along with the misparse (regression in commit d96678f).
 *
 * The reliable witness is NESTING, not the `type` field: a macro invocation
 * misparse always appears INSIDE a function body (its direct parent is a
 * `compound_statement`), because macros are called in code, not at file scope.
 * A real function definition / prototype lives at `translation_unit` level (or
 * inside a class/struct `field_declaration_list`).
 *
 * Nesting is required because the e7ef006 form — a REAL function
 * `RRE_ATTR VOS_UINT32 foo(...) {}` that tree-sitter splits so the function
 * name lands in the `type` field and the declarator becomes a
 * `parenthesized_declarator` — is structurally identical to the
 * `FOREACH_X(items)\n{ body }` misparse. Both have type.text === name and a
 * parenthesized_declarator; only the parent (translation_unit vs
 * compound_statement) tells them apart, so a type-field check alone cannot.
 */
function cCppIsMacroInvocationMisparse(
  name: string,
  node: SyntaxNode,
  macroNames?: Pick<ReadonlySet<string>, 'has'>
): boolean {
  if (!macroNames || !macroNames.has(name)) return false;
  // Declaration macros followed by a user-written body (`DEFINE_FOO(T) {}`)
  // can be parsed as a root-level function whose "return type" is the macro
  // name. Suppress that invocation wrapper; the declaration-macro auxiliary
  // parse recovers the expanded callable with its real name.
  const typeNode = getChildByField(node, 'type');
  if (typeNode?.text.trim() === name) return true;
  // A macro invocation `MACRO(args) { body }` that tree-sitter misparses as a
  // function_definition / declaration always appears INSIDE a function body —
  // its direct parent is a `compound_statement`, because macros are invoked in
  // code, not at file scope. A real function definition / prototype lives at
  // the `translation_unit` level (or inside a class/struct
  // `field_declaration_list`).
  //
  // The parent check is what distinguishes the e7ef006 form — a REAL function
  // `RRE_ATTR VOS_UINT32 foo(...) {}` that tree-sitter splits so the function
  // name lands in the `type` field and the declarator becomes a
  // `parenthesized_declarator` — from the structurally identical
  // `FOREACH_X(items)\n{ body }` misparse. Both have type.text === name and a
  // parenthesized_declarator; only the nesting differs (translation_unit vs
  // compound_statement), so a type-field check alone cannot tell them apart.
  const parent = node.parent;
  if (parent && parent.type === 'compound_statement') return true;
  return false;
}

// All declarators of a declaration share its qualifiers. Key by the immutable
// AST wrapper (never a numeric node ID, which can be reused by another tree),
// and let parsed trees be collected after extraction.
const directTypeQualifiers = new WeakMap<SyntaxNode, ReadonlySet<string>>();

function hasDirectTypeQualifier(node: SyntaxNode, qualifier: string): boolean {
  let qualifiers = directTypeQualifiers.get(node);
  if (!qualifiers) {
    const found = new Set<string>();
    // The bulk getter avoids one WASM child lookup per sibling, which is
    // especially expensive for generated declarations with thousands of names.
    for (const child of node.namedChildren) {
      if (child.type === 'type_qualifier') found.add(child.text);
    }
    qualifiers = found;
    directTypeQualifiers.set(node, qualifiers);
  }
  return qualifiers.has(qualifier);
}

/**
 * Classify the declared object rather than the declaration's base type.
 *
 * Tree-sitter nests declarator modifiers from the base type towards the
 * identifier. The modifier closest to the identifier is the top-level object:
 * `const T *items[]` is pointer -> array -> identifier, so it is an array whose
 * element type is a mutable pointer, not an array of constants.
 */
function isCppDeclaratorConst(declaration: SyntaxNode, declarator: SyntaxNode): boolean {
  if (hasDirectTypeQualifier(declaration, 'constexpr')) return true;
  const baseTypeIsConst = hasDirectTypeQualifier(declaration, 'const');
  const modifiers: SyntaxNode[] = [];
  let current: SyntaxNode | null = declarator;

  while (current) {
    if (current.type === 'init_declarator' || current.type === 'parenthesized_declarator') {
      current = getChildByField(current, 'declarator') ?? current.namedChild(0);
      continue;
    }
    if (
      current.type === 'pointer_declarator' ||
      current.type === 'array_declarator' ||
      current.type === 'reference_declarator'
    ) {
      modifiers.push(current);
      current = getChildByField(current, 'declarator') ?? current.namedChild(0);
      continue;
    }
    break;
  }

  // Arrays inherit their element type's constness. Strip each array layer,
  // then classify the element's outermost pointer/reference or the base type.
  let modifierIndex = modifiers.length - 1;
  while (modifierIndex >= 0 && modifiers[modifierIndex]!.type === 'array_declarator') {
    modifierIndex--;
  }
  if (modifierIndex < 0) return baseTypeIsConst;

  const modifier = modifiers[modifierIndex]!;
  if (modifier.type === 'reference_declarator') return false;
  return modifier.type === 'pointer_declarator' && hasDirectTypeQualifier(modifier, 'const');
}

export const cExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  // C unions share declaration/body semantics with structs. Treating them as
  // struct-like symbols also lets anonymous-union members be visited instead
  // of dropping the entire body.
  structTypes: ['struct_specifier', 'union_specifier'],
  enumTypes: ['enum_specifier'],
  enumMemberTypes: ['enumerator'],
  typeAliasTypes: ['type_definition'], // typedef
  importTypes: ['preproc_include'],
  callTypes: ['call_expression'],
  variableTypes: ['declaration'],
  macroTypes: ['preproc_def', 'preproc_function_def'],
  fieldTypes: ['field_declaration'],
  nameField: 'declarator',
  bodyField: 'body',
  paramsField: 'parameters',
  preParse: preprocessStatementMacros,
  preParseStrategy: 'on-error',
  getReturnType: extractCppReturnType,
  getSignature: extractCppSignature,
  isConst: (node) => {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c?.type === 'type_qualifier' && c.text === 'const') return true;
    }
    return false;
  },
  isDeclaratorConst: isCppDeclaratorConst,
  isStatic: (node) => {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c?.type === 'storage_class_specifier' && c.text === 'static') return true;
    }
    return false;
  },
  isExported: (node) => {
    // C file-scope symbols have external linkage by default, internal with `static`
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c?.type === 'storage_class_specifier' && c.text === 'static') return false;
    }
    return true;
  },
  isMisparsedFunction: (name, node, macroNames) => {
    // C macros cause tree-sitter to misparse macro invocations as function
    // definitions when the shape matches NAME(params) { body }.
    if (name.startsWith('namespace')) return true;
    const cppKeywords = ['switch', 'if', 'for', 'while', 'do', 'case', 'return'];
    if (cppKeywords.includes(name)) return true;
    return cCppIsMacroInvocationMisparse(name, node, macroNames);
  },
  resolveTypeAliasKind: (node, _source) => {
    // C typedef: `typedef enum { ... } name;` or `typedef struct { ... } name;`
    // The inner enum_specifier/struct_specifier is anonymous, but we want the typedef name
    // to become the enum/struct node name.
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'enum_specifier' && getChildByField(child, 'body')) return 'enum';
      if ((child.type === 'struct_specifier' || child.type === 'union_specifier')
        && getChildByField(child, 'body')) return 'struct';
    }
    return undefined;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    // C includes: #include <stdio.h>, #include "myheader.h"
    const systemLib = node.namedChildren.find((c: SyntaxNode) => c.type === 'system_lib_string');
    if (systemLib) {
      return { moduleName: getNodeText(systemLib, source).replace(/^<|>$/g, ''), signature: importText };
    }
    const stringLiteral = node.namedChildren.find((c: SyntaxNode) => c.type === 'string_literal');
    if (stringLiteral) {
      const stringContent = stringLiteral.namedChildren.find((c: SyntaxNode) => c.type === 'string_content');
      if (stringContent) {
        return { moduleName: getNodeText(stringContent, source), signature: importText };
      }
    }
    return null;
  },
};

/**
 * Visit a C++ `namespace_definition`: create a `namespace` node for named
 * namespaces and push it onto the scope stack so every declaration inside the
 * block carries the namespace prefix in its `qualifiedName` — e.g.
 *   namespace pre_process_buff { struct UbuffOffset {} }
 * yields the struct `UbuffOffset` with qn `pre_process_buff::UbuffOffset`, so
 * `codegraph node pre_process_buff::UbuffOffset` resolves and same-named types
 * in different namespaces are distinguishable.
 *
 * Anonymous namespaces (`namespace { ... }`) create no node and do not push the
 * scope — their declarations stay at file scope (file-internal linkage,
 * simple-name queryable), matching prior behaviour. Nested blocks
 * (`namespace A { namespace B { ... } }`) recurse naturally; the `A::B`
 * specifier form keeps the full `"A::B"` text as the node name so
 * `buildQualifiedName` joins it as a single segment (`A::B::X`). `inline
 * namespace` is handled the same way (the `inline` keyword is irrelevant to
 * extraction). `namespace_alias_definition` (`namespace B = A;`) is a distinct
 * node type and is NOT matched here.
 *
 * Returns true when the node was a `namespace_definition` (handled — skip the
 * generic dispatcher); false otherwise (let the default visit dispatch).
 */
function cppVisitNamespace(node: SyntaxNode, ctx: ExtractorContext): boolean {
  if (node.type !== 'namespace_definition') return false;

  const nameNode = getChildByField(node, 'name');
  const body = getChildByField(node, 'body');
  const nsName = nameNode ? getNodeText(nameNode, ctx.source).trim() : '';

  // Anonymous namespace (no name) — no node, no scope push; just walk the body
  // so its declarations are still extracted at file scope (simple-name queryable).
  if (!nsName) {
    visitNsChildren(ctx, body ?? node);
    return true;
  }

  const ns = ctx.createNode('namespace', nsName, node);
  if (ns) ctx.pushScope(ns.id);
  visitNsChildren(ctx, body ?? node);
  if (ns) ctx.popScope();
  return true;
}

/** Visit the named children of a namespace body (fall back to the node itself). */
function visitNsChildren(ctx: ExtractorContext, parent: SyntaxNode): void {
  for (let i = 0; i < parent.namedChildCount; i++) {
    const child = parent.namedChild(i);
    if (child) ctx.visitNode(child);
  }
}

export const cppExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: ['class_specifier'],
  methodTypes: ['function_definition'],
  interfaceTypes: [],
  structTypes: ['struct_specifier', 'union_specifier'],
  enumTypes: ['enum_specifier'],
  enumMemberTypes: ['enumerator'],
  typeAliasTypes: ['type_definition', 'alias_declaration'], // typedef and using
  importTypes: ['preproc_include'],
  callTypes: ['call_expression'],
  variableTypes: ['declaration'],
  macroTypes: ['preproc_def', 'preproc_function_def'],
  fieldTypes: ['field_declaration'],
  nameField: 'declarator',
  bodyField: 'body',
  paramsField: 'parameters',
  preParse: preprocessStatementMacros,
  preParseStrategy: 'on-error',
  parseOnlyRecovery: maskCppTrailingMethodConst,
  // Create a `namespace` node for each `namespace_definition` and scope its
  // declarations so their qualifiedName carries the namespace prefix (see
  // cppVisitNamespace above). Enables `codegraph node ns::symbol` lookups and
  // distinguishes same-named types across namespaces.
  visitNode: cppVisitNamespace,
  isConst: (node) => {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c?.type === 'type_qualifier' && c.text === 'const') return true;
      if (c?.text === 'constexpr') return true;
    }
    return false;
  },
  isDeclaratorConst: isCppDeclaratorConst,
  isStatic: (node) => {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c?.type === 'storage_class_specifier' && c.text === 'static') return true;
    }
    return false;
  },
  isExported: (node) => {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c?.type === 'storage_class_specifier' && c.text === 'static') return false;
    }
    return true;
  },
  resolveName: extractCppQualifiedMethodName,
  getReceiverType: extractCppReceiverType,
  getReturnType: extractCppReturnType,
  getSignature: extractCppSignature,
  getTypeParameters: cppGetTypeParameters,
  getVisibility: (node) => {
    // Check for access specifier in parent
    const parent = node.parent;
    if (parent) {
      for (let i = 0; i < parent.childCount; i++) {
        const child = parent.child(i);
        if (child?.type === 'access_specifier') {
          const text = child.text;
          if (text.includes('public')) return 'public';
          if (text.includes('private')) return 'private';
          if (text.includes('protected')) return 'protected';
        }
      }
    }
    return undefined;
  },
  resolveTypeAliasKind: (node, _source) => {
    // C++ typedef: `typedef enum { ... } name;` or `typedef struct { ... } name;`
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'enum_specifier' && getChildByField(child, 'body')) return 'enum';
      if (child.type === 'struct_specifier' && getChildByField(child, 'body')) return 'struct';
    }
    return undefined;
  },
  isMisparsedFunction: (name, node, macroNames) => {
    // C++ macros like NLOHMANN_JSON_NAMESPACE_BEGIN cause tree-sitter to misparse
    // namespace blocks as function_definitions (e.g. name = "namespace detail").
    // Also filter C++ keywords that tree-sitter occasionally misinterprets as
    // function/method names (e.g. switch statements inside macro-confused scopes).
    if (name.startsWith('namespace')) return true;
    const cppKeywords = ['switch', 'if', 'for', 'while', 'do', 'case', 'return'];
    if (cppKeywords.includes(name)) return true;
    // Filter out macro names that tree-sitter misparses as functions.
    // Tree-sitter C/C++ parsers lack a preprocessor: when a macro invocation
    // has the shape MACRO_NAME(params) { body }, it matches the
    // function_definition grammar rule and produces a spurious function node
    // for each call site (e.g. FOREACH_X creates 17 "functions" in OceanBase).
    // The form check below keeps real functions that merely share a name with
    // a macro (C permits `void* foo(int);` alongside `#define foo(...)`).
    return cCppIsMacroInvocationMisparse(name, node, macroNames);
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    // C++ includes: #include <iostream>, #include "myheader.h"
    const systemLib = node.namedChildren.find((c: SyntaxNode) => c.type === 'system_lib_string');
    if (systemLib) {
      return { moduleName: getNodeText(systemLib, source).replace(/^<|>$/g, ''), signature: importText };
    }
    const stringLiteral = node.namedChildren.find((c: SyntaxNode) => c.type === 'string_literal');
    if (stringLiteral) {
      const stringContent = stringLiteral.namedChildren.find((c: SyntaxNode) => c.type === 'string_content');
      if (stringContent) {
        return { moduleName: getNodeText(stringContent, source), signature: importText };
      }
    }
    return null;
  },
};
