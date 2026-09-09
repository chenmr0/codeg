import type { ExtractionResult } from '../types';

/** Leave headroom for parser workers, SQLite, and temporary serialization. */
export function resolveParseBufferBudget(availableMemoryBytes: number, heapHeadroomBytes: number): number {
  const mib = 1024 * 1024;
  return Math.max(32 * mib, Math.min(512 * mib,
    Math.floor(availableMemoryBytes / 16), Math.floor(heapHeadroomBytes / 4)));
}

/** Conservative buffer admission estimate, not a measurement of V8/WASM heap. */
export function estimateExtractionBytes(content: string | null,
  result: Pick<ExtractionResult, 'nodes' | 'edges' | 'unresolvedReferences'> | null): number {
  let bytes = 128 + (content?.length ?? 0) * 2;
  if (!result) return bytes;
  for (const node of result.nodes) {
    bytes += 256 + 2 * ((node.id?.length ?? 0) + (node.name?.length ?? 0) + (node.qualifiedName?.length ?? 0) +
      (node.filePath?.length ?? 0) + (node.signature?.length ?? 0) + (node.docstring?.length ?? 0));
  }
  for (const edge of result.edges) {
    bytes += 192 + 2 * ((edge.source?.length ?? 0) + (edge.target?.length ?? 0));
  }
  for (const ref of result.unresolvedReferences) {
    bytes += 256 + 2 * ((ref.fromNodeId?.length ?? 0) + (ref.referenceName?.length ?? 0) + (ref.filePath?.length ?? 0));
  }
  return bytes;
}
