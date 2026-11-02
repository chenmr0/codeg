/** Local coordination for replacing one portable database. Graph facts live in
 * codegraph.db; these files are never part of a distributed index snapshot.
 * Only cooperating processes are fenced. External imports require all processes
 * and SQLite maintenance threads to have exited. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

interface Statement {
  get(...args: unknown[]): any;
  run(...args: unknown[]): unknown;
}
interface Sqlite {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}
function open(file: string, readOnly = false): Sqlite {
  const { DatabaseSync } = require("node:sqlite");
  const db: Sqlite = new DatabaseSync(file, { readOnly });
  db.exec("PRAGMA busy_timeout=0");
  return db;
}
export class PortableBusyError extends Error {
  readonly code = "PORTABLE_BUSY";
  constructor(
    message = "Portable database coordination is busy; retry the operation",
  ) {
    super(message);
    this.name = "PortableBusyError";
  }
}
export interface PortableLease {
  release(): void;
}
export interface PortableCandidate {
  id: string;
  path: string;
  backup: string;
  baselineRevision: number;
}
export interface PortableSnapshot {
  mode: "idle" | "draining";
  revision: number;
}
interface Journal extends PortableCandidate {
  phase: "building" | "prepared" | "replacing" | "committed";
  oldHash?: string;
  newHash?: string;
}
export interface PortablePublishOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  beforeDrain?: () => void | Promise<void>;
  hook?: (phase: string) => void;
}
function busy(error: unknown): boolean {
  return /locked|busy/i.test(String(error));
}
function regular(file: string, optional = false): boolean {
  try {
    if (!fs.lstatSync(file).isFile())
      throw new Error(`Expected a regular file: ${file}`);
    return true;
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT")
      return false;
    throw error;
  }
}
function flushDirectory(dir: string): void {
  if (process.platform === "win32") return; // No unsupported Windows durability claim.
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function flush(file: string): void {
  const fd = fs.openSync(file, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function noSidecars(file: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (regular(file + suffix, true))
      throw new Error(
        `SQLite sidecar must be closed/checkpointed before replacement: ${file + suffix}`,
      );
  }
}
function digest(file: string): string | null {
  if (!regular(file, true)) return null;
  const hash = createHash("sha256"),
    buffer = Buffer.allocUnsafe(1024 * 1024),
    fd = fs.openSync(file, "r");
  try {
    let size: number;
    while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, size));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}
function validate(file: string): void {
  regular(file);
  const db = open(file, true);
  try {
    if (db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok")
      throw new Error("Database integrity check failed");
  } finally {
    db.close();
  }
}
function seal(file: string, check = true): void {
  regular(file);
  const db = open(file);
  try {
    if (db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy > 0)
      throw new PortableBusyError("SQLite checkpoint is blocked");
    db.exec("PRAGMA journal_mode=DELETE");
    if (check && db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok")
      throw new Error("Candidate integrity check failed");
  } finally {
    db.close();
  }
  noSidecars(file);
  flush(file);
}
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class PortableCoordinator {
  readonly dataDirectory: string;
  readonly active: string;
  readonly runtime: string;
  private readonly gate: string;
  private readonly writer: string;
  private readonly readers: string;
  private writerHeld = false;
  private initialStage?: { directory: string; file: string; revision: number; valid: boolean };
  private freshActiveRevision?: number;
  private initialCandidates = new WeakSet<PortableCandidate>();

  constructor(dataDirectory: string) {
    fs.mkdirSync(dataDirectory, { recursive: true });
    this.dataDirectory = fs.realpathSync(dataDirectory);
    this.active = path.join(this.dataDirectory, "codegraph.db");
    const runtimeRoot = path.join(this.dataDirectory, ".runtime");
    for (const dir of [runtimeRoot, path.join(runtimeRoot, "portable")]) {
      try {
        fs.mkdirSync(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (
        !fs.lstatSync(dir).isDirectory() ||
        fs.lstatSync(dir).isSymbolicLink()
      )
        throw new Error(`Unsafe coordination directory: ${dir}`);
    }
    this.runtime = path.join(runtimeRoot, "portable");
    this.gate = path.join(this.runtime, "gate.sqlite");
    this.writer = path.join(this.runtime, "writer.sqlite");
    this.readers = path.join(this.runtime, "readers.sqlite");
    this.initialize();
  }
  private schema(db: Sqlite, table: "state" | "lease"): boolean {
    const foreign = db
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name<>?",
      )
      .get(table);
    if (foreign?.n !== 0)
      throw new Error("Unknown coordination schema; evidence retained");
    if (
      !db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table)
    )
      return false;
    const columns = db
      .prepare(`SELECT count(*) AS n FROM pragma_table_info('${table}')`)
      .get()?.n;
    const expected = table === "state" ? 4 : 1;
    const primaryKey = db
      .prepare(
        `SELECT count(*) AS n FROM pragma_table_info('${table}') WHERE name='id' AND upper(type)='INTEGER' AND pk=1`,
      )
      .get()?.n;
    if (columns !== expected || primaryKey !== 1)
      throw new Error("Invalid coordination schema; evidence retained");
    // Preparing these statements verifies names before any mutation. Unknown
    // rows are not bootstrap debris and must never be reset to an idle state.
    db.prepare(
      table === "state"
        ? "SELECT id,mode,revision,journal FROM state"
        : "SELECT id FROM lease",
    );
    if (
      db
        .prepare(`SELECT count(*) AS n FROM ${table} WHERE id<>1 OR id IS NULL`)
        .get()?.n !== 0
    )
      throw new Error("Unexpected coordination rows; evidence retained");
    return true;
  }
  private complete(db: Sqlite): boolean {
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 0 && version !== 1)
      throw new Error("Unsupported coordination version; evidence retained");
    if (!this.schema(db, "state")) {
      if (version === 1)
        throw new Error(
          "Committed coordination state is missing; evidence retained",
        );
      return false;
    }
    const row = db
      .prepare("SELECT mode,revision,journal FROM state WHERE id=1")
      .get();
    if (!row) {
      if (db.prepare("PRAGMA user_version").get()?.user_version === 1)
        throw new Error(
          "Committed coordination singleton is missing; evidence retained",
        );
      return false;
    }
    if (
      !["idle", "draining"].includes(row.mode) ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 0 ||
      (row.journal !== null && typeof row.journal !== "string")
    )
      throw new Error("Invalid portable coordination state");
    return true;
  }
  private initialize(): void {
    regular(this.gate, true);
    const gate = open(this.gate);
    try {
      gate.exec("PRAGMA busy_timeout=50");
      if (
        !this.complete(gate) ||
        gate.prepare("PRAGMA user_version").get()?.user_version === 0
      ) {
        // The gate's exclusive transaction is the bootstrap owner. Its singleton
        // is the completion marker and commits ONLY after both lease databases
        // have committed their schemas and rows. File length is never readiness.
        gate.exec("PRAGMA synchronous=FULL; BEGIN EXCLUSIVE");
        if (!this.complete(gate)) {
          for (const file of [this.writer, this.readers]) {
            regular(file, true);
            const db = open(file);
            try {
              this.schema(db, "lease");
              db.exec(
                "PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE",
              );
              db.exec(
                "CREATE TABLE IF NOT EXISTS lease(id INTEGER PRIMARY KEY); INSERT OR IGNORE INTO lease VALUES(1); COMMIT",
              );
            } finally {
              db.close();
            }
          }
          gate.exec(
            "CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL, revision INTEGER NOT NULL, journal TEXT); INSERT OR IGNORE INTO state VALUES(1,'idle',0,NULL); PRAGMA user_version=1",
          );
        }
        gate.exec("PRAGMA user_version=1");
        gate.exec("COMMIT");
      }
      if (!regular(this.writer, true) || !regular(this.readers, true))
        throw new Error(
          "Existing portable coordination is missing a lock file; evidence retained",
        );
      // An interrupted transition may leave a complete DELETE-mode gate. The
      // data is already safe; retrying this conversion cannot reset any state.
      if (gate.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal")
        gate.exec("PRAGMA journal_mode=WAL");
    } catch (error) {
      if (busy(error))
        throw new PortableBusyError("Portable coordination bootstrap is busy");
      throw error;
    } finally {
      gate.close();
    }
  }
  private read(): PortableSnapshot & { journal: string | null } {
    regular(this.gate);
    const db = open(this.gate);
    try {
      db.exec("PRAGMA busy_timeout=50");
      const row = db
        .prepare("SELECT mode,revision,journal FROM state WHERE id=1")
        .get();
      if (
        !row ||
        !["idle", "draining"].includes(row.mode) ||
        !Number.isSafeInteger(row.revision)
      )
        throw new Error("Invalid portable coordination state");
      return row;
    } catch (error) {
      if (busy(error))
        throw new PortableBusyError("Portable coordination read is busy");
      throw error;
    } finally {
      db.close();
    }
  }
  snapshot(): PortableSnapshot {
    const { mode, revision } = this.read();
    return { mode, revision };
  }
  private save(
    mode: "idle" | "draining",
    revision: number,
    journal: Journal | null,
  ): void {
    const db = open(this.gate);
    try {
      db.exec("PRAGMA busy_timeout=50; PRAGMA synchronous=FULL");
      db.prepare("UPDATE state SET mode=?,revision=?,journal=? WHERE id=1").run(
        mode,
        revision,
        journal ? JSON.stringify(journal) : null,
      );
    } catch (error) {
      if (busy(error))
        throw new PortableBusyError("Portable coordination write is busy");
      throw error;
    } finally {
      db.close();
    }
  }
  private lock(file: string, exclusive: boolean): PortableLease {
    regular(file);
    const db = open(file);
    let released = false;
    try {
      db.exec(exclusive ? "BEGIN EXCLUSIVE" : "BEGIN");
      db.prepare("SELECT id FROM lease WHERE id=1").get();
    } catch (error) {
      db.close();
      if (busy(error)) throw new PortableBusyError();
      throw error;
    }
    return {
      release() {
        if (!released) {
          db.close();
          released = true;
        }
      },
    };
  }
  acquireWriter(): PortableLease {
    if (this.writerHeld)
      throw new PortableBusyError("Writer leases are not reentrant");
    const lease = this.lock(this.writer, true);
    this.writerHeld = true;
    let released = false;
    return {
      release: () => {
        if (!released) {
          lease.release();
          this.writerHeld = false;
          this.revokeInitialEligibility();
          released = true;
        }
      },
    };
  }
  private revokeInitialEligibility(): void {
    if (this.initialStage) this.initialStage.valid = false;
    this.freshActiveRevision = undefined;
    this.initialCandidates = new WeakSet<PortableCandidate>();
  }
  markMutation(): number {
    this.revokeInitialEligibility();
    if (!this.writerHeld) throw new Error("Mutation requires writer lease");
    if (this.journal() || this.snapshot().mode !== "idle")
      throw new Error("Recover publication before graph mutation");
    const revision = this.snapshot().revision + 1;
    this.save("idle", revision, null);
    return revision;
  }
  acquireReader(): PortableLease {
    // Acquiring the lease FIRST closes the check/gate race: a publisher cannot
    // acquire its exclusive fence until we have either pinned idle or released.
    const lease = this.lock(this.readers, false);
    try {
      if (this.snapshot().mode !== "idle")
        throw new PortableBusyError("Database publication is draining readers");
      return lease;
    } catch (error) {
      lease.release();
      throw error;
    }
  }
  private owned(record: Journal): void {
    if (
      !/^[0-9a-f-]{36}$/.test(record.id) ||
      !Number.isSafeInteger(record.baselineRevision)
    )
      throw new Error("Invalid publication record");
    const dir = path.join(this.runtime, record.id);
    if (
      record.path !== path.join(dir, "candidate.db") ||
      record.backup !== path.join(dir, "old.db")
    )
      throw new Error("Publication path identity mismatch");
    if (
      fs.existsSync(dir) &&
      (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink())
    )
      throw new Error("Unsafe publication directory");
  }
  private journal(): Journal | null {
    const row = this.read();
    if (!row.journal) return null;
    const record = JSON.parse(row.journal) as Journal;
    this.owned(record);
    if (
      !["building", "prepared", "replacing", "committed"].includes(record.phase)
    )
      throw new Error("Invalid publication phase");
    return record;
  }
  /** A cleanup obligation is durable before the publication journal is cleared.
   * Separate, task-bound records let reads/new builds proceed while GC retries. */
  private deferCleanup(record: Journal, revision: number): void {
    this.owned(record);
    const file = path.join(this.runtime, `${record.id}.cleanup.json`);
    const payload = JSON.stringify({ version: 1, record });
    if (regular(file, true)) {
      if (fs.readFileSync(file, "utf8") !== payload)
        throw new Error("Cleanup task identity mismatch");
    } else {
      const temporary = file + ".tmp";
      if (regular(temporary, true) && fs.lstatSync(temporary).nlink !== 1)
        throw new Error("Linked cleanup staging record retained");
      // A crash may leave this task's partial staging file. The journal still
      // owns the task, so rewriting only its staging record is safe.
      fs.writeFileSync(temporary, payload);
      flush(temporary);
      fs.renameSync(temporary, file);
    }
    flushDirectory(this.runtime);
    this.save("idle", revision, null);
  }
  private retryCleanup(): void {
    if (!this.writerHeld) throw new Error("Cleanup requires writer lease");
    const current = this.journal();
    let names: string[];
    try { names = fs.readdirSync(this.runtime); }
    catch { return; } // Retry transient GC directory access on the next recovery.
    for (const name of names) {
      if (!/^[0-9a-f-]{36}\.cleanup\.json$/.test(name)) continue;
      const file = path.join(this.runtime, name);
      try {
        regular(file);
        const task = JSON.parse(fs.readFileSync(file, "utf8"));
        const record = task.record as Journal;
        if (task.version !== 1 || name !== `${record.id}.cleanup.json`)
          throw new Error("Invalid cleanup task identity");
        this.owned(record);
        // Crash between recording the obligation and clearing the journal:
        // never reclaim a task which still owns publication state.
        if (current?.id === record.id) continue;
        this.cleanup(record);
        fs.unlinkSync(file);
        flushDirectory(this.runtime);
      } catch {
        // Busy SQLite, unknown artifacts and failures retain the obligation.
        // They do not revoke a commit or prevent querying the active database.
      }
    }
  }
  private cleanup(record: Journal): void {
    this.owned(record);
    const dir = path.dirname(record.path);
    if (fs.existsSync(dir)) {
      const names = fs.readdirSync(dir);
      const allowed = new Set(["candidate.db", "old.db"].flatMap(name =>
        [name, name + "-wal", name + "-shm", name + "-journal"]));
      if (names.some(name => !allowed.has(name)))
        throw new Error("Unknown candidate artifacts retained");
      // Validate every artifact before SQLite can follow a sidecar. Refuse
      // symlinks/hardlinks; no GC task may mutate an imported or active DB.
      for (const name of names) {
        const file = path.join(dir, name);
        regular(file);
        if (fs.lstatSync(file).nlink !== 1)
          throw new Error("Linked candidate artifact retained");
      }
      for (const file of [record.path, record.backup]) {
        if (regular(file, true)) {
          // Only SQLite removes its WAL/SHM/hot journal, after checkpoint and
          // exclusive journal-mode transition. Never unlink sidecars ourselves.
          if (["-wal", "-shm", "-journal"].some(suffix => fs.existsSync(file + suffix)))
            seal(file);
          noSidecars(file);
          fs.unlinkSync(file);
        } else {
          noSidecars(file); // Orphan sidecars cannot be safely interpreted.
        }
      }
      fs.rmdirSync(dir);
      flushDirectory(this.runtime);
    }
  }
  /** Caller must not have opened graph connections yet. Third-party imports are
   * accepted only after obtaining both OS fences and validating their snapshot.
   * Old candidate/backup evidence is retained, never restored over an import. */
  recover(): void {
    this.revokeInitialEligibility();
    const writer = this.writerHeld ? null : this.acquireWriter();
    let fence: PortableLease | null = null;
    try {
      const record = this.journal();
      if (!record) {
        if (this.snapshot().mode !== "idle")
          throw new Error("Draining state has no recovery record");
        this.retryCleanup();
        return;
      }
      if (["building", "prepared", "committed"].includes(record.phase)) {
        validate(this.active);
        this.deferCleanup(record, this.snapshot().revision);
        this.retryCleanup();
        return;
      }
      fence = this.lock(this.readers, true);
      for (const file of [this.active, record.path, record.backup])
        noSidecars(file);
      const active = digest(this.active),
        next = digest(record.path),
        old = digest(record.backup);
      if (!record.oldHash || !record.newHash)
        throw new Error("Missing recovery identities");
      if (
        active === record.oldHash &&
        old === null &&
        next === record.newHash
      ) {
        /* no rename */
      } else if (
        active === null &&
        old === record.oldHash &&
        next === record.newHash
      ) {
        fs.renameSync(record.backup, this.active);
        flushDirectory(this.dataDirectory);
      } else if (
        active === record.newHash &&
        old === record.oldHash &&
        next === null
      ) {
        // A fully installed validated candidate is a safe roll-forward.
        validate(this.active);
      } else if (
        active !== null &&
        active !== record.oldHash &&
        active !== record.newHash
      ) {
        validate(this.active);
        // Independent offline import wins. Keep evidence in its unique directory.
        this.save("idle", this.snapshot().revision + 1, null);
        return;
      } else
        throw new Error(
          "Ambiguous publication state; database evidence preserved",
        );
      validate(this.active);
      this.deferCleanup(record, this.snapshot().revision + 1);
      fence.release();
      fence = null;
      this.retryCleanup();
    } finally {
      fence?.release();
      writer?.release();
    }
  }
  beginCandidate(): PortableCandidate {
    this.revokeInitialEligibility();
    if (!this.writerHeld)
      throw new Error("Candidate construction requires writer lease");
    if (this.journal() || this.snapshot().mode !== "idle")
      throw new Error("Recover the previous publication before construction");
    const id = randomUUID(),
      dir = path.join(this.runtime, id),
      baselineRevision = this.snapshot().revision;
    const record: Journal = {
      id,
      path: path.join(dir, "candidate.db"),
      backup: path.join(dir, "old.db"),
      baselineRevision,
      phase: "building",
    };
    this.save("idle", baselineRevision, record); // Intent precedes directory creation.
    fs.mkdirSync(dir);
    flushDirectory(this.runtime);
    return record;
  }
  /** Reserve a private baseline path. Nothing appears at the active path until
   * schema initialization has closed and the baseline has been sealed. */
  reserveInitialActive(): string {
    this.revokeInitialEligibility();
    if (!this.writerHeld || this.initialStage || this.journal() || this.snapshot().mode !== "idle")
      throw new Error("Initial creation requires a fresh idle writer");
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      if (regular(this.active + suffix, true))
        throw new Error("Initial creation cannot replace an existing database or sidecar");
    const directory = path.join(this.runtime, `initial-${randomUUID()}`);
    fs.mkdirSync(directory);
    const file = path.join(directory, "baseline.db");
    this.initialStage = { directory, file, revision: this.snapshot().revision, valid: true };
    return file;
  }
  private assertInitialDirectory(directory: string): void {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Unsafe initial staging directory");
  }
  /** Caller has closed and drained the private baseline connection. The same
   * root/writer locks and offline-import contract used by ordinary publication
   * protect this rename. Crash debris remains private and is never adopted. */
  installInitialActive(): void {
    const stage = this.initialStage;
    if (!this.writerHeld || !stage || !stage.valid || this.journal() || this.snapshot().mode !== "idle" ||
        this.snapshot().revision !== stage.revision)
      throw new Error("Initial baseline reservation is no longer valid");
    this.assertInitialDirectory(stage.directory);
    regular(stage.file);
    if (fs.lstatSync(stage.file).nlink !== 1)
      throw new Error("Linked initial baseline retained");
    seal(stage.file, false);
    // Preserve the normal active-database WAL default before it becomes
    // visible. Switching DELETE to WAL later would block on an admitted read
    // transaction, even though the baseline itself was safely sealed.
    const db = open(stage.file);
    try { db.exec("PRAGMA journal_mode=WAL"); }
    finally { db.close(); }
    noSidecars(stage.file);
    flush(stage.file);
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      if (regular(this.active + suffix, true))
        throw new Error("Initial creation cannot replace an existing database or sidecar");
    fs.renameSync(stage.file, this.active);
    flushDirectory(this.dataDirectory);
    flushDirectory(stage.directory);
    fs.rmdirSync(stage.directory);
    this.initialStage = undefined;
    flushDirectory(this.runtime);
    this.freshActiveRevision = stage.revision;
  }
  /** Discard only this process's closed, private staging file. If SQLite
   * sidecars or unknown artifacts remain, retain them for offline inspection. */
  discardInitialStage(): void {
    const stage = this.initialStage;
    if (!stage) return;
    this.assertInitialDirectory(stage.directory);
    const names = fs.readdirSync(stage.directory);
    if (names.some(name => name !== "baseline.db")) return;
    if (regular(stage.file, true)) {
      if (fs.lstatSync(stage.file).nlink !== 1) return;
      fs.unlinkSync(stage.file);
    }
    fs.rmdirSync(stage.directory);
    this.initialStage = undefined;
  }
  /** Only a baseline created by this writer at an unchanged revision confers
   * one use of the initial-publication shortcut. Any other operation revokes it. */
  beginInitialCandidate(): PortableCandidate {
    if (!this.writerHeld || this.freshActiveRevision === undefined ||
        this.snapshot().revision !== this.freshActiveRevision)
      throw new Error("Initial candidate requires a newly created active database");
    this.freshActiveRevision = undefined;
    const candidate = this.beginCandidate();
    this.initialCandidates.add(candidate);
    return candidate;
  }
  async publishInitialCandidate(
    candidate: PortableCandidate,
    options: PortablePublishOptions = {},
  ): Promise<{ pauseMs: number; revision: number }> {
    if (!this.initialCandidates.delete(candidate))
      throw new Error("Initial candidate capability is missing or already used");
    // Fresh init historically did not run a full quick_check. Keep all SQLite
    // sealing, fsync, identity, fencing and recovery steps; only the redundant
    // pre-publication full scan is omitted for this in-process private build.
    return this.publishCandidate(candidate, options, false);
  }
  abortCandidate(candidate: PortableCandidate): void {
    if (!this.writerHeld)
      throw new Error("Candidate cancellation requires writer lease");
    const record = this.journal();
    if (!record || record.id !== candidate.id) return;
    if (!["building", "prepared"].includes(record.phase))
      throw new Error("Publication has entered replacement; recovery required");
    this.deferCleanup(record, this.snapshot().revision);
    // A failed native builder may still own handles in this process. Reclaim
    // only on the next recovery, after its lifetime writer lease is released.
  }
  async publish(
    candidate: PortableCandidate,
    options: PortablePublishOptions = {},
  ): Promise<{ pauseMs: number; revision: number }> {
    this.revokeInitialEligibility();
    return this.publishCandidate(candidate, options, true);
  }
  private async publishCandidate(
    candidate: PortableCandidate,
    options: PortablePublishOptions,
    check: boolean,
  ): Promise<{ pauseMs: number; revision: number }> {
    if (!this.writerHeld) throw new Error("Publication requires writer lease");
    const record = this.journal();
    if (!record || record.id !== candidate.id || record.phase !== "building")
      throw new Error("Publication candidate does not match active intent");
    if (this.snapshot().revision !== candidate.baselineRevision)
      throw new Error("Database revision changed during construction");
    const timeout = options.timeoutMs ?? 1000;
    if (!Number.isFinite(timeout) || timeout <= 0)
      throw new Error("Invalid publication timeout");
    options.signal?.throwIfAborted();
    seal(record.path, check);
    // Full checkpoint/hash stays outside the admission pause. Writer lease
    // prevents graph mutation; readers are allowed to continue using old data.
    const old = open(this.active);
    try {
      if (old.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy > 0)
        throw new PortableBusyError("Old database checkpoint is blocked");
    } finally {
      old.close();
    }
    record.oldHash = digest(this.active) ?? undefined;
    record.newHash = digest(record.path) ?? undefined;
    if (!record.oldHash || !record.newHash)
      throw new Error("Publication database missing");
    record.phase = "prepared";
    this.save("idle", candidate.baselineRevision, record);
    options.hook?.("prepared");
    await options.beforeDrain?.();
    options.signal?.throwIfAborted();
    let fence: PortableLease | null = null,
      committed = false;
    const started = performance.now();
    this.save("draining", candidate.baselineRevision, record);
    try {
      options.hook?.("draining");
      while (!fence) {
        options.signal?.throwIfAborted();
        if (performance.now() - started >= timeout)
          throw new PortableBusyError(
            "Publication drain timed out; old database remains available",
          );
        try {
          fence = this.lock(this.readers, true);
        } catch (error) {
          if (!(error instanceof PortableBusyError)) throw error;
          await delay(5);
        }
      }
      // SQLite owns sidecar removal. Never unlink WAL files to force a rename.
      const db = open(this.active);
      try {
        if (db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy > 0)
          throw new PortableBusyError("Final SQLite checkpoint is blocked");
      } finally {
        db.close();
      }
      noSidecars(this.active);
      noSidecars(record.path);
      options.signal?.throwIfAborted();
      if (performance.now() - started >= timeout)
        throw new PortableBusyError("Publication drain budget exceeded");
      record.phase = "replacing";
      this.save("draining", candidate.baselineRevision, record);
      fs.renameSync(this.active, record.backup);
      flushDirectory(this.dataDirectory);
      flushDirectory(path.dirname(record.path));
      options.hook?.("old-moved");
      fs.renameSync(record.path, this.active);
      flushDirectory(this.dataDirectory);
      options.hook?.("new-moved");
      const check = open(this.active, true);
      try {
        check.prepare("SELECT count(*) FROM sqlite_master").get();
      } finally {
        check.close();
      }
      record.phase = "committed";
      this.save("idle", candidate.baselineRevision + 1, record);
      committed = true;
      options.hook?.("committed");
      fence.release();
      fence = null;
      const pauseMs = performance.now() - started;
      try {
        this.deferCleanup(record, candidate.baselineRevision + 1);
        this.retryCleanup();
      } catch {
        /* recover performs conservative terminal cleanup */
      }
      return { pauseMs, revision: candidate.baselineRevision + 1 };
    } catch (error) {
      if (committed) throw error; // Commit is irreversible, including hook failure.
      if (record.phase !== "replacing")
        this.save("idle", candidate.baselineRevision, record);
      fence?.release();
      fence = null;
      if (record.phase === "replacing") this.recover();
      throw error;
    } finally {
      fence?.release();
    }
  }
}
