import * as path from 'node:path';
import { GenerationWriterLock } from '../generation-store';
import { lease, paths } from './protocol';
/** Serializes normal mutators using an OS lease. A process crash releases the
 * lock; a stale PID/text file is not used as evidence or left as a permanent blocker. */
export class FixedPathWriterLock extends GenerationWriterLock {
  private held: { close(): void } | null = null;
  private readonly file: string;
  constructor(dataDirectory: string) {
    super(dataDirectory);
    this.file = paths({ project: path.dirname(dataDirectory), dataDirectory }).mutations;
  }
  override acquire(): void {
    if (this.held) throw new Error('Writer lock is not reentrant');
    this.held = lease(this.file, true);
    if (!this.held) throw new Error('CodeGraph database is locked by another cooperating writer');
  }
  override assertHeld(): void { if (!this.held) throw new Error('Fixed-path writer ownership was lost'); }
  override release(): void { if (this.held) { this.held.close(); this.held = null; } }
}

/** The controller already owns the OS lock before writable native open. Inner
 * indexing code borrows its proof without acquiring a second exclusive lock. */
export class BorrowedFixedPathWriterLock extends GenerationWriterLock {
  private borrowed = false;
  constructor(dataDirectory: string, private readonly ownerLock: FixedPathWriterLock) { super(dataDirectory); }
  override acquire(): void {
    if (this.borrowed) throw new Error('Writer lock is not reentrant');
    this.ownerLock.assertHeld(); this.borrowed = true;
  }
  override assertHeld(): void { if (!this.borrowed) throw new Error('Writer lock was not borrowed'); this.ownerLock.assertHeld(); }
  override release(): void { this.borrowed = false; }
}
