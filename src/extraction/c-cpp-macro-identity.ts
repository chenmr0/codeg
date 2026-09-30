import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Node } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

const writtenAnchors = new WeakMap<Node, {line:number; column:number; callable:string}>();
export const macroWrittenAnchor = (node: Node) => writtenAnchors.get(node);

// Keep token boundaries and literal values; comments and spacing are not identity.
function tokens(text: string): string {
  return (text.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|[A-Za-z_$][\w$]*|\d+|::|&&|\.\.\.|[^\s]/g) ?? [])
    .filter(token => !token.startsWith('/*') && !token.startsWith('//')).join(' ');
}

function callableDeclarator(node: SyntaxNode): SyntaxNode | null {
  const queue = [node];
  while (queue.length) {
    const current = queue.shift()!;
    if (current.type === 'function_declarator' || current.type === 'abstract_function_declarator') return current;
    for (const child of current.namedChildren) {
      if (!['parameter_list', 'template_argument_list', 'trailing_return_type', 'compound_statement', 'field_declaration_list'].includes(child.type)) queue.push(child);
    }
  }
  return null;
}

/** Remove names/defaults using the declarator tree, including callback and array
 * parameters. Display signatures may be truncated, so they cannot be ID keys.
 */
function parameterType(parameter: SyntaxNode, source: string): string {
  const omitted: Array<{start: number; end: number}> = [];
  const visit = (node: SyntaxNode): void => {
    if (node.type.endsWith('parameter_declaration')) {
      const equals = node.children.find(child => child.type === '=');
      if (equals) omitted.push({start:equals.startIndex, end:node.endIndex});
      let declarator = node.childForFieldName('declarator');
      let lastDeclarator: SyntaxNode | null = null;
      while (declarator) {
        if (declarator.type === 'identifier' || declarator.type === 'field_identifier') {
          omitted.push({start:declarator.startIndex, end:declarator.endIndex});
          break;
        }
        lastDeclarator = declarator;
        declarator = declarator.childForFieldName('declarator')
          ?? declarator.namedChildren.find(child => child.type.includes('declarator') || child.type === 'identifier') ?? null;
      }
      // Top-level cv on a by-value parameter is not an overload distinction.
      // Keep cv on the pointed/referenced type (const T* and T* are distinct).
      const qualifiers = !lastDeclarator ? node.namedChildren
        : lastDeclarator.type === 'pointer_declarator' ? lastDeclarator.namedChildren : [];
      for (const qualifier of qualifiers) if (qualifier.type === 'type_qualifier') {
        omitted.push({start:qualifier.startIndex, end:qualifier.endIndex});
      }
    }
    for (const child of node.namedChildren) {
      if (child.type !== 'default_value') visit(child);
    }
  };
  visit(parameter);
  let text = '', at = parameter.startIndex;
  for (const range of omitted.sort((a,b) => a.start - b.start)) {
    if (range.start < at) continue;
    text += source.slice(at, range.start) + ' ';
    at = range.end;
  }
  return tokens(text + source.slice(at, parameter.endIndex));
}

function templateParameterName(parameter: SyntaxNode): SyntaxNode | null {
  return parameter.childForFieldName('name') ?? parameter.childForFieldName('declarator')
    ?? parameter.namedChildren.find(child => child.type === 'type_identifier') ?? null;
}

function semanticQualifiedName(symbol: Node, syntax: SyntaxNode | null): string {
  let qualified = symbol.qualifiedName;
  for (let owner = syntax?.parent; owner; owner = owner.parent) {
    if (!['class_specifier','struct_specifier','union_specifier'].includes(owner.type)
      || owner.parent?.type !== 'template_declaration') continue;
    const name = owner.childForFieldName('name');
    if (name?.type !== 'type_identifier') continue;
    const parameters = owner.parent.childForFieldName('parameters')?.namedChildren ?? [];
    const names = parameters.map(templateParameterName);
    if (!names.length || names.some(n => !n)) continue;
    const start = qualified.lastIndexOf(name.text+'::');
    if (start < 0) continue;
    qualified = qualified.slice(0,start) + name.text+'<'+names.map(n=>n!.text).join(',')+'>'
      + qualified.slice(start+name.text.length);
  }
  return qualified;
}

export function macroSemanticId(symbol: Node, syntax: SyntaxNode | null, source: string): string {
  if (symbol.kind === 'file' || symbol.kind === 'macro' || symbol.kind === 'import') return symbol.id;
  const qualifiedName = semanticQualifiedName(symbol, syntax);
  let callable: unknown = null;
  let parameterPosition: {row:number; column:number} | undefined;
  if (symbol.kind === 'function' || symbol.kind === 'method') {
    const declarator = syntax && callableDeclarator(syntax);
    const parameters = declarator?.childForFieldName('parameters');
    if (declarator && parameters) {
      parameterPosition = parameters.startPosition;
      const types = parameters.namedChildren.filter(p => p.type !== 'comment').map(p => parameterType(p, source));
      const qualifiers = declarator.namedChildren.filter(child => child.startIndex >= parameters.endIndex
        && ['type_qualifier','ref_qualifier','requires_clause'].includes(child.type))
        .map(child => tokens(source.slice(child.startIndex, child.endIndex)));
      // The recovery parser can mask trailing const while retaining its offsets.
      if (!qualifiers.includes('const') && /^\s+const\b/.test(source.slice(declarator.endIndex, syntax!.endIndex))) qualifiers.push('const');
      const templates: string[] = [];
      let parent = syntax!.parent;
      while (parent && !['field_declaration_list','compound_statement','translation_unit'].includes(parent.type)) {
        if (parent.type === 'template_declaration') {
          const list = parent.childForFieldName('parameters');
          for (const parameter of list?.namedChildren ?? []) {
            const name = templateParameterName(parameter);
            // A class template's parameters on an out-of-line member definition
            // belong to its owner, not to a new function-template overload.
            const ownerEnd = qualifiedName.lastIndexOf('::');
            const owner = ownerEnd < 0 ? '' : qualifiedName.slice(0, ownerEnd);
            const ownerNames: string[] = owner.match(/[A-Za-z_$][\w$]*/g) ?? [];
            if (name && ownerNames.includes(name.text)) continue;
            templates.push(tokens(parameter.text));
          }
        }
        parent = parent.parent;
      }
      callable = [types.length === 1 && types[0] === 'void' ? [] : types, qualifiers, templates];
    } else {
      // Without a complete declarator, keep separate evidence rather than
      // merging overloads on a shared/truncated display-signature prefix.
      callable = ['unparsed', tokens(syntax?.text ?? symbol.signature ?? ''), symbol.startColumn];
    }
  }
  const key = JSON.stringify([tokens(qualifiedName), callable]);
  if (parameterPosition) writtenAnchors.set(symbol, {
    line:parameterPosition.row+1, column:parameterPosition.column, callable:JSON.stringify(callable),
  });
  return generateNodeId(symbol.filePath, symbol.kind, symbol.name, symbol.startLine, `macro:${key}`);
}

/** Called only after matching semantic IDs (owner, parameters and qualifiers). */
export function preferMacroDefinition(left: Node, right: Node): Node {
  const preferred = !left.isDeclaration && right.isDeclaration ? left : right;
  const other = preferred === left ? right : left;
  const merged = {
    ...preferred,
    ...(left.isStatic || right.isStatic ? {isStatic:true} : {}),
    ...(left.isAbstract || right.isAbstract ? {isAbstract:true} : {}),
    visibility: preferred.visibility ?? other.visibility,
    docstring: preferred.docstring ?? other.docstring,
  };
  const anchor = writtenAnchors.get(preferred);
  if (anchor) writtenAnchors.set(merged, anchor);
  return merged;
}

/** All auxiliary parses use semantic IDs before emitting containment edges.
 * Preserve legacy IDs for unambiguous groups; split every colliding identity
 * deterministically, including any source-written symbol on an invocation line.
 */
export function macroFinalIds(nodes: Node[], primary: Map<Node, string>): Map<string, string> {
  const groups = new Map<string, Set<string>>();
  const add = (node: Node, semanticId: string): void => {
    const base = generateNodeId(node.filePath, node.kind, node.name, node.startLine);
    const group = groups.get(base) ?? new Set<string>();
    group.add(semanticId);
    groups.set(base, group);
  };
  for (const node of nodes) if (node.kind !== 'file') add(node, node.id);
  for (const [node, semanticId] of primary) add(node, semanticId);
  const ids = new Map<string,string>();
  for (const [base, group] of groups) for (const id of group) ids.set(id, group.size === 1 ? base : id);
  return ids;
}
