import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Edge, Node } from '../types';
import { getParser, loadGrammarsForLanguages } from '../extraction/grammars';
import { parseWithinBudget } from '../extraction/parse-budget';
import { ExploreSourceSnapshots, type ExploreSourceGraph } from '../../mcp/explore-source';

interface SourceGraph extends ExploreSourceGraph {
  getVerifiedSource?(file: string): string | undefined;
}

interface SignatureTypes {
  name: string;
  anchors: number[];
  types: Map<number, TypeSite>;
}

interface TypeSite {
  name: string;
  spelling: string;
  line: number;
  column: number;
  endColumn: number;
  qualifierLine: number;
  qualifierColumn: number;
}

function typeSpelling(node: SyntaxNode): string {
  if (node.type === 'template_type') {
    const name = node.childForFieldName('name');
    return name ? typeSpelling(name) : node.text.split('<', 1)[0]!.trim();
  }
  const scope = node.childForFieldName('scope');
  const name = node.childForFieldName('name');
  if (scope && name) return `${typeSpelling(scope)}::${typeSpelling(name)}`;
  return node.text.replace(/\s+/g, '');
}

function typeSite(node: SyntaxNode): TypeSite {
  let qualified = node;
  for (;;) {
    const parent = qualified.parent;
    if (!parent || parent.childForFieldName('name')?.id !== qualified.id
      || !['qualified_identifier', 'qualified_type_identifier', 'scoped_type_identifier', 'template_type'].includes(parent.type)) break;
    qualified = parent;
  }
  return {
    name: node.text, spelling: typeSpelling(qualified),
    line: node.startPosition.row + 1, column: node.startPosition.column, endColumn: node.endPosition.column,
    qualifierLine: qualified.startPosition.row + 1, qualifierColumn: qualified.startPosition.column,
  };
}

function matchesTypeSite(site: TypeSite, target: Node, edge: Pick<Edge, 'line' | 'column'>): boolean {
  if (site.name !== target.name) return false;
  const qualifiedName = target.qualifiedName.replace(/\s+/g, '').replace(/^::/, '');
  // Native C/C++ references can originate only in a body even when the same
  // type is also a genuine signature dependency. An explicit global spelling
  // proves that identity directly; relative/unqualified spellings still need
  // the signature-site edge because aliases and shadowing are unresolved here.
  if (site.spelling.startsWith('::')) return qualifiedName === site.spelling.slice(2);
  if (edge.line === undefined || edge.column === undefined) return false;
  const atToken = edge.line === site.line && edge.column >= site.column && edge.column < site.endColumn;
  const atQualifiedType = edge.line === site.qualifierLine && edge.column === site.qualifierColumn;
  if (!atToken && !atQualifiedType) return false;
  if (!site.spelling.includes('::')) return true;
  const spelling = site.spelling.replace(/^::/, '');
  return qualifiedName === spelling || (!site.spelling.startsWith('::') && qualifiedName.endsWith(`::${spelling}`));
}

interface FileTypes {
  lineOffsets: number[];
  signatures: SignatureTypes[];
}

/** Read only syntactic type positions, never parameter defaults or a body. */
function collectTypeNames(node: SyntaxNode | null, into: Map<number, TypeSite>): void {
  if (!node || node.hasError) return;
  if (node.type === 'type_identifier') {
    into.set(node.startIndex, typeSite(node));
    return;
  }
  // Template non-type arguments and decltype/noexcept expressions can contain
  // calls or local declarations. They are not parameter/return type evidence.
  if (node.type.endsWith('_expression') || node.type === 'decltype'
    || node.type === 'lambda_expression' || node.type === 'compound_statement') return;
  for (const child of node.namedChildren) collectTypeNames(child, into);
}

function collectDeclaratorTypes(node: SyntaxNode | null, into: Map<number, TypeSite>): void {
  if (!node) return;
  if (node.type === 'parameter_list') {
    for (const parameter of node.namedChildren) {
      collectTypeNames(parameter.childForFieldName('type'), into);
      // Function-pointer parameters have nested parameter lists in their
      // declarator. Defaults are separate fields and deliberately not visited.
      collectDeclaratorTypes(parameter.childForFieldName('declarator'), into);
    }
    return;
  }
  if (node.type === 'trailing_return_type') {
    collectTypeNames(node, into);
    return;
  }
  for (const child of node.namedChildren) {
    if (child.type === 'parameter_list' || child.type === 'trailing_return_type'
      || child.type.includes('declarator')) collectDeclaratorTypes(child, into);
  }
}

function callableName(node: SyntaxNode | null): { name: string; anchor: number } | null {
  if (!node) return null;
  const nested = node.childForFieldName('declarator') ?? node.childForFieldName('name');
  if (nested) return callableName(nested);
  if (['identifier', 'field_identifier', 'type_identifier', 'destructor_name', 'operator_name'].includes(node.type)) {
    return { name: node.text.replace(/\s+/g, ''), anchor: node.startIndex };
  }
  return null;
}

function signatureOwner(node: SyntaxNode): SyntaxNode | null {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (['function_definition', 'declaration', 'field_declaration'].includes(parent.type)) return parent;
    // A callback parameter is part of the enclosing signature, not a new
    // callable that happens to have the queried name.
    if (parent.type === 'parameter_declaration' || parent.type === 'optional_parameter_declaration'
      || parent.type === 'compound_statement') return null;
  }
  return null;
}

/**
 * Query-local C/C++ change-surface evidence. Native references include types
 * used inside bodies, unlike upstream's much sparser references. Reconstruct
 * the parameter/return type evidence from hash-verified source instead of
 * trusting that edge kind, its coarse line number, or a truncated signature.
 * Failed/ambiguous recovery leaves the graph relation intact, but does not
 * promote the target file as a signature dependency.
 */
export class CppSignatureTypeEvidence {
  private readonly sources: ExploreSourceSnapshots;
  private readonly files = new Map<string, Promise<FileTypes | null>>();

  constructor(private readonly graph: SourceGraph) {
    this.sources = new ExploreSourceSnapshots(graph);
  }

  async contains(callable: Node, target: Node, edge: Pick<Edge, 'line' | 'column'>): Promise<boolean> {
    if (callable.language !== 'c' && callable.language !== 'cpp') return true;
    const key = `${callable.language}\0${callable.filePath}`;
    let promise = this.files.get(key);
    if (!promise) {
      promise = this.readTypes(callable);
      this.files.set(key, promise);
    }
    const file = await promise;
    const lineOffset = file?.lineOffsets[callable.startLine - 1];
    if (!file || lineOffset === undefined || callable.startColumn < 0) return false;
    const anchor = lineOffset + callable.startColumn;
    const matching = file.signatures.filter(signature =>
      signature.name === callable.name.replace(/\s+/g, '') && signature.anchors.includes(anchor));
    // Multiple declarator wrappers for one source callable are merged by the
    // owner during collection. More than one owner means uncertain identity.
    return matching.length === 1 && [...matching[0]!.types.values()].some(site => matchesTypeSite(site, target, edge));
  }

  private async readTypes(callable: Node): Promise<FileTypes | null> {
    try {
      const source = this.graph.getVerifiedSource
        ? this.graph.getVerifiedSource(callable.filePath)
        : this.sources.get(callable.filePath).content;
      if (source === undefined) return null;
      await loadGrammarsForLanguages([callable.language]);
      const parser = getParser(callable.language);
      if (!parser) return null;
      const tree = parseWithinBudget(parser, source);
      if (!tree) return null;
      try {
        const signatures = new Map<string, SignatureTypes>();
        for (const declarator of tree.rootNode.descendantsOfType('function_declarator')) {
          const owner = signatureOwner(declarator);
          const name = callableName(declarator.childForFieldName('declarator'));
          if (!owner || !name) continue;
          const id = `${owner.startIndex}:${name.anchor}:${name.name}`;
          const signature = signatures.get(id) ?? { name: name.name, anchors: [], types: new Map<number, TypeSite>() };
          signature.anchors.push(owner.startIndex, declarator.startIndex, name.anchor);
          collectTypeNames(owner.childForFieldName('type'), signature.types);
          collectDeclaratorTypes(declarator, signature.types);
          signatures.set(id, signature);
        }
        const lineOffsets = [0];
        for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineOffsets.push(i + 1);
        return { lineOffsets, signatures: [...signatures.values()] };
      } finally {
        tree.delete();
      }
    } catch {
      return null;
    }
  }
}
