import type { Node } from '../types';

const CPP_TYPE_SUFFIX_KEYWORDS = new Set([
  'const', 'volatile', 'signed', 'unsigned', 'short', 'long',
  'void', 'bool', 'char', 'wchar_t', 'char8_t', 'char16_t', 'char32_t',
  'int', 'float', 'double', 'auto', 'decltype', 'typename',
]);

const CPP_TYPE_PREFIX_ONLY_KEYWORDS = new Set([
  'const', 'volatile', 'struct', 'class', 'union', 'enum', 'typename',
]);

function stripTrailingDeclaratorName(param: string): string {
  const match = /\s+((?:[*&]\s*)+)?([A-Za-z_$][\w$]*)\s*$/.exec(param);
  if (!match || CPP_TYPE_SUFFIX_KEYWORDS.has(match[2]!)) return param;
  if (!match[1]) {
    const prefixWords = param.slice(0, match.index).match(/[A-Za-z_$][\w$]*/g) ?? [];
    if (
      prefixWords.length > 0 &&
      prefixWords.every((word) => CPP_TYPE_PREFIX_ONLY_KEYWORDS.has(word))
    ) return param;
  }
  return param.slice(0, match.index) + (match[1] ?? '');
}

function stripNestedPointerReferenceNames(param: string): string {
  return param.replace(
    /([*&])\s*([A-Za-z_$][\w$]*)\s*(?=,|\))/g,
    (whole, ptr: string, name: string) =>
      CPP_TYPE_SUFFIX_KEYWORDS.has(name) ? whole : ptr,
  );
}

/**
 * Tokenize a canonical C++ parameter without losing lexical boundaries.
 * Removing all whitespace turns `const common::Type` into
 * `constcommon::Type`, which prevents the qualified-name suffix comparison
 * from seeing `common::Type` and `Type` as the same type.
 */
function cppParameterTokens(value: string): string[] {
  return value.match(
    /[A-Za-z_$][\w$]*(?:::[A-Za-z_$][\w$]*)+|[A-Za-z_$][\w$]*|&&|\.\.\.|[^\s]/g,
  ) ?? [];
}

/**
 * Canonical parameter-list identity for a C++ callable.
 *
 * Return type, owner qualification, default arguments, whitespace, trailing
 * declaration specifiers (`override`, `final`, `noexcept`), and a simple
 * parameter name are ignored. The result intentionally keeps the parameter
 * types themselves, so real overloads such as `push()` and `push(Buffer *)`
 * remain distinct.
 */
export function cppParameterKey(node: Pick<Node, 'name' | 'signature'>): string | null {
  const signature = node.signature?.trim();
  if (!signature) return null;
  let nameAt = -1;
  for (let from = 0; from < signature.length;) {
    const candidate = signature.indexOf(node.name, from);
    if (candidate < 0) break;
    const before = signature[candidate - 1];
    const afterName = candidate + node.name.length;
    let after = afterName;
    while (/\s/.test(signature[after] ?? '')) after++;
    if (
      (!before || !/[\w$]/.test(before)) &&
      !/[\w$]/.test(signature[afterName] ?? '') &&
      signature[after] === '('
    ) {
      nameAt = candidate;
      break;
    }
    from = candidate + node.name.length;
  }
  if (nameAt < 0) return null;
  const open = signature.indexOf('(', nameAt + node.name.length);
  if (open < 0) return null;

  let depth = 0;
  let close = -1;
  for (let i = open; i < signature.length; i++) {
    const ch = signature[i]!;
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) { close = i; break; }
  }
  if (close < 0) return null;

  const raw = signature.slice(open + 1, close);
  const params: string[] = [];
  let start = 0;
  let nested = 0;
  for (let i = 0; i <= raw.length; i++) {
    const ch = raw[i];
    if (ch === '<' || ch === '(' || ch === '[' || ch === '{') nested++;
    else if (ch === '>' || ch === ')' || ch === ']' || ch === '}') nested = Math.max(0, nested - 1);
    if ((ch === ',' && nested === 0) || i === raw.length) {
      let param = raw.slice(start, i).trim();
      start = i + 1;
      if (!param) continue;

      // Drop a top-level default expression. Nested defaults inside templates
      // or callbacks are deliberately left intact rather than guessed at.
      let defaultAt = -1;
      let defaultDepth = 0;
      for (let j = 0; j < param.length; j++) {
        const c = param[j]!;
        if (c === '<' || c === '(' || c === '[' || c === '{') defaultDepth++;
        else if (c === '>' || c === ')' || c === ']' || c === '}') defaultDepth = Math.max(0, defaultDepth - 1);
        else if (c === '=' && defaultDepth === 0) { defaultAt = j; break; }
      }
      if (defaultAt >= 0) param = param.slice(0, defaultAt).trim();

      // A declaration may spell names inside a nested callable type while the
      // definition omits them, for example
      // `std::function<int(const Buffer &buffer)>` versus
      // `std::function<int(const Buffer &)>`. Pointer/reference declarator
      // names are unambiguous here: the identifier following `*`/`&` cannot
      // be part of the parameter type. Strip those before whitespace is lost.
      param = stripNestedPointerReferenceNames(param);

      // `T value`, `T *value`, and `T &value` all identify the same parameter
      // type as a declaration that omits the name. Avoid function-pointer and
      // array declarators: removing their embedded identifier needs a parser,
      // and a missed edge is safer than a false overload pair.
      param = stripTrailingDeclaratorName(param);
      params.push(cppParameterTokens(param).join(' '));
    }
  }
  return params.join(' , ');
}

/**
 * Compare canonical parameter keys while tolerating a definition that uses an
 * unqualified type made visible by a `using` declaration. Qualified names are
 * compatible only when one is a suffix of the other (`common::Row` vs `Row`,
 * or `oceanbase::common::Row` vs `common::Row`); unrelated owners such as
 * `left::Row` and `right::Row` remain distinct.
 */
export function cppParameterKeysMatch(left: string, right: string): boolean {
  if (left === right) return true;

  const leftTokens = cppParameterTokens(left);
  const rightTokens = cppParameterTokens(right);
  if (leftTokens.length !== rightTokens.length) return false;

  const qualifiedNameMatches = (a: string, b: string): boolean => {
    if (a === b) return true;
    const aParts = a.split('::');
    const bParts = b.split('::');
    if (aParts.length === 1 && bParts.length === 1) return false;
    const shorter = aParts.length <= bParts.length ? aParts : bParts;
    const longer = aParts.length <= bParts.length ? bParts : aParts;
    const suffix = longer.slice(longer.length - shorter.length);
    return suffix.every((part, index) => part === shorter[index]);
  };

  return leftTokens.every((token, index) =>
    qualifiedNameMatches(token, rightTokens[index]!)
  );
}

/**
 * Compare the owners of two C++ callables. An out-of-line definition may be
 * indexed as `Class::method` while its in-class declaration is qualified as
 * `namespace::Class::method`; that suffix relationship is valid. Two fully
 * qualified but different owners are not (`left::Class` vs `right::Class`).
 */
export function cppCallableOwnersMatch(
  left: Pick<Node, 'qualifiedName'>,
  right: Pick<Node, 'qualifiedName'>,
): boolean {
  const ownerParts = (qualifiedName: string): string[] => {
    const parts = qualifiedName.replace(/\./g, '::').split('::').filter(Boolean);
    parts.pop();
    return parts;
  };
  const leftOwner = ownerParts(left.qualifiedName);
  const rightOwner = ownerParts(right.qualifiedName);
  if (leftOwner.length === 0 || rightOwner.length === 0) return false;
  const shorter = leftOwner.length <= rightOwner.length ? leftOwner : rightOwner;
  const longer = leftOwner.length <= rightOwner.length ? rightOwner : leftOwner;
  return longer
    .slice(longer.length - shorter.length)
    .every((part, index) => part === shorter[index]);
}

/** Parse and compare two C++ callable nodes using the shared overload rules. */
export function cppCallableParametersMatch(
  left: Pick<Node, 'name' | 'signature'>,
  right: Pick<Node, 'name' | 'signature'>,
): boolean | null {
  const leftKey = cppParameterKey(left);
  const rightKey = cppParameterKey(right);
  if (leftKey === null || rightKey === null) return null;
  return cppParameterKeysMatch(leftKey, rightKey);
}
