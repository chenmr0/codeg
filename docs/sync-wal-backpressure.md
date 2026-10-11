# WAL checkpoint/backpressure policy

`CODEGRAPH_NO_WAL_DEFER=1` retains its existing meaning: keep SQLite's ordinary
connection autocheckpoint setting instead of CodeGraph's deferred checkpoint
valve. WAL mode and graph/index scope are not changed by this option.

With deferral enabled, the valve is shared by incremental sync and durable
(non-fresh) full indexing. Fresh MEMORY/OFF initialization remains unchanged.

- Default soft threshold: 256 MiB (`CODEGRAPH_WAL_VALVE_MB` overrides it).
- Timer: at most one advisory PASSIVE checkpoint in flight, checked every 2s
  once the physical WAL allocation exceeds soft. Reused allocations can cause
  another PASSIVE at the next tick even when already backfilled; this bounded
  extra work avoids mistaking physical size for logical checkpoint progress.
- Write-boundary cap: twice soft, measured as **absolute physical WAL bytes**,
  not growth above a previous checkpoint. The previous growth baseline was
  unsafe across asynchronous checkpoint snapshots and reused WAL generations.
- At the cap, wait with writers parked outside transactions, run PASSIVE and
  then TRUNCATE. TRUNCATE is never issued by the concurrent timer. A reader
  pinning frames/space, unavailable machinery, or repeated lack of progress
  fails closed with `WAL_VALVE_ABORT`, preserving the normal retry journal.
- Phase boundaries always inspect nonempty WAL, even without physical growth.
  Empty WAL does not start a checkpoint worker. Unknown file-size I/O errors
  propagate at the next writer boundary instead of being treated as zero.

The bound is checked after a committed file/delete/reference batch and after
index restoration/synthesis phases. It is not a strict byte ceiling: a single
large transaction/file or an internally multi-write synthesis phase may
overshoot it before the next gate. Other database writers are outside this
writer's control. A lower threshold trades more folding/I/O for less space.

PASSIVE/TRUNCATE use a worker connection with `busy_timeout=0`. No-progress
reader pins stop promptly; attempts are bounded and delayed, not a busy spin.
The worker receives a termination request after 60 seconds, and the caller
waits for confirmed exit before allowing further writes. This is deliberately
**not** a guaranteed 60-second wall-clock deadline for uninterruptible OS I/O:
resuming while a checkpoint thread still holds SQLite locks would be unsafe.

On failure, sync/full-index cleanup restores the prior autocheckpoint policy
and releases its lock; normal persisted pending-reference/retry state allows
resumption after the reader/space problem is resolved. Do not remove live
`-wal`/`-shm` files. This change does not alter graph schema, extraction version,
macro invalidation policy, or file replacement transaction semantics.

Tests: `wal-valve-backpressure.test.ts`, `wal-checkpoint-worker-lifecycle.test.ts`,
`sync-wal-boundaries.test.ts`, `sync-wal-worker-boundary.test.ts`, plus existing
sync WAL, recovery, batching, append-delta and worker regression suites.
