/**
 * Tree-sitter Shared Helpers
 *
 * Utility functions used by the core TreeSitterExtractor and per-language extractors.
 * Extracted to a leaf module to avoid circular imports between tree-sitter.ts and languages/.
 */

import { Node as SyntaxNode } from 'web-tree-sitter';
import * as crypto from 'crypto';
import { NodeKind } from '../types';

/**
 * Generate a unique node ID
 *
 * Uses a 32-character (128-bit) hash to avoid collisions when indexing
 * large codebases with many files containing similar symbols.
 */
export function generateNodeId(
  filePath: string,
  kind: NodeKind,
  name: string,
  line: number,
  salt?: string
): string {
  // `salt` is an optional identity discriminator (e.g. the enclosing enum node
  // id for X-macro-synthesized enum members). When present it is folded into
  // the hash so two distinct owners reusing the same call line/name produce
  // distinct node ids, WITHOUT changing the node's display `name`.
  const hash = crypto
    .createHash('sha256')
    .update(
      salt
        ? `${filePath}:${kind}:${name}:${line}:${salt}`
        : `${filePath}:${kind}:${name}:${line}`
    )
    .digest('hex')
    .substring(0, 32);
  return `${kind}:${hash}`;
}

/**
 * Extract text from a syntax node
 */
export function getNodeText(node: SyntaxNode, source: string): string {
  return source.substring(node.startIndex, node.endIndex);
}

/**
 * Find a child node by field name
 */
export function getChildByField(node: SyntaxNode, fieldName: string): SyntaxNode | null {
  return node.childForFieldName(fieldName);
}

// Declaration wrappers place leading comments beside the wrapper (upstream #780).
const DOCSTRING_WRAPPER_TYPES = new Set([
  'export_statement', // JS/TS: export class/function/const ...
  'decorated_definition', // Python: @decorator over def/class
  'lexical_declaration', // JS/TS: const/let x = () => {}
  'variable_declaration', // JS/TS: var x = ...
  'variable_declarator', // JS/TS: the `x = () => {}` inside the declaration
  'ambient_declaration', // TS: declare ...
]);

/**
 * Get the docstring/comment preceding a node
 */
export function getPrecedingDocstring(node: SyntaxNode, source: string): string | undefined {
  let anchor = node;
  while (anchor.parent && DOCSTRING_WRAPPER_TYPES.has(anchor.parent.type)) {
    anchor = anchor.parent;
  }
  let sibling = anchor.previousNamedSibling;
  const comments: string[] = [];

  while (sibling) {
    if (
      sibling.type === 'comment' ||
      sibling.type === 'line_comment' ||
      sibling.type === 'block_comment' ||
      sibling.type === 'documentation_comment'
    ) {
      comments.unshift(getNodeText(sibling, source));
      sibling = sibling.previousNamedSibling;
    } else {
      break;
    }
  }

  if (comments.length === 0) return undefined;

  // Clean up comment markers
  return comments
    .map((c) =>
      c
        .replace(/^\/\*\*?|\*\/$/g, '')
        .replace(/^\/\/\s?/gm, '')
        .replace(/^\s*\*\s?/gm, '')
        .trim()
    )
    .join('\n')
    .trim();
}
