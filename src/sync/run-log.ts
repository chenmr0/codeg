import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import type { FileHandle } from 'fs/promises';

export const SYNC_RUN_LOG_MAX_BYTES = 1024 * 1024;
export const SYNC_RUN_LOG_WARNING = '[sync-log] Anonymous run logging disabled for this sync.';
const MAX_SNAPSHOT_BYTES = 32 * 1024;
const MAX_QUEUE_BYTES = 128 * 1024;
const MAX_QUEUE_ENTRIES = 8;
const MAX_BATCH_BYTES = 64 * 1024;
const HEARTBEAT_MS = 60_000;
const FINISH_TIMEOUT_MS = 2_000;
const KEEP_COMPLETED = 10;
const PREFIX = 'codegraph-sync-v1-';
const COMPLETED_NAME = /^codegraph-sync-v1-\d{13}-[a-f0-9]{32}\.log$/;
const PHASES = ['preflight', 'extraction', 'prepare', 'changedRefs', 'resurrectedRefs',
  'failedRetry', 'fallback', 'synthesis', 'chained', 'maintenance', 'finalize', 'cleanup'] as const;
const GROUPS = ['stages', 'extraction', 'store', 'worker', 'wal', 'refs'] as const;
const STORE_KEYS = ['canonicalMs', 'hashMs', 'lookupMs', 'retryStateMs', 'snapshotMs',
  'deleteMs', 'nodesMs', 'edgesMs', 'refsMs', 'rewireMs', 'fileMs', 'retainMs',
  'filesCount', 'skippedCount', 'nodeRowsCount', 'edgeRowsCount', 'refRowsCount',
  'retainedFilesCount', 'failedCount'];
const WAL_METRICS = ['backpressure', 'backpressureWait', 'drain', 'drainPauseWait',
  'drainInflightWait', 'fold', 'park', 'parkedInflightWait', 'parkedPassive',
  'parkedTruncate', 'parkedRetry', 'advisoryCheck', 'advisoryPassive'];
const REF_DETAILS = ['LoadRefsMs', 'FileNamesLoadMs', 'FileNamesSetMs', 'SymbolNamesLoadMs',
  'SymbolNamesSetMs', 'NameProbeMs', 'NormalizeMs', 'MatchMs', 'EdgeBuildMs',
  'EdgeInsertMs', 'ResolvedCleanupMs', 'FailedCleanupMs', 'JournalDeferredMs'];
const upperFirst = (value: string): string => value[0]!.toUpperCase() + value.slice(1);
const WAL_KEYS = WAL_METRICS.flatMap(metric => ['Calls', 'Ms', 'Errors'].map(suffix => metric + suffix));
const CHECKPOINT_KEYS = ['ParentTotalMs', 'ParentImportMs', 'ParentConstructMs',
  'WorkerStartupMs', 'WorkerEntryMs', 'WorkerModuleLoadMs', 'WorkerOpenMs',
  'WorkerBusyTimeoutMs', 'WorkerPragmaMs', 'WorkerCloseMs', 'WorkerTotalMs',
  'ParentDeliveryMs', 'ParentTerminateMs', 'ParentUnattributedMs', 'InlinePragmaMs',
  'LifecycleCalls', 'WorkerCalls', 'WorkerMessagesCount', 'InlineCalls',
  'ImportErrorsCount', 'ConstructErrorsCount', 'TimeoutResultsCount', 'WorkerErrorsCount',
  'EarlyExitResultsCount', 'TerminateErrorsCount', 'ClockUnavailableResultsCount',
  'WorkerModuleLoadErrorsCount', 'WorkerOpenErrorsCount', 'WorkerBusyTimeoutErrorsCount',
  'WorkerPragmaErrorsCount', 'WorkerCloseErrorsCount', 'InlinePragmaErrorsCount',
  'ResultRowsCount', 'NullResultsCount', 'BusyResultsCount', 'FullResultsCount',
  'PartialResultsCount', 'UnavailableResultsCount', 'BusyValueMaxCount', 'BusyValueLastCount',
  'LogFramesSamplesCount', 'LogFramesMaxCount', 'LogFramesLastCount',
  'CheckpointedFramesSamplesCount', 'CheckpointedFramesMaxCount', 'CheckpointedFramesLastCount'];
/** Explicit keys, rather than a generic identifier regex: even keys cannot carry source names. */
const KEYS: Record<typeof GROUPS[number], ReadonlySet<string>> = {
  stages: new Set([...PHASES.map(phase => phase + 'Ms'), 'logFlushMs']),
  extraction: new Set(['runtimeSetupMs', 'reconcileMs', 'frameworkMs', 'macroMs', 'setupMs',
    'readMs', 'parseWallMs', 'storeWallMs', 'cleanupMs', 'finishMs']),
  store: new Set([...STORE_KEYS, 'mainThreadWallMs', 'fallbackIndexFileMs']),
  worker: new Set([...STORE_KEYS, 'rpcWallMs', 'requestCount', 'requestWallMs',
    'failedRequestCount', 'transactionWallMs', 'bodyMs', 'boundaryMs']),
  wal: new Set([...WAL_KEYS,
    ...['advisoryPassive', 'parkedPassive', 'parkedTruncate'].flatMap(prefix => CHECKPOINT_KEYS.map(key => prefix + key)),
    ...PHASES.flatMap(phase => WAL_KEYS
    .filter(key => /^(backpressure|fold|drain)/.test(key)).map(key => phase + upperFirst(key)))]),
  refs: new Set(PHASES.flatMap(phase => ['PlanReadMs', 'FilterMs', 'ResolveMs', 'AfterWriteMs',
    'YieldMs', 'YieldCount', 'YieldMaxMs', 'YieldLe1Count', 'YieldGt1Le10Count',
    'YieldGt10Le50Count', 'YieldGt50Le250Count', 'YieldGt250Count',
    'WallMs', 'UnattributedMs', 'BatchCount', 'RefCount',
    ...REF_DETAILS.map(key => 'Detail' + key)].map(key => phase + key))),
};
const safeInteger = (value: string): boolean => /^(0|[1-9]\d{0,15})$/.test(value) && Number.isSafeInteger(Number(value));

/** This boundary deliberately rejects arbitrary text, unknown keys and non-finite numbers. */
function serializeSnapshot(lines: readonly string[]): string | undefined {
  if (!Array.isArray(lines) || lines.length !== GROUPS.length + 2 ||
      lines.some(line => typeof line !== 'string' || line.length > MAX_SNAPSHOT_BYTES)) return undefined;
  if (!lines[0]!.startsWith('[sync-summary] ')) return undefined;
  const header = new Map<string, string>();
  for (const field of lines[0]!.slice('[sync-summary] '.length).split(' ')) {
    const match = /^([A-Za-z][A-Za-z0-9]*)=([A-Za-z0-9]+)$/.exec(field);
    if (!match || header.has(match[1]!)) return undefined;
    const [, key, value] = match;
    if (key === 'schema' ? value !== '1' : key === 'outcome' ?
      !['running', 'success', 'incomplete', 'error', 'lockUnavailable'].includes(value!) :
      key === 'wallMs' || key === 'phaseElapsedMs' ? !safeInteger(value!) :
      key === 'phase' ? !(PHASES as readonly string[]).includes(value!) : true) return undefined;
    header.set(key!, value!);
  }
  if (!header.has('schema') || !header.has('outcome') || !header.has('wallMs') ||
      (header.has('phaseElapsedMs') && !header.has('phase'))) return undefined;
  for (let i = 0; i < GROUPS.length; i++) {
    const group = GROUPS[i]!;
    const prefix = `[sync-summary] ${group} `;
    const line = lines[i + 1]!;
    if (!line.startsWith(prefix)) return undefined;
    const fields = line.slice(prefix.length);
    const seen = new Set<string>();
    for (const field of fields === '' ? [] : fields.split(' ')) {
      const match = /^([A-Za-z][A-Za-z0-9]*)=(\d+)$/.exec(field);
      if (!match || !KEYS[group].has(match[1]!) || seen.has(match[1]!) || !safeInteger(match[2]!)) return undefined;
      seen.add(match[1]!);
    }
  }
  if (lines[lines.length - 1] !== '[sync-summary] units=millisecondsExceptCounts relation=inclusiveNestedNotAdditive') return undefined;
  const text = lines.join('\n') + '\n';
  return Buffer.byteLength(text) <= MAX_SNAPSHOT_BYTES - 256 ? text : undefined;
}

export interface SyncRunLogOptions {
  /** Returns only the fixed anonymous summary schema, never raw diagnostic output. */
  snapshot: () => readonly string[];
  /** Called at most once, with no error, filename, environment or source detail. */
  warning?: () => void;
}

type Packet = { text: string; bytes: number };
type Identity = { dev: number; ino: number };
const sameFile = (a: Identity, b: Identity): boolean => a.dev === b.dev && a.ino === b.ino;

/**
 * Best-effort, bounded local diagnostics. No SQL, fsync, synchronous filesystem
 * calls or per-file timers. The owner creates this only after taking its lock.
 *
 * Portable lstat/identity checks reject symlinks and ordinary replacement, but
 * cannot protect against an adversary renaming parent directories between OS
 * calls. Exclusive/no-follow creation never overwrites an existing file.
 */
export class SyncRunLog {
  private readonly directory: string = '';
  private readonly token: string = '';
  private readonly activePath: string = '';
  private directoryIdentity?: Identity;
  private fileIdentity?: Identity;
  private handle?: FileHandle;
  private initialized = false;
  private disabled = false;
  private warned = false;
  private finishing = false;
  private completed = false;
  private readonly queue: Packet[] = [];
  private queuedBytes = 0;
  private acceptedBytes = 0;
  private droppedSnapshots = 0;
  private finalPacket?: Packet;
  private drainPromise?: Promise<void>;
  private finishPromise?: Promise<void>;
  private readonly done: Promise<void>;
  private resolveDone!: () => void;
  private timer?: ReturnType<typeof setInterval>;

  constructor(dbPath: string, private readonly options: SyncRunLogOptions) {
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
    try {
      this.directory = path.join(path.dirname(dbPath), 'logs');
      this.token = randomBytes(16).toString('hex');
      this.activePath = path.join(this.directory, `${PREFIX}${Date.now()}-${this.token}.active`);
      this.timer = setInterval(() => this.event('heartbeat'), HEARTBEAT_MS);
      this.timer.unref?.();
    } catch { this.disable(); }
  }

  event(event: 'start' | 'stage' | 'heartbeat'): void {
    if (this.disabled || this.finishing || this.completed) return;
    if (event !== 'start' && event !== 'stage' && event !== 'heartbeat') return;
    // Backpressure drops before calling the collector, keeping both CPU and
    // serialized retained memory bounded while filesystem operations stall.
    if (this.queue.length >= MAX_QUEUE_ENTRIES || this.queuedBytes >= MAX_QUEUE_BYTES ||
        this.acceptedBytes >= SYNC_RUN_LOG_MAX_BYTES - MAX_SNAPSHOT_BYTES) {
      this.drop();
      return;
    }
    const packet = this.capture(event);
    if (!packet) return;
    if (this.queuedBytes + packet.bytes > MAX_QUEUE_BYTES ||
        this.acceptedBytes + packet.bytes > SYNC_RUN_LOG_MAX_BYTES - MAX_SNAPSHOT_BYTES) {
      this.drop();
      return;
    }
    this.queue.push(packet);
    this.queuedBytes += packet.bytes;
    this.acceptedBytes += packet.bytes;
    this.kick();
  }

  /**
   * Includes the final snapshot and closes/rotates on success. Idempotent and
   * never rejects. At 2s, detach safely and disable; an already-issued OS call
   * cannot be cancelled portably and may keep the Node process alive longer.
   * The single writer owns and closes its descriptor after that call settles.
   */
  finish(): Promise<void> {
    if (this.finishPromise) return this.finishPromise;
    this.finishing = true;
    this.stopTimer();
    if (!this.disabled) {
      this.finalPacket = this.capture('end');
      if (this.finalPacket) this.acceptedBytes += this.finalPacket.bytes;
      this.kick();
    }
    this.finishPromise = this.waitForFinish();
    return this.finishPromise;
  }

  private capture(event: 'start' | 'stage' | 'heartbeat' | 'end'): Packet | undefined {
    try {
      const snapshot = serializeSnapshot(this.options.snapshot());
      if (snapshot === undefined) { this.disable(); return undefined; }
      const text = `[sync-log] schema=1 event=${event} droppedSnapshots=${this.droppedSnapshots}\n` + snapshot;
      return { text, bytes: Buffer.byteLength(text) };
    } catch { this.disable(); return undefined; }
  }

  private drop(): void {
    this.droppedSnapshots = Math.min(Number.MAX_SAFE_INTEGER, this.droppedSnapshots + 1);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private disable(): void {
    this.disabled = true;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.finalPacket = undefined;
    this.stopTimer();
    if (!this.warned) {
      this.warned = true;
      try {
        if (this.options.warning) this.options.warning();
        else console.warn(SYNC_RUN_LOG_WARNING);
      } catch { /* Diagnostics must never mask the original sync result. */ }
    }
    this.resolveDone();
  }

  private async waitForFinish(): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.done, new Promise<void>(resolve => {
        timeout = setTimeout(() => { this.disable(); resolve(); }, FINISH_TIMEOUT_MS);
      })]);
    } finally { if (timeout) clearTimeout(timeout); }
  }

  private kick(): void {
    if (this.drainPromise || this.disabled || this.completed) return;
    this.drainPromise = this.drain().catch(() => this.disable()).finally(() => {
      this.drainPromise = undefined;
      if (!this.disabled && !this.completed && (this.queue.length || this.finishing)) this.kick();
    });
  }

  private async initialize(): Promise<void> {
    try { await fs.promises.mkdir(this.directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (this.disabled) return;
    const directory = await fs.promises.lstat(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('unsafe-log-directory');
    this.directoryIdentity = directory;
    if (this.disabled) return;
    const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT |
      fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
    this.handle = await fs.promises.open(this.activePath, flags, 0o600);
    if (this.disabled) return;
    this.fileIdentity = await this.handle.stat();
    if (!this.disabled) await this.checkDirectory();
    this.initialized = true;
  }

  private async checkDirectory(): Promise<void> {
    const stat = await fs.promises.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !this.directoryIdentity ||
        !sameFile(stat, this.directoryIdentity)) throw new Error('changed-log-directory');
  }

  private async closeHandle(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    if (handle) await handle.close();
  }

  private async drain(): Promise<void> {
    try {
      if (!this.initialized) await this.initialize();
      while (!this.disabled) {
        const batch: string[] = [];
        let bytes = 0;
        while (this.queue.length && bytes + this.queue[0]!.bytes <= MAX_BATCH_BYTES) {
          const packet = this.queue.shift()!;
          this.queuedBytes -= packet.bytes;
          batch.push(packet.text);
          bytes += packet.bytes;
        }
        if (!this.queue.length && this.finalPacket && bytes + this.finalPacket.bytes <= MAX_BATCH_BYTES) {
          batch.push(this.finalPacket.text);
          this.finalPacket = undefined;
        }
        if (batch.length) {
          await this.handle!.writeFile(batch.join(''), 'utf8');
          continue;
        }
        if (this.finishing) {
          await this.closeHandle();
          if (!this.disabled) await this.completeFile();
          this.completed = !this.disabled;
          this.resolveDone();
        }
        break;
      }
    } catch { this.disable(); }
    finally {
      if (this.disabled) {
        try { await this.closeHandle(); } catch { this.disable(); }
      }
    }
  }

  private async completeFile(): Promise<void> {
    await this.checkDirectory();
    if (this.disabled) return;
    const active = await fs.promises.lstat(this.activePath);
    if (!active.isFile() || active.isSymbolicLink() || !this.fileIdentity ||
        !sameFile(active, this.fileIdentity)) throw new Error('changed-active-log');
    if (this.disabled) return;
    const completedPath = path.join(this.directory, `${PREFIX}${Date.now()}-${this.token}.log`);
    // Unlike rename(), link() fails if the destination already exists.
    await fs.promises.link(this.activePath, completedPath);
    if (this.disabled) return;
    await this.checkDirectory();
    if (this.disabled) return;
    const beforeUnlink = await fs.promises.lstat(this.activePath);
    if (!beforeUnlink.isFile() || !sameFile(beforeUnlink, this.fileIdentity)) throw new Error('changed-active-log');
    if (this.disabled) return;
    await fs.promises.unlink(this.activePath);
    if (!this.disabled) await this.rotate();
  }

  private async hasFeatureHeader(filename: string, identity: Identity): Promise<boolean> {
    // A coincidentally matching user filename is not sufficient ownership.
    // Read at most 128 bytes; never follow a symlink or trust a changed inode.
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) |
      (fs.constants.O_NONBLOCK ?? 0);
    let handle: FileHandle | undefined;
    try {
      handle = await fs.promises.open(filename, flags);
      if (this.disabled) return false;
      const current = await handle.stat();
      if (!current.isFile() || !sameFile(current, identity) || this.disabled) return false;
      const buffer = Buffer.alloc(128);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0]!;
      const match = /^\[sync-log\] schema=1 event=(start|stage|heartbeat|end) droppedSnapshots=(\d+)$/.exec(firstLine);
      return !!match && bytesRead > Buffer.byteLength(firstLine) && safeInteger(match[2]!);
    } catch (error) {
      if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
      throw error;
    } finally { if (handle) await handle.close(); }
  }

  private async rotate(): Promise<void> {
    await this.checkDirectory();
    if (this.disabled) return;
    // Stream unrelated names rather than retaining an unbounded directory list.
    const directory = await fs.promises.opendir(this.directory);
    const newest: Array<{ name: string; identity: Identity }> = [];
    for await (const entry of directory) {
      if (this.disabled) break;
      if (!COMPLETED_NAME.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) continue;
      await this.checkDirectory();
      if (this.disabled) break;
      const filename = path.join(this.directory, entry.name);
      let stat: fs.Stats;
      try { stat = await fs.promises.lstat(filename); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink() || this.disabled ||
          !await this.hasFeatureHeader(filename, stat)) continue;
      if (this.disabled) break;
      newest.push({ name: entry.name, identity: stat });
      newest.sort((a, b) => b.name.localeCompare(a.name));
      if (newest.length <= KEEP_COMPLETED) continue;
      const oldest = newest.pop()!;
      await this.checkDirectory();
      if (this.disabled) break;
      const oldPath = path.join(this.directory, oldest.name);
      try {
        const current = await fs.promises.lstat(oldPath);
        if (current.isFile() && !current.isSymbolicLink() && sameFile(current, oldest.identity) && !this.disabled) {
          await fs.promises.unlink(oldPath);
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
}
