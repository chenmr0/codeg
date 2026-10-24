import type CodeGraph from '../index';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import * as path from 'path';
import { validatePathWithinRoot } from '../utils';

export interface ExploreSourceSnapshot {
  /** Normalized project-relative path when the request is within the root. */
  readonly path: string;
  readonly status: 'fresh' | 'changed' | 'missing' | 'unverified';
  /** Only verified, indexed bytes are exposed for line-based slicing. */
  readonly content?: string;
  readonly fingerprint?: string;
  readonly reason?: string;
}

/**
 * One read-only source snapshot per exploration. Semantic recovery, target
 * lookup and rendering share these exact bytes, rather than verifying one
 * read and subsequently slicing a different read at old indexed line numbers.
 * A new exploration creates a new instance; no cross-query freshness cache.
 */
export class ExploreSourceSnapshots {
  private snapshots = new Map<string, ExploreSourceSnapshot>();

  constructor(private cg: CodeGraph) {}

  get(file: string): ExploreSourceSnapshot {
    let relative = file;
    try {
      const root = this.cg.getProjectRoot();
      relative = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
      const cached = this.snapshots.get(relative);
      if (cached) return cached;
      const absolute = validatePathWithinRoot(root, file);
      if (!absolute) return this.store(relative, 'unverified', 'source path is outside the project or cannot be safely resolved');

      // Hash the same UTF-8 string as extraction.hashContent; a stat match is
      // not sufficient (same-size edits can retain a timestamp).
      const content = readFileSync(absolute, 'utf8');
      const tracked = this.cg.getFile(relative);
      if (!tracked) return this.store(relative, 'unverified', 'indexed file metadata is missing');
      // Unknown hash formats (including size-limit stamps) do not establish
      // that indexed line ranges describe the bytes read from disk.
      if (!/^[a-f0-9]{64}$/i.test(tracked.contentHash)) {
        return this.store(relative, 'unverified', 'indexed content fingerprint is unavailable or unsupported');
      }
      const fingerprint = createHash('sha256').update(content).digest('hex');
      if (fingerprint !== tracked.contentHash.toLowerCase()) {
        return this.store(relative, 'changed', 'source content changed since indexing', fingerprint);
      }
      const snapshot: ExploreSourceSnapshot = Object.freeze({ path: relative, status: 'fresh', content, fingerprint });
      this.snapshots.set(relative, snapshot);
      return snapshot;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return this.store(relative, code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unverified',
        code === 'ENOENT' || code === 'ENOTDIR' ? 'source file is missing' : 'source or indexed metadata could not be read');
    }
  }

  private store(file: string, status: ExploreSourceSnapshot['status'], reason: string, fingerprint?: string): ExploreSourceSnapshot {
    const snapshot: ExploreSourceSnapshot = Object.freeze({ path: file, status, reason, ...(fingerprint ? { fingerprint } : {}) });
    this.snapshots.set(file, snapshot);
    return snapshot;
  }
}
