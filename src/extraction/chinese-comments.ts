import type { Node as SyntaxNode, Point } from 'web-tree-sitter';
import type { ChineseComment, Language, Node } from '../types';

const commentTypes = ['comment', 'line_comment', 'block_comment', 'documentation_comment', 'doc_comment',
  'multiline_comment', 'single_line_comment'];
const han = /\p{Script=Han}/u;
const key = (p: Point) => p.row + ':' + p.column;
const order = (a: Point, b: Point) => a.row - b.row || a.column - b.column;

interface CommentBlock {
  start: Point;
  end: Point;
  nextDeclaration?: Point;
  standalone: boolean;
  text: string;
}
interface CommentSyntax {
  blocks: CommentBlock[];
  docstrings: { declaration: Point; line: number; text: string }[];
}

/** Only a standalone string constant is a Python docstring. Parentheses and
 * implicit concatenation are allowed; tuples, byte strings and f-strings aren't. */
function pythonDocstring(def: SyntaxNode): { line: number; text: string } | undefined {
  const first = def.childForFieldName('body')?.namedChildren.find(n => n.type !== 'comment');
  if (first?.type !== 'expression_statement' || first.childCount !== 1) return;
  let expr = first.firstNamedChild;
  while (expr?.type === 'parenthesized_expression') expr = expr.namedChildren.find(n => n.type !== 'comment') ?? null;
  if (!expr) return;
  const parts = expr.type === 'concatenated_string' ? expr.namedChildren.filter(n => n.type !== 'comment') : [expr];
  if (!parts.length || !parts.every(n => n.type === 'string' && n.firstNamedChild?.type === 'string_start' &&
      n.lastNamedChild?.type === 'string_end' && /^[ru]?['"]/i.test(n.text))) return;
  const text = parts.map(n => n.text.slice(n.firstNamedChild!.text.length, -n.lastNamedChild!.text.length)).join('');
  return han.test(text) ? { line: parts[0]!.startPosition.row + 1, text } : undefined;
}

/** Keep only source data, never native nodes: C++ recovery may release the
 * primary tree before it finishes resolving the final callable ranges and IDs. */
export function readCommentSyntax(root: SyntaxNode, source: string, language: Language): CommentSyntax {
  const blocks: CommentBlock[] = [], docstrings: CommentSyntax['docstrings'] = [];
  if (language === 'python') {
    for (const def of root.descendantsOfType('function_definition')) {
      const doc = pythonDocstring(def);
      if (doc) docstrings.push({ declaration: def.startPosition, ...doc });
    }
  }
  const comments = root.descendantsOfType(commentTypes);
  for (let i = 0; i < comments.length; i++) {
    const first = comments[i]!;
    let last = first;
    const lineStart = source.lastIndexOf('\n', first.startIndex - 1) + 1;
    const standalone = !source.slice(lineStart, first.startIndex).trim();
    while (standalone && i + 1 < comments.length && comments[i + 1]!.startPosition.row === last.endPosition.row + 1 &&
        !source.slice(last.endIndex, comments[i + 1]!.startIndex).trim()) last = comments[++i]!;
    const text = source.slice(first.startIndex, last.endIndex);
    let sibling = last.nextNamedSibling;
    if (sibling?.type === 'export_statement') sibling = sibling.childForFieldName('declaration');
    if (sibling?.type === 'decorated_definition') sibling = sibling.childForFieldName('definition');
    const hasHan = han.test(text);
    if (hasHan || sibling) blocks.push({ start: first.startPosition, end: last.endPosition,
      nextDeclaration: sibling?.startPosition, standalone, text: hasHan ? text : '' });
  }
  return { blocks, docstrings };
}

export function collectChineseComments(syntax: CommentSyntax, nodes: Node[]): ChineseComment[] {
  const funcs = nodes.filter(n => n.kind === 'function' || n.kind === 'method')
    .map(node => ({ node, start: { row: node.startLine - 1, column: node.startColumn },
      end: { row: node.endLine - 1, column: node.endColumn } }))
    .sort((a, b) => order(a.start, b.start) || order(b.end, a.end));
  if (!funcs.length) return [];
  const heads = new Map<string, ChineseComment>();
  const byStart = new Map<string, Node>();
  for (const { node, start } of funcs) {
    byStart.set(key(start), node);
    if (node.docstring && han.test(node.docstring)) {
      heads.set(node.id, { nodeId: node.id, field: 'head', line: node.startLine, text: node.docstring });
    }
  }
  const body: ChineseComment[] = [];
  const active: typeof funcs = [];
  let next = 0;
  for (const { start, end, nextDeclaration, standalone, text } of syntax.blocks) {
    const head = nextDeclaration && byStart.get(key(nextDeclaration));
    if (head && standalone && text) {
      heads.set(head.id, { nodeId: head.id, field: 'head', line: start.row + 1, text });
      continue;
    }
    // A generic docstring may include a trailing note about an earlier statement.
    if (head && heads.get(head.id)?.line === head.startLine) heads.delete(head.id);
    if (!text) continue;
    while (next < funcs.length && order(funcs[next]!.start, start) <= 0) {
      const f = funcs[next++]!;
      while (active.length && order(active[active.length - 1]!.end, f.start) <= 0) active.pop();
      active.push(f);
    }
    while (active.length && order(active[active.length - 1]!.end, end) < 0) active.pop();
    const owner = active[active.length - 1]?.node;
    if (owner && !owner.isDeclaration) body.push({ nodeId: owner.id, field: 'body', line: start.row + 1, text });
  }
  const result = [...heads.values(), ...body];
  for (const { declaration, line, text } of syntax.docstrings) {
    const node = byStart.get(key(declaration));
    if (node) result.push({ nodeId: node.id, field: 'head', line, text });
  }
  return result;
}
