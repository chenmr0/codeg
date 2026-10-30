/** Controlled fixed-path facade. A connection is never the lifetime of a project.
 * Every call owns admission; complete asynchronous calls pin one graph identity.
 * Only this module owns/retire cached native graph objects. No bare db escapes.
 */
import { randomUUID } from 'node:crypto';
import { Participant, lease } from './protocol';

export interface ManagedGraphHandle { close(): void; }
export interface FixedPathProject { project: string; dataDirectory: string; }
export interface FixedPathPin<T> { graph: T; identity: string; release(): void; }

export class FixedPathController<T extends ManagedGraphHandle> {
  private readonly readers: Participant;
  private readonly writers: Participant;
  private readonly identities = new WeakMap<object, string>();
  private closed = false;
  private pending = new Set<Promise<unknown>>();
  private pins = 0;
  private pinWaiters: Array<() => void> = [];

  constructor(project: FixedPathProject, factory: (file: string, readOnly: boolean,
    backgroundLease: () => { release(): void }) => T) {
    const open = (readOnly: boolean) => (file: string): T => {
      const graph = factory(file, readOnly, () => {
        // Caller already owns an operation/connection lease. Independent native
        // workers retain this shared lease through their actual OS thread exit.
        const held = lease(this.readers.p.connections);
        if (!held) throw new Error('Fixed-path worker connection admission lost');
        return { release: () => held.close() };
      });
      this.identities.set(graph, randomUUID());
      return graph;
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
  writeSync<R>(action: (graph: T) => R): R {
    this.assertOpen();
    try { return this.writers.requestSync(action, true) as R; }
    finally { if (this.writers.active === 0) this.writers.closeHandle(); }
  }
  write<R>(action: (graph: T) => Promise<R> | R): Promise<R> {
    this.assertOpen();
    return this.track((this.writers.write(action) as Promise<R>).finally(() => {
      if (this.writers.active === 0) this.writers.closeHandle();
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
    while (this.pending.size || this.pins) {
      if (this.pending.size) await Promise.allSettled([...this.pending]);
      if (this.pins) await new Promise<void>(resolve => this.pinWaiters.push(resolve));
    }
  }
  get isWriting(): boolean { return this.writers.active > 0; }
  close(): void {
    if (this.closed) return;
    if (this.readers.active || this.writers.active) throw new Error('Cannot close fixed-path facade with active operations; await whenIdle()');
    this.writers.close();
    this.readers.close();
    this.closed = true;
  }
  private assertOpen(): void { if (this.closed) throw new Error('CodeGraph is closed'); }
  private track<R>(work: Promise<R>): Promise<R> {
    this.pending.add(work);
    void work.then(() => this.pending.delete(work), () => this.pending.delete(work));
    return work;
  }
}
