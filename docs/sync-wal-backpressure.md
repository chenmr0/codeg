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
  then TRUNCATE. TRUNCATE is never issued by the concurrent timer. Short-lived
  reader/writer contention and temporary checkpoint unavailability are retried
  while the writer remains parked; two identical results no longer abort sync.
- The retry budget defaults to 10 seconds (`CODEGRAPH_WAL_WAIT_MS`, positive
  integer milliseconds, clamped to 1–60,000; invalid/non-positive values use
  the default). It starts after the first retryable blocked/failed attempt.
  Delays grow from 50 to 100, 200, 400, then at most 500ms. The budget never
  resets when progress changes. Permanent SQLite errors stop immediately above
  cap; exhausted retries still fail with `WAL_VALVE_ABORT` and retain recovery
  work. Increasing this budget does not increase the WAL byte cap.
- Phase boundaries always inspect nonempty WAL, even without physical growth.
  Empty WAL does not start a checkpoint worker. Unknown file-size I/O errors
  propagate at the next writer boundary instead of being treated as zero.

The bound is checked after a committed file/delete/reference batch and after
index restoration/synthesis phases. It is not a strict byte ceiling: a single
large transaction/file or an internally multi-write synthesis phase may
overshoot it before the next gate. Other database writers are outside this
writer's control. A lower threshold trades more folding/I/O for less space.

PASSIVE/TRUNCATE use a worker connection with `busy_timeout=0`. The normal first
attempt and advisory timer keep their existing 60-second cancellation deadline,
so a healthy checkpoint on slow storage does not acquire a shorter timeout.
Once retries begin, each worker receives the remaining retry budget as its
cancellation deadline. The caller always waits for the actual worker exit,
including when a termination request fails. Neither timeout is a guaranteed
wall-clock deadline for uninterruptible OS I/O: resuming while a checkpoint
thread still holds SQLite locks would be unsafe. Draining an already-running
timer checkpoint can also precede the retry budget.

Abort diagnostics include the last mode, reason, checkpoint frame counts when
available, attempt count, retry wait and original worker/SQLite error. Reasons
distinguish contention, timeout, unavailable machinery and permanent SQLite
errors. A failed pause logs `backpressure aborted`, not `backpressure released`.
Below-cap phase folds retain their advisory behavior; the timer never aborts
the writer itself. Successful ordinary writes incur no retry delays.

With verbose logging, each completed/aborted writer pause also emits one
`checkpoint-detail` line. `trigger=cap|phase` distinguishes a write-boundary
pause from an explicit phase fold; `outcome=released|aborted` describes whether
the writer was allowed to resume. `retryStarted=true` means a retryable blockage
actually started the retry budget, not merely that the pause took several
seconds. `passiveCalls` and `truncateCalls` count fresh calls during this pause.

`inflightMs`, `passiveMs`, `truncateMs`, `retrySleepMs`, and `otherMs` are
non-overlapping parts of `totalMs`, rounded independently to milliseconds.
`inflightMs` is the remaining wait for an already-running advisory checkpoint;
its work is not also counted in `passiveMs`. PASSIVE/TRUNCATE call times include
worker startup, database open/checkpoint/close and confirmed worker exit; they
are not isolated disk-I/O measurements. Retry sleep includes scheduling delay.
The total covers this pause, not prior phase-fold draining or all sync work.
These figures are already included in the caller's WAL-wait/phase timing and
must not be added to those totals again. A released below-cap advisory fold
does not prove the WAL was truncated; inspect the existing `wal=` result.

On failure, sync/full-index cleanup restores the prior autocheckpoint policy
and releases its lock; normal persisted pending-reference/retry state allows
resumption after the reader/space problem is resolved. Callers whose old edges
lack reference metadata are recorded in the existing metadata table in the
same transaction that removes the old target. An unchanged caller is recovered
on the next sync, and its task is cleared only after successful completion;
new invalidations cannot be acknowledged by an older recovery attempt. This
protects interruptions after the fix is installed; it cannot reconstruct old
unstamped edges already lost without a durable task before the fix. If that
specific loss is confirmed, use the supported full re-index command.
Do not remove live `-wal`/`-shm` files. This change does not alter graph schema, extraction version,
macro invalidation policy, or file replacement transaction semantics.

Tests: `wal-valve-backpressure.test.ts`, `wal-checkpoint-errors.test.ts`,
`wal-checkpoint-worker-lifecycle.test.ts`, `sync-wal-rewire-recovery.test.ts`,
`sync-wal-watcher.test.ts`,
`sync-wal-boundaries.test.ts`, `sync-wal-worker-boundary.test.ts`, plus existing
sync WAL, recovery, batching, append-delta and worker regression suites.
