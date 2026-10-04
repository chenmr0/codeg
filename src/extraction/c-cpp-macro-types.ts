import type { Node as SyntaxNode } from 'web-tree-sitter';

// Preserve literals and token boundaries; whitespace/comments are not identity.
export function cppIdentityTokens(text: string): string[] {
  return (text.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|[A-Za-z_$][\w$]*|\d+|::|&&|\.\.\.|[^\s]/g) ?? [])
    .filter(token => !token.startsWith('/*') && !token.startsWith('//'));
}

type Normalize = (text: string) => string;
const tokens: Normalize = text => cppIdentityTokens(text).join(' ');
type TypeOperator = [kind: string, ...details: unknown[]];

function nestedDeclarator(node: SyntaxNode): SyntaxNode | null {
  return node.childForFieldName('declarator')
    ?? node.namedChildren.find(child => child.type.includes('declarator')
      || child.type === 'identifier' || child.type === 'field_identifier') ?? null;
}

/** Operators in order from the declared name outwards. Parentheses affect
 * that order, but are not themselves type constructors: int *a[3] is an array
 * of pointers, whereas int (*a)[3] is a pointer to an array.
 */
function typeOperators(node: SyntaxNode | null, source: string, normalize: Normalize): TypeOperator[] | null {
  if (!node || ['identifier', 'field_identifier'].includes(node.type)) return [];
  const child = nestedDeclarator(node);
  const operators = typeOperators(child, source, normalize);
  if (!operators) return null;
  const kind = node.type.replace(/^abstract_/, '');
  if (kind === 'parenthesized_declarator') return operators;
  const extras = node.namedChildren.filter(n => n.id !== child?.id && n.type !== 'comment');
  if (kind === 'pointer_declarator') {
    operators.push(['pointer', extras.map(n => normalize(n.text)).sort()]);
  } else if (kind === 'reference_declarator') {
    operators.push(['reference', node.children.some(n => n.type === '&&') ? '&&' : '&']);
  } else if (kind === 'array_declarator') {
    operators.push(['array', extras.map(n => normalize(n.text))]);
  } else if (kind === 'function_declarator') {
    const parameters = node.childForFieldName('parameters');
    if (!parameters) return null;
    operators.push(['function', cppParameterTypes(parameters, source, normalize),
      extras.filter(n => n.id !== parameters.id).map(n => normalize(n.text))]);
  } else if (kind === 'variadic_declarator') {
    operators.push(['pack']);
  } else {
    return null; // Unknown syntax must retain its spelling, not lose evidence.
  }
  return operators;
}

/** C/C++ function parameter identity after array/function adjustment and
 * removal of top-level cv. Apply this recursively to callback parameters too.
 */
export function cppParameterType(parameter: SyntaxNode, source: string, normalize: Normalize = tokens): string {
  if (!parameter.type.endsWith('parameter_declaration')) return normalize(parameter.text);
  const declarator = parameter.childForFieldName('declarator');
  const operators = typeOperators(declarator, source, normalize);
  if (!operators) return normalize(parameter.text);
  const equals = parameter.children.find(n => n.type === '=');
  const parts = parameter.namedChildren.filter(n => n.id !== declarator?.id && n.type !== 'comment'
    && (!equals || n.startIndex < equals.startIndex));
  const qualifiers = parts.filter(n => n.type === 'type_qualifier').map(n => normalize(n.text)).sort();
  const base = parts.filter(n => n.type !== 'type_qualifier').map(n => normalize(source.slice(n.startIndex, n.endIndex))).join(' ');
  if (operators[0]?.[0] === 'array') operators[0] = ['pointer', []];
  else if (operators[0]?.[0] === 'function') operators.unshift(['pointer', []]);
  if (operators[0]?.[0] === 'pointer') {
    const qualifiers = operators[0][1] as string[];
    operators[0] = ['pointer', qualifiers.filter(q => q !== 'const' && q !== 'volatile' && q !== 'restrict')];
  }
  return JSON.stringify([base, operators.length ? qualifiers : [], operators]);
}

export function cppParameterTypes(parameters: SyntaxNode, source: string, normalize: Normalize = tokens): string[] {
  const children = parameters.namedChildren.filter(p => p.type !== 'comment');
  if (children.length === 1 && tokens(children[0]!.text) === 'void') return [];
  return children.map(p => cppParameterType(p, source, normalize));
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
  normalize: Normalize; templates: unknown[];
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
  return {normalize:bindingNormalizer(bindings), templates};
}
