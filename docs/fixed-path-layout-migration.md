# Controlled fixed-path layout migration

This module is phase-two infrastructure, **not a default enablement or a release**.
Production controllers must opt into it and complete their own CLI/MCP/daemon/SDK
end-to-end acceptance. It operates on the caller's already-resolved data directory,
including `CODEGRAPH_DIR`; it does not hardcode a project directory.

## Authority and integration contract

- `inspectFixedPathLayout(dataDir)` returns `legacy` or `fixed`. A fixed result is
  authoritative even when an experimental environment flag is subsequently disabled.
- `.runtime/layout.json` is the local authority: `{version:1, layout:"fixed-path-v1",
  migrationId:<UUID>}`. It never travels inside a public database.
- Once committed, the actual database is the regular root `codegraph.db`. `CURRENT`
  cannot redirect reads, including when stale, missing or malformed.
- Every production open/discovery path must call `recoverFixedPathMigration(dataDir)`
  **before any database connection** and then inspect layout. Recovery only resumes
  an operation with persisted offline authorization; it does not authorize a new migration.
- `migrateToFixedPath(dataDir, {offline:true, validateDatabase})` (also exported as
  `registerFixedPathLayout`) is an explicit offline API. The caller must first stop
  all CodeGraph and external database users. It does not silently migrate at query time.
- `validateDatabase` supplies production schema/version/extraction compatibility
  checks. The module checks SQLite quick integrity and snapshot sealing, not whether
  an index is complete. Initial-storage/incomplete indexes retain their data and must
  still follow ordinary CodeGraph completeness/upgrade checks.
- Fixed-layout writers must use their own controller coordination domain (for example
  `FixedPathWriterLock`), not the legacy root `codegraph.lock`. A successfully committed
  migration may temporarily retain its old root token after Windows cleanup failure;
  that retired token must not prevent new fixed-layout readers or writers.
- Registration requires a closed database; close a freshly initialized writer before
  registering it. After registration, open through the fixed-path controller.

## Conflict matrix

| Existing state | Action |
|---|---|
| Root DB only | Validate/seal and register; no reindex |
| Valid CURRENT only | Copy its DB into an owned same-filesystem operation directory; install at root after validation |
| Root DB and CURRENT | Explicit conflict; preserve both, including apparently identical files |
| Malformed CURRENT, missing target, unsafe path, READY mismatch | Fail closed; never fallback to root |
| Neither root nor CURRENT | No database to migrate; do not select an orphan generation |
| Committed fixed marker | Root is authoritative; stale CURRENT is ignored |
| Pending migration | Recover before admission; unknown identities preserve evidence and fail closed |
| Committed marker missing/corrupt | Error; old CURRENT cannot silently become active again |

Conflicts require a separate explicit offline administrative decision. This API has
no automatic “choose newer”, mtime, size, PID, directory-age, or force-delete mode.

## Process-crash protocol

A FULL-synchronous DELETE-mode SQLite journal records operation UUID, offline
approval, source path/hash, candidate hash, recorded writer token, phase and final
outcome. A separate SQLite OS-exclusive owner lock serializes migration/recovery.
Paths and operation artifacts are constrained and regular-file checked.

1. Validate and seal source under the caller's offline precondition. Existing
   sidecars are rejected and left untouched; the user must close/checkpoint normally.
   An otherwise closed WAL-mode DB is checkpointed and changed to DELETE so validation
   cannot leave newly generated WAL/SHM paired with a renamed root.
2. Persist `preparing`, create a uniquely owned candidate, validate/copy/fsync it.
3. Recheck source digest and CURRENT, persist `installing`, then rename candidate to
   the previously absent root. A newly appeared root is a conflict, never overwritten.
4. Validate root, fsync a staged layout marker and rename it to `.runtime/layout.json`.
   The durable fixed marker is the commit decision, including a crash before the next
   journal update.
5. Record committed outcome; remove only owned migration artifacts. Reclaim registered
   old generations using existing cross-process lifecycle leases. Unmanaged historical
   directories are deliberately retained; they are not safe automatic GC targets.

Before marker commit, exact identities permit returning the installed root to its
owned candidate and preserving the original generation. Unknown roots, candidate
changes or source changes stop recovery. After marker commit, recovery is cleanup-only:
**it never restores the old source**, even if the root now contains later confirmed
writes or a different offline public database. Cleaned journal records retain their
committed outcome so losing the marker cannot turn into a legacy fallback.

A process crash after writing the recorded root writer lock can reclaim that exact
lock under the OS migration-owner lock. Foreign locks are never expired by PID/age. Before commit, a foreign writer token blocks recovery; after the matching fixed marker commits, a new writer token belongs to normal fixed-layout coordination and is left untouched rather than treated as a migration conflict. Failure to unlink this migration's own token after commit is deferred cleanup, not a reason to block reads.
The APIs do not block waiting for other processes; unresolved recovery contention reports an error. Completed operations use a strictly checked read-only fast path: no exclusive owner lock is acquired for ordinary concurrent cold opens. Corrupt metadata still fails explicitly; only SQLite BUSY and READONLY_ROLLBACK from a hot journal enter exclusive recovery.

## Public database offline replacement

Close all related processes normally → overwrite `codegraph.db` with one complete,
self-contained public snapshot → restart. Do **not** copy publisher `.runtime` files.
The existing local marker remains valid, old CURRENT is ignored, and completed
migration records cannot replace the newly imported root. Corrupt/missing root files
must produce ordinary open/compatibility errors; do not add a legacy fallback.
Completed migration cleanup errors are reported on stderr and in the migration result's `cleanupWarnings`, but do not block root admission. Even a metadata write failure after the authoritative marker commits must not undo the fixed root. The production controller must recreate connections/caches and invalidate mismatched
local cost bindings. That behavior belongs to controller integration, not this module.

## Cleanup and limits

`migrateToFixedPath` returns a `cleanup` promise for registered-generation cleanup.
Recovery also schedules conservative retry once per data directory per process, rather than starting GC on every normal query/probe. A held reader lease prevents deletion;
no files are deleted based on age. Unexpected operation files stop cleanup and retain
evidence. A cleanup error after commit is not a rollback and does not block queries. Deferred committed cleanup is attempted once per process; another ordinary probe is not a retry loop. Retry on a later process startup or an explicit offline `migrateToFixedPath` call after resolving the error. Likewise, if old-reader leases prevent registered-generation GC during this startup, retry on restart or the next explicit offline migration/registration call; this module does not promise continuous same-process retirement polling.

These locks do **not** prove that old binaries or arbitrary external SQLite tools are
closed. First migration is explicitly offline, not a claim of transparent online
migration. Existing sidecars with recovery value are never removed to force success.
A crash before the initial journal transaction can leave an unreferenced owned operation
directory; it is intentionally retained rather than guessed away.

Linux directory fsync is performed at rename boundaries. Windows directory fsync is
not claimed. Process-exit fault injection does not prove power-loss durability, and
Windows must run this suite separately. This module alone does not satisfy the full
public-cover → increment → automatic rebuild → public-cover production-entrypoint cycle.

## Focused regression command

```sh
npm run build
node --liftoff-only --test scripts/tests/fixed-path-layout.test.cjs
```

The suite uses real SQLite and child-process exits, explicit conflict/corruption and
ENOSPC injection, offline replacement and postcommit-write preservation. It does not
substitute for production-entrypoint, Windows, large-repository or power-loss tests.
