/** Controlled fixed-path facade. A connection is never the lifetime of a project.
 * Every call owns admission; complete asynchronous calls pin one graph identity.
 * Only this module owns/retire cached native graph objects. No bare db escapes.
 */
import { randomUUID } from 'node:crypto';
import { Participant, lease } from './protocol';
import { FixedPathWriterLock, BorrowedFixedPathWriterLock } from './writer-lock';
import type { GenerationWriterLock } from '../generation-store';
import { DatabaseConnection, DatabaseOpenError } from '../../db';
import { Mutex } from '../../utils';

export interface ManagedGraphHandle { close(): void; }
export interface FixedPathProject { project: string; dataDirectory: string; }
export interface FixedPathPin<T> { graph: T; identity: string; release(): void; }

export class FixedPathController<T extends ManagedGraphHandle> {
  private static failedControllers = new Set<object>();
  private readonly readers: Participant;
  private readonly writeMutex = new Mutex();
  private reservation?: FixedPathWriterLock;
  private failedNative = new Set<DatabaseConnection>();
  private readonly writers: Participant;
  private readonly identities = new WeakMap<object, string>();
  private closed = false;
  private pending = new Set<Promise<unknown>>();
  private pins = 0;
  private backgroundWriters = 0;
  private backgroundReleaseError: unknown;
  private backgroundWaiters: Array<() => void> = [];
  private pinWaiters: Array<() => void> = [];

  constructor(private readonly project: FixedPathProject, factory: (file: string, readOnly: boolean,
    backgroundLease: () => { release(): void }, writeLock?: GenerationWriterLock) => T) {
    const open = (readOnly: boolean) => (file: string): T => {
      try {
      if (!readOnly && !this.reservation) throw new Error('Writable open requires mutation reservation');
      const graph = factory(file, readOnly, () => {
        // Caller already owns an operation/connection lease. Independent native
        // workers retain this shared lease through their actual OS thread exit.
        const held = lease(this.readers.p.connections);
        if (!held) throw new Error('Fixed-path worker connection admission lost');
        if (!readOnly) this.backgroundWriters++;
        let released = false;
        return { release: () => {
          if (released) return;
          held.close(); released = true;
          if (!readOnly && --this.backgroundWriters === 0) {
            try { this.releaseFinishedReservation(); }
            catch (error) { this.backgroundReleaseError = error; throw error; }
            finally { this.backgroundWaiters.splice(0).forEach(resolve => resolve()); }
          }
        } };
      }, readOnly ? undefined : new BorrowedFixedPathWriterLock(project.dataDirectory, this.reservation!));
      this.identities.set(graph, randomUUID());
      return graph;
      } catch (error) {
        if (error instanceof DatabaseOpenError && error.connection.isOpen()) {
          this.failedNative.add(error.connection); FixedPathController.failedControllers.add(this);
        }
        throw error;
      }
    };
    this.readers = new Participant(project, open(true));
    try { this.writers = new Participant(project, open(false)); }
    catch (error) { this.readers.close(); throw error; }
  }

  readSync<R>(action: (graph: T) => R): R {
    this.assertOpen();
    return this.readers.requestSync(action) as R;
  }
  read<R>(action: (graph: T) => Promise<R> | R): Promise<R> {
    this.assertOpen();
    return this.track(this.readers.request(action) as Promise<R>);
  }
  private reserveMutation(): void {
    if (this.reservation) throw new Error('Previous writer still owns mutation admission');
    const reserved = new FixedPathWriterLock(this.project.dataDirectory);
    reserved.acquire(); this.reservation = reserved;
  }
  private releaseFinishedReservation(): void {
    if (!this.writers.handle && this.backgroundWriters === 0 &&
        ![...this.failedNative].some(connection => connection.isOpen())) {
      this.reservation?.release(); this.reservation = undefined;
      this.backgroundReleaseError = undefined;
      FixedPathController.failedControllers.delete(this);
    }
  }
  private finishWriter(): void {
    try { if (this.writers.active === 0) this.writers.closeHandle(); }
    catch (error) { FixedPathController.failedControllers.add(this); throw error; }
    finally {
      // Native close failure must retain BOTH connection and mutation ownership.
      this.releaseFinishedReservation();
      if (this.backgroundWriters) FixedPathController.failedControllers.add(this);
    }
  }
  writeSync<R>(action: (graph: T) => R): R {
    this.assertOpen();
    if (this.writeMutex.isLocked()) throw new Error('Cannot mutate while an asynchronous writer is active');
    this.reserveMutation();
    try { return this.writers.requestSync(action, true) as R; }
    finally { this.finishWriter(); }
  }
  write<R>(action: (graph: T) => Promise<R> | R): Promise<R> {
    this.assertOpen();
    return this.track(this.writeMutex.withLock(async () => {
      this.reserveMutation();
      try { return await this.writers.write(action) as R; }
      finally { this.finishWriter(); }
    }));
  }
  /** Synchronous acquisition only, never synchronous waiting for local async work.
   * Participant's bounded drain cancellation handles that self-lock case.
   */
  pin(): FixedPathPin<T> {
    return this.readSync(graph => {
      this.readers.active++;
      this.pins++;
      let released = false;
      return { graph, identity: this.identities.get(graph)!, release: () => {
        if (released) return;
        released = true;
        try { this.readers.finish(); } finally {
          this.pins--;
          if (this.pins === 0) this.pinWaiters.splice(0).forEach(resolve => resolve());
        }
      } };
    });
  }
  currentRevision(): number { return this.readers.readSnapshot((db: any) => db.prepare('SELECT revision FROM state WHERE id=1').get().revision) as number; }
  currentIdentity(): string { return this.readSync(graph => this.identities.get(graph)!); }
  async whenIdle(): Promise<void> {
    while (this.pending.size || this.pins || this.backgroundWriters) {
      if (this.pending.size) await Promise.allSettled([...this.pending]);
      if (this.pins) await new Promise<void>(resolve => this.pinWaiters.push(resolve));
      if (this.backgroundWriters) await new Promise<void>(resolve => this.backgroundWaiters.push(resolve));
    }
    if (this.backgroundReleaseError) throw this.backgroundReleaseError;
  }
  get isWriting(): boolean { return this.writers.active > 0; }
  close(): void {
    if (this.closed) return;
    if (this.pending.size || this.backgroundWriters || this.writeMutex.isLocked() || this.readers.active || this.writers.active) throw new Error('Cannot close fixed-path facade with active operations; await whenIdle()');
    const errors: unknown[] = [];
    try { this.writers.close(); } catch (error) { errors.push(error); }
    for (const connection of this.failedNative) {
      try { connection.close(); } catch (error) { errors.push(error); }
      if (!connection.isOpen()) this.failedNative.delete(connection);
    }
    if (!this.writers.handle && this.failedNative.size === 0) {
      try { this.reservation?.release(); this.reservation = undefined; this.backgroundReleaseError = undefined; } catch (error) { errors.push(error); }
    }
    try { this.readers.close(); } catch (error) { errors.push(error); }
    if (errors.length) {
      FixedPathController.failedControllers.add(this);
      throw new AggregateError(errors, 'Fixed-path close failed; unresolved native handles retain ownership');
    }
    FixedPathController.failedControllers.delete(this);
    this.closed = true;
  }

  private assertOpen(): void { if (this.closed) throw new Error('CodeGraph is closed'); }
  private track<R>(work: Promise<R>): Promise<R> {
    this.pending.add(work);
    void work.then(() => this.pending.delete(work), () => this.pending.delete(work));
    return work;
  }
}
