import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Node } from '../types';
import { generateNodeId } from './tree-sitter-helpers';
import { cppIdentityTokens, cppParameterTypes, cppTemplateIdentity, cppTemplateParameterName } from './c-cpp-macro-types';

const writtenAnchors = new WeakMap<Node, {line:number; column:number; callable:string}>();
export const macroWrittenAnchor = (node: Node) => writtenAnchors.get(node);

const tokens = (text: string): string => cppIdentityTokens(text).join(' ');

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

function semanticQualifiedName(symbol: Node, syntax: SyntaxNode | null): string {
  let qualified = symbol.qualifiedName;
  for (let owner = syntax?.parent; owner; owner = owner.parent) {
    if (!['class_specifier','struct_specifier','union_specifier'].includes(owner.type)
      || owner.parent?.type !== 'template_declaration') continue;
    const name = owner.childForFieldName('name');
    if (name?.type !== 'type_identifier') continue;
    const parameters = owner.parent.childForFieldName('parameters')?.namedChildren ?? [];
    const names = parameters.map(cppTemplateParameterName);
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
  const {normalize, templates} = cppTemplateIdentity(syntax, qualifiedName, source);
  let callable: unknown = null;
  let parameterPosition: {row:number; column:number} | undefined;
  if (symbol.kind === 'function' || symbol.kind === 'method') {
    const declarator = syntax && callableDeclarator(syntax);
    const parameters = declarator?.childForFieldName('parameters');
    if (declarator && parameters) {
      parameterPosition = parameters.startPosition;
      const types = cppParameterTypes(parameters, source, normalize);
      const qualifiers = declarator.namedChildren.filter(child => child.startIndex >= parameters.endIndex
        && ['type_qualifier','ref_qualifier','requires_clause'].includes(child.type))
        .map(child => normalize(source.slice(child.startIndex, child.endIndex)));
      // The recovery parser can mask trailing const while retaining its offsets.
      if (!qualifiers.includes('const') && /^\s+const\b/.test(source.slice(declarator.endIndex, syntax!.endIndex))) qualifiers.push('const');
      callable = [types, qualifiers, templates];
    } else {
      // Without a complete declarator, keep separate evidence rather than
      // merging overloads on a shared/truncated display-signature prefix.
      callable = ['unparsed', tokens(syntax?.text ?? symbol.signature ?? ''), symbol.startColumn];
    }
  }
  const key = JSON.stringify([normalize(qualifiedName), callable]);
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
