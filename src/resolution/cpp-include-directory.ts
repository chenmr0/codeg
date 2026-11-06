import * as path from 'node:path';

export interface CppIncludeChoices {
  files: string[];
  complete: boolean;
}

export function normalizeCppIndexedPath(file: string): string {
  return path.posix.normalize(file.replace(/\\/g, '/'));
}

function lastSegment(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1);
}

const MAX_RETAINED_BYTES = 8 * 1024 * 1024;

/** A file-list snapshot owned by one binding-evidence cache epoch.
 * Buckets retain the original file order and normalized duplicates. Only
 * candidate paths are normalized; include spellings keep their existing meaning.
 */
export class CppIncludeDirectory {
  private buckets: Map<string, string[]> | null | undefined;

  constructor(
    private readonly getAllFiles: () => readonly string[],
    private readonly maxRetainedBytes = MAX_RETAINED_BYTES,
  ) {}

  find(includeName: string, maxMatches: number): CppIncludeChoices {
    let files: readonly string[] | undefined;
    if (this.buckets === undefined) {
      files = this.getAllFiles();
      this.buckets = this.build(files);
    }

    if (this.buckets !== null) {
      return this.select(this.buckets.get(lastSegment(includeName)) ?? [], includeName, maxMatches);
    }

    // The retention cap must not truncate the candidate universe. Reuse the
    // first fetched list on overflow; subsequent misses use the prior full scan.
    return this.select(this.normalized(files ?? this.getAllFiles()), includeName, maxMatches);
  }

  private build(files: readonly string[]): Map<string, string[]> | null {
    const buckets = new Map<string, string[]>();
    let retainedBytes = 0;
    for (const file of files) {
      const normalized = normalizeCppIndexedPath(file);
      const tail = lastSegment(normalized);
      let bucket = buckets.get(tail);
      // Conservative UTF-16 strings, array entries and map/bucket overhead.
      // This bounds retained data, not the existing getAllFiles() allocation.
      const charge = 64 + normalized.length * 2 + (bucket ? 0 : 128 + tail.length * 2);
      if (charge > this.maxRetainedBytes - retainedBytes) return null;
      retainedBytes += charge;
      if (!bucket) {
        bucket = [];
        buckets.set(tail, bucket);
      }
      bucket.push(normalized);
    }
    return buckets;
  }

  private *normalized(files: readonly string[]): Iterable<string> {
    for (const file of files) yield normalizeCppIndexedPath(file);
  }

  private select(files: Iterable<string>, includeName: string, maxMatches: number): CppIncludeChoices {
    const result: CppIncludeChoices = { files: [], complete: true };
    for (const candidate of files) {
      if (candidate !== includeName && !candidate.endsWith(`/${includeName}`)) continue;
      if (result.files.length >= maxMatches) {
        result.complete = false;
        break;
      }
      result.files.push(candidate);
    }
    return result;
  }
}
