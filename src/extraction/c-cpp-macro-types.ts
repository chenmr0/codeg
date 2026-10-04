import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { CppTypeBindings } from './cpp-type-bindings';

// Preserve literals and token boundaries; whitespace/comments are not identity.
export function cppIdentityTokens(text: string): string[] {
  return (text.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|(?:[\p{ID_Start}_$]|\\u[\da-fA-F]{4}|\\U[\da-fA-F]{8})(?:[\p{ID_Continue}$]|\\u[\da-fA-F]{4}|\\U[\da-fA-F]{8})*|\d+|::|&&|\.\.\.|[^\s]/gu) ?? [])
    .filter(token => !token.startsWith('/*') && !token.startsWith('//'));
}

export const isCppIdentityIdentifier = (text: string): boolean => /^(?:[\p{ID_Start}_$]|\\u[\da-fA-F]{4}|\\U[\da-fA-F]{8})(?:[\p{ID_Continue}$]|\\u[\da-fA-F]{4}|\\U[\da-fA-F]{8})*$/u.test(text);

type Normalize = (text: string, offset?: number) => string;
const tokens: Normalize = text => cppIdentityTokens(text).join(' ');
type TypeOperator = [kind: string, ...details: unknown[]];

function nestedDeclarator(node: SyntaxNode): SyntaxNode | null {
  return node.childForFieldName('declarator')
    ?? node.namedChildren.find(child => child.type.includes('declarator')
      || ['identifier', 'field_identifier', 'type_identifier', 'qualified_identifier'].includes(child.type)) ?? null;
}

/** Operators in order from the declared name outwards. Parentheses affect
 * that order, but are not themselves type constructors: int *a[3] is an array
 * of pointers, whereas int (*a)[3] is a pointer to an array.
 */
function typeOperators(node: SyntaxNode | null, source: string, normalize: Normalize, stop?: SyntaxNode,
  bindings?: CppTypeBindings, aliases = new Set<number>()): TypeOperator[] | null {
  if (!node || node.id === stop?.id || ['identifier', 'field_identifier', 'type_identifier'].includes(node.type)) return [];
  if (node.type === 'qualified_identifier') {
    let pointer: SyntaxNode | null = node;
    while (pointer?.type === 'qualified_identifier') pointer = pointer.childForFieldName('name');
    if (pointer?.type !== 'pointer_type_declarator') return null;
    const operators = typeOperators(pointer, source, normalize, stop, bindings, aliases);
    const outer = operators?.[operators.length - 1];
    if (!operators || outer?.[0] !== 'pointer') return null;
    const writtenOwner = source.slice(node.startIndex, pointer.startIndex);
    let owner = normalize(writtenOwner, node.startIndex).replace(/\s*::$/, '');
    if (owner === tokens(writtenOwner).replace(/\s*::$/, '')) {
      const binding = bindings?.resolve(node, owner);
      if (binding?.kind === 'nominal') owner = binding.name;
      else if (binding?.kind === 'alias' && !aliases.has(binding.node.id) && aliases.size < 16) {
        const next = new Set(aliases).add(binding.node.id);
        const declared = typeOperators(binding.declarator, source, tokens, undefined, bindings, next);
        if (declared) {
          const shape = typeShape(binding.type, binding.qualifiers, declared, source, tokens, bindings, next);
          if (!shape.operators.length && !shape.qualifiers.length && shape.base.startsWith('::')) owner = shape.base;
        }
      }
    }
    operators[operators.length - 1] = ['member-pointer', outer[1], owner];
    return operators;
  }
  const child = nestedDeclarator(node);
  const operators = typeOperators(child, source, normalize, stop, bindings, aliases);
  if (!operators) return null;
  const kind = node.type.replace(/^abstract_/, '');
  const extras = node.namedChildren.filter(n => n.id !== child?.id && n.type !== 'comment');
  // An unsupported nested node is not an empty (abstract) declarator.
  if (kind === 'parenthesized_declarator') return child && extras.length === 0 ? operators : null;
  if (kind === 'pointer_declarator' || kind === 'pointer_type_declarator') {
    operators.push(['pointer', extras.map(n => normalize(n.text, n.startIndex)).sort()]);
  } else if (kind === 'reference_declarator') {
    operators.push(['reference', node.children.some(n => n.type === '&&') ? '&&' : '&', extras.map(n => normalize(n.text, n.startIndex))]);
  } else if (kind === 'array_declarator') {
    operators.push(['array', extras.map(n => normalize(n.text, n.startIndex))]);
  } else if (kind === 'function_declarator') {
    const parameters = node.childForFieldName('parameters');
    if (!parameters) return null;
    operators.push(['function', cppParameterTypes(parameters, source, normalize, bindings, aliases),
      extras.filter(n => n.id !== parameters.id).map(n => normalize(n.text, n.startIndex))]);
  } else if (kind === 'variadic_declarator') {
    operators.push(['pack']);
  } else {
    return null; // Unknown syntax must retain its spelling, not lose evidence.
  }
  return operators;
}

/** Strip only the declared parameter name/default on the conservative path.
 * Never erase unsupported type constructors in order to obtain a match.
 */
function parameterSpelling(parameter: SyntaxNode, source: string): string {
  const end = parameter.children.find(n => n.type === '=')?.startIndex ?? parameter.endIndex;
  const name = parameterName(parameter);
  return name && name.endIndex <= end
    ? source.slice(parameter.startIndex, name.startIndex) + ' ' + source.slice(name.endIndex, end)
    : source.slice(parameter.startIndex, end);
}

function parameterName(parameter: SyntaxNode): SyntaxNode | null {
  let name = parameter.childForFieldName('declarator');
  while (name && !['identifier', 'field_identifier', 'type_identifier'].includes(name.type)) {
    name = name.type === 'qualified_identifier' ? name.childForFieldName('name') : nestedDeclarator(name);
  }
  return name;
}

/** C/C++ function parameter identity after array/function adjustment and
 * removal of top-level cv. Apply this recursively to callback parameters too.
 */
export function cppParameterType(parameter: SyntaxNode, source: string, normalize: Normalize = tokens,
  bindings?: CppTypeBindings, aliases = new Set<number>()): string {
  if (!parameter.type.endsWith('parameter_declaration')) return normalize(parameter.text, parameter.startIndex);
  const declarator = parameter.childForFieldName('declarator');
  const operators = typeOperators(declarator, source, normalize, undefined, bindings, aliases);
  if (!operators) return normalize(parameterSpelling(parameter, source), parameter.startIndex);
  const equals = parameter.children.find(n => n.type === '=');
  const parts = parameter.namedChildren.filter(n => n.id !== declarator?.id && n.type !== 'comment'
    && (!equals || n.startIndex < equals.startIndex));
  const type = parameter.childForFieldName('type');
  // Keep annotations or unsupported specifiers instead of erasing them.
  if (parts.some(n => n.id !== type?.id && n.type !== 'type_qualifier')) return normalize(parameterSpelling(parameter, source), parameter.startIndex);
  const shape = typeShape(type, parts.filter(n => n.type === 'type_qualifier'), operators, source, normalize, bindings, aliases);
  if (shape.operators[0]?.[0] === 'array') shape.operators[0] = ['pointer', []];
  else if (shape.operators[0]?.[0] === 'function') shape.operators.unshift(['pointer', []]);
  if (shape.operators[0]?.[0] === 'pointer' || shape.operators[0]?.[0] === 'member-pointer') {
    const qualifiers = shape.operators[0][1] as string[];
    shape.operators[0][1] = qualifiers.filter(q => q !== 'const' && q !== 'volatile' && q !== 'restrict');
  }
  return JSON.stringify([shape.base, shape.operators.length ? shape.qualifiers : [], shape.operators]);
}

interface TypeShape { base: string; qualifiers: string[]; operators: TypeOperator[] }

/** Expanding an alias is safe only when every embedded name is bound. Raw
 * template arguments or array extents cannot be transplanted into the use
 * site's scope: the same spelling there can denote a different type/value.
 */
function stableAliasTarget(type: SyntaxNode, declarator: SyntaxNode | null, bindings: CppTypeBindings,
  seen: Set<number>): boolean {
  const stableName = (node: SyntaxNode, spelling: string): boolean => {
    const binding = bindings.resolve(node, spelling);
    if (binding?.kind === 'nominal') return true;
    return binding?.kind === 'alias' && !seen.has(binding.node.id) && seen.size < 16
      && stableAliasTarget(binding.type, binding.declarator, bindings, new Set(seen).add(binding.node.id));
  };
  const name = ['class_specifier', 'struct_specifier', 'union_specifier', 'enum_specifier'].includes(type.type)
    ? type.childForFieldName('name') : type;
  if (!['primitive_type', 'sized_type_specifier'].includes(type.type)
    && (!name || !['identifier', 'type_identifier', 'qualified_identifier'].includes(name.type)
      || !stableName(name, name.text))) return false;
  const stableDeclarator = (node: SyntaxNode | null): boolean => {
    if (!node || ['identifier', 'field_identifier', 'type_identifier'].includes(node.type)) return true;
    if (node.type === 'qualified_identifier') {
      let pointer: SyntaxNode | null = node;
      while (pointer?.type === 'qualified_identifier') pointer = pointer.childForFieldName('name');
      return pointer?.type === 'pointer_type_declarator'
        && stableName(node, node.text.slice(0, pointer.startIndex - node.startIndex).replace(/::\s*$/, ''))
        && stableDeclarator(pointer);
    }
    const child = nestedDeclarator(node);
    const kind = node.type.replace(/^abstract_/, '');
    const extras = node.namedChildren.filter(n => n.id !== child?.id && n.type !== 'comment');
    if (!stableDeclarator(child)) return false;
    if (kind === 'parenthesized_declarator') return !!child && !extras.length;
    if (['pointer_declarator', 'pointer_type_declarator', 'reference_declarator'].includes(kind)) {
      return extras.every(n => n.type === 'type_qualifier');
    }
    if (kind === 'array_declarator') return extras.every(n => n.type === 'number_literal');
    if (kind !== 'function_declarator') return false;
    const parameters = node.childForFieldName('parameters');
    return !!parameters && extras.every(n => n.id === parameters.id
      || ['type_qualifier', 'ref_qualifier'].includes(n.type)
      || n.type === 'noexcept' && !n.namedChildren.length)
      && parameters.namedChildren.filter(n => n.type !== 'comment').every(p => {
        const base = p.childForFieldName('type');
        const declared = p.childForFieldName('declarator');
        return p.type === 'variadic_parameter' || !!base
          && p.namedChildren.every(n => n.id === base.id || n.id === declared?.id
            || n.type === 'type_qualifier' || n.type === 'comment')
          && stableAliasTarget(base, declared, bindings, seen);
      });
  };
  return stableDeclarator(declarator);
}

function typeShape(type: SyntaxNode | null, qualifiers: SyntaxNode[], operators: TypeOperator[], source: string,
  normalize: Normalize, bindings?: CppTypeBindings, aliases = new Set<number>()): TypeShape {
  let shape: TypeShape = {base:typeSpecifier(type, normalize), qualifiers:[], operators:[]};
  let name = type;
  if (type && ['dependent_type', 'class_specifier', 'struct_specifier', 'union_specifier', 'enum_specifier'].includes(type.type)) {
    name = type.childForFieldName('name') ?? type.namedChildren.find(n => n.type === 'qualified_identifier') ?? type;
  }
  // Alpha-normalized bindings are dependent; never resolve them as a
  // same-spelled concrete class or alias in the surrounding syntax tree.
  const binding = name && ['identifier', 'type_identifier', 'qualified_identifier'].includes(name.type)
    && normalize(name.text, name.startIndex) === tokens(name.text) ? bindings?.resolve(name, name.text) : null;
  if (binding?.kind === 'nominal') shape.base = binding.name;
  else if (binding?.kind === 'alias' && bindings && !aliases.has(binding.node.id) && aliases.size < 16
    && stableAliasTarget(binding.type, binding.declarator, bindings, new Set(aliases).add(binding.node.id))) {
    const next = new Set(aliases).add(binding.node.id);
    // Alias targets use their own declaration scope, not the template or
    // function parameter bindings at the use site.
    const aliasOperators = typeOperators(binding.declarator, source, tokens, undefined, bindings, next);
    if (aliasOperators) shape = typeShape(binding.type, binding.qualifiers, aliasOperators, source, tokens, bindings, next);
  }
  const cv = qualifiers.map(n => normalize(n.text, n.startIndex));
  const first = shape.operators[0];
  if (first?.[0] === 'pointer' || first?.[0] === 'member-pointer') first[1] = [...new Set([...(first[1] as string[]), ...cv])].sort();
  else if (first?.[0] !== 'reference') shape.qualifiers = [...new Set([...shape.qualifiers, ...cv])].sort();
  shape.operators = [...operators, ...shape.operators];
  // References introduced through aliases obey reference collapsing.
  while (shape.operators[0]?.[0] === 'reference' && shape.operators[1]?.[0] === 'reference') {
    const left = shape.operators.shift()!, right = shape.operators[0]!;
    right[1] = left[1] === '&' || right[1] === '&' ? '&' : '&&';
  }
  return shape;
}

/** Return types distinguish function templates, including SFINAE overloads.
 * Leading and trailing forms use the same type structure, without the
 * array/function adjustment or cv removal specific to parameters.
 */
function typeSpecifier(type: SyntaxNode | null, normalize: Normalize): string {
  if (!type) return '';
  if (type.type === 'dependent_type') {
    // `typename` is optional in C++20 type-only contexts, including a trailing
    // return type; it is a disambiguator, not part of the represented type.
    const name = type.namedChildren.find(n => n.type === 'qualified_identifier');
    if (name) return normalize(name.text, name.startIndex);
  }
  if (['class_specifier', 'struct_specifier', 'union_specifier', 'enum_specifier'].includes(type.type)
    && !type.childForFieldName('body')) {
    const name = type.childForFieldName('name');
    if (name) return normalize(name.text, name.startIndex);
  }
  if (['primitive_type', 'sized_type_specifier'].includes(type.type)) {
    const words = cppIdentityTokens(type.text);
    const builtin = new Set(['signed', 'unsigned', 'short', 'long', 'int', 'char', 'double']);
    if (words.length && words.every(word => builtin.has(word))) {
      const base = words.includes('char') ? 'char' : words.includes('double') ? 'double' : 'int';
      const sign = words.includes('unsigned') ? 'unsigned' : base === 'char' && words.includes('signed') ? 'signed' : '';
      const size = words.filter(word => word === 'long' || word === 'short').sort();
      return [sign, ...size, base === 'int' && size.length ? '' : base].filter(Boolean).join(' ');
    }
  }
  return normalize(type.text, type.startIndex);
}

export function cppCallableReturnType(callable: SyntaxNode, source: string, normalize: Normalize, bindings?: CppTypeBindings): string {
  const unknown = () => JSON.stringify(['unknown-return', callable.startIndex, normalize(callable.text)]);
  const trailing = callable.namedChildren.find(n => n.type === 'trailing_return_type');
  let declaration: SyntaxNode | null = trailing?.namedChildren.find(n => n.type === 'type_descriptor') ?? null;
  if (!declaration) {
    declaration = callable.parent;
    while (declaration && !['declaration', 'field_declaration', 'function_definition'].includes(declaration.type)) {
      if (['translation_unit', 'compound_statement'].includes(declaration.type)) return unknown();
      declaration = declaration.parent;
    }
  }
  if (!declaration) return unknown();
  const type = declaration.childForFieldName('type');
  const declarator = declaration.childForFieldName('declarator');
  const operators = typeOperators(declarator, source, normalize, trailing ? undefined : callable, bindings);
  const qualifiers = declaration.namedChildren.filter(n => n.type === 'type_qualifier');
  // For unsupported return declarators retain syntax instead of collapsing
  // every unknown return type into the same identity.
  if (!operators) return JSON.stringify([typeSpecifier(type, normalize), qualifiers.map(n => normalize(n.text, n.startIndex)),
    normalize(declarator?.text ?? '', declarator?.startIndex)]);
  const shape = typeShape(type, qualifiers, operators, source, normalize, bindings);
  return JSON.stringify([shape.base, shape.qualifiers, shape.operators]);
}

export function cppParameterTypes(parameters: SyntaxNode, source: string, normalize: Normalize = tokens,
  bindings?: CppTypeBindings, aliases = new Set<number>()): string[] {
  const children = parameters.namedChildren.filter(p => p.type !== 'comment');
  if (children.length === 1 && tokens(children[0]!.text) === 'void') return [];
  return children.map(p => cppParameterType(p, source, normalize, bindings, aliases));
}

export function cppTemplateParameterName(parameter: SyntaxNode): SyntaxNode | null {
  if (parameter.type === 'template_template_parameter_declaration') {
    const tail = parameter.namedChildren.find(n => n.type !== 'template_parameter_list' && n.type !== 'comment');
    return tail ? cppTemplateParameterName(tail) : null;
  }
  let name = parameter.childForFieldName('name') ?? parameter.childForFieldName('declarator')
    ?? parameter.namedChildren.find(child => child.type === 'type_identifier') ?? null;
  while (name?.type.includes('declarator')) name = nestedDeclarator(name);
  return name;
}

function bindingNormalizer(bindings: Map<string, string>): Normalize {
  return text => {
    const values = cppIdentityTokens(text);
    return values.map((value, index) => {
      // A qualified member such as foreign::T is not the template binding T.
      // Conversely T::member does start with that binding.
      const qualified = values[index - 1] === '::' || values[index - 1] === '.'
        || values[index - 1] === '>' && values[index - 2] === '-'
        || values[index - 1] === 'template' && values[index - 2] === '::';
      return qualified
        ? value : bindings.get(value) ?? value;
    }).join(' ');
  };
}

function templateParameterShape(parameter: SyntaxNode, bindings: Map<string, string>, position: string, source: string): unknown {
  const normalize = bindingNormalizer(bindings);
  if (parameter.type === 'template_template_parameter_declaration') {
    const list = parameter.childForFieldName('parameters');
    const nested = new Map(bindings);
    const parameters = list?.namedChildren.filter(n => n.type !== 'comment') ?? [];
    parameters.forEach((p, index) => {
      const name = cppTemplateParameterName(p);
      if (name) nested.set(name.text, `${position}_${index}`);
    });
    const tail = parameter.namedChildren.find(n => n.type !== 'template_parameter_list' && n.type !== 'comment');
    return ['template', parameters.map((p, index) => templateParameterShape(p, nested, `${position}_${index}`, source)),
      tail?.type.includes('variadic') ?? false];
  }
  if (['type_parameter_declaration', 'optional_type_parameter_declaration', 'variadic_type_parameter_declaration'].includes(parameter.type)) {
    return ['type', parameter.type.includes('variadic')];
  }
  return ['value', cppParameterType(parameter, source, normalize)];
}

/** Alpha-renaming uses template-list depth and parameter position, including
 * enclosing class templates. Inline and out-of-line member declarations then
 * use the same bindings in their owner, parameter types and constraints.
 */
export function cppTemplateIdentity(syntax: SyntaxNode | null, qualifiedName: string, source: string): {
  normalize: Normalize; templates: unknown[]; callableNormalizer: (parameters: SyntaxNode) => Normalize;
} {
  const declarations: SyntaxNode[] = [];
  for (let at = syntax?.parent; at && !['translation_unit', 'compound_statement'].includes(at.type); at = at.parent) {
    if (at.type === 'template_declaration') declarations.unshift(at);
  }
  const bindings = new Map<string, string>();
  const templates: unknown[] = [];
  const owner = qualifiedName.slice(0, Math.max(0, qualifiedName.lastIndexOf('::')));
  const ownerNames = new Set(cppIdentityTokens(owner));
  let depth = 0;
  declarations.forEach(declaration => {
    const parameters = declaration.childForFieldName('parameters')?.namedChildren.filter(n => n.type !== 'comment') ?? [];
    parameters.forEach((parameter, index) => {
      const name = cppTemplateParameterName(parameter);
      if (name) bindings.set(name.text, `@template_${depth}_${index}`);
    });
    // Class-template lists belong to the owner, not to the method's overload.
    const isOwner = declaration.namedChildren.some(n => ['class_specifier', 'struct_specifier', 'union_specifier'].includes(n.type))
      || parameters.some(p => { const name = cppTemplateParameterName(p); return name && ownerNames.has(name.text); });
    if (!isOwner) {
      const constraints = declaration.namedChildren.filter(n => n.type === 'requires_clause');
      templates.push([parameters.map((p, index) => templateParameterShape(p, bindings, `@template_${depth}_${index}`, source)),
        constraints.map(n => bindingNormalizer(bindings)(n.text))]);
    }
    if (parameters.length) depth++;
  });
  return {normalize:bindingNormalizer(bindings), templates, callableNormalizer: parameters => {
    const callableBindings = new Map(bindings);
    parameters.namedChildren.filter(p => p.type !== 'comment').forEach((p, index) => {
      const name = parameterName(p);
      if (name && !name.isMissing) callableBindings.set(name.text, `@argument_${index}`);
    });
    const normalizeArguments = bindingNormalizer(callableBindings);
    const normalizeTemplates = bindingNormalizer(bindings);
    // Parameters are visible in trailing return types and suffix expressions,
    // but cannot shadow a type in the leading return-type specifier.
    return (text, offset) => offset !== undefined && offset < parameters.endIndex
      ? normalizeTemplates(text) : normalizeArguments(text);
  }};
}
