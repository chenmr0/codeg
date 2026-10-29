# WAL structural experiment: test-goal mapping

Baseline: `6a1138b` and retained Windows round-10 evidence. This worktree does not
rewrite baseline logs or claim the old DELETE-coordination implementation passed.
Only the coordinator changes to WAL; publisher, writer and connection lease
files remain DELETE mode and retain their actual cross-process exclusion tests.
All baseline test files remain in the runner. An obsolete lock-mechanism assertion
is replaced with a stronger observable safety assertion, not skipped or deleted.

| Existing coverage | WAL success condition / unchanged invariant |
| --- | --- |
| `gate-read`: read snapshot blocks draining COMMIT | Draining COMMIT succeeds while read snapshot exists; reader's already-acquired **connection lease** prevents replacement. Old request completes A; next request reads B. |
| `gate-read`: optional read-gate flag | Both flag values use read-only admission; graph writes still durably increment revision before graph action. |
| `gate-read` / acceptance: admission COMMIT fault | Failed read transaction does not call business callback or factory, leak active count, or release another request's lease. Write transaction ambiguity still propagates. |
| `gate-wait-policy`: SHARED read blocks writer COMMIT | WAL reader does **not** block writer COMMIT. Writer-vs-writer BEGIN contention, action-once, rollback and 500ms limit remain tested. |
| `gate-wait-policy`: clear costs at each cold read | Startup invalidates previous costs atomically; subsequent cold/warm read admission does not write coordinator. Startup SELECT/DELETE faults preserve cost rows and release leases, before any graph factory. |
| `gate-diagnostics`: EXCLUSIVE probe alone proves connection closed | Observe the actual coordinator `close()` completion before diagnostic append, in addition to writer exclusion probe. WAL EXCLUSIVE alone is not proof of absent readers. |
| `gate-reuse` | Independent writer-gate retry retains connection identity, action-once, rollback-before-retry and close-on-error. Persistent participant reads are covered separately. |
| `admission-budget`: idle gate writer implies query delay/timeout | Idle WAL writer allows query A before writer release, with/without publisher owner. Real wait/timeout tests use committed closed admission and **connection EXCLUSIVE** fence, not WAL writer lock. |
| `retirement-contention`: idle gate BUSY retires native handle | Fresh committed idle remains readable; retain native handle, no background error, successful query preserved. Committed draining triggers retirement; native close failure retains lease. |
| `recovery-observer` | Fresh read observes old idle before draining commit, new draining after commit. No redundant initialization; missing lease/state and real corruption fail closed. |
| long-request cancellation | Old A request completes intact; queued new request returns A in <1s after pre-replacement cancellation. No cancellation of replacing/committed state. |
| crash matrix | Keep all 13 hooks, including both sides of both renames and old/new-moved hooks. Intent-only durable state must recover exact A before commit or B after commit; committed B writes never roll back. |
| public offline overwrite / real graph caches | Full public file becomes active with unchanged runtime retained. No stale graph/framework cache or costs; repeated import→sync→rebuild→import loop remains required. |

## Six retained Windows round-10 failure goals

1. Long request + queued request: same success and <1s arrival-to-return assertion.
2–3. Async and sync warm reads under a 600ms idle coordinator writer: now require
success while that writer is still held, instead of waiting for its release.
4. Idle observer: reads committed idle without forced retirement or error.
5. Active reader: no observer/close while active, and successful result remains
successful during unrelated coordinator writing after active count reaches zero.
6. Native close failure: inject after **committed draining**, rather than rely on
DELETE-specific BUSY; exact close error and real protecting lease remain visible.

## Mandatory additional structural evidence

Lease-first/fence-first IPC ordering; stale preliminary idle check across complete
publication; prepare/cleanup writer delays >=600ms with concurrent reads;
final-commit fence retained until durable idle; intent-only crash matrix; WAL
crash/all-close recovery and offline overwrite with runtime retained. Existing
Windows/Linux query and drain budgets are unchanged. Functional Linux passes do
not substitute for fixed-count Windows or representative-repository acceptance.

Post-review additions: `wal-active-path.test.mjs` proves both read and write cold
admission reject a missing active file before native opening (never create an
empty DB), and reject a static symlink without changing its target. These are
new tests, not substitutions for the baseline 128 goals. The concurrent cold
bootstrap first run failed in pre-action WAL-mode initialization; its original
failure log is retained. Subsequent bootstrap passes are reported only after the
implementation added bounded pre-action initialization handling.

Initial Linux execution evidence (not Windows acceptance):
- `wal-adaptation-linux/full`: 129/130, concurrent bootstrap failed at first WAL
  coordinator initialization; no assertions were removed to suppress this.
- `wal-adaptation-linux/bootstrap-after`: 6/6 focused passes after pre-action
  bootstrap handling, including missing-active and symlink rejection.
- `wal-adaptation-linux/full-after`: 131/132, still failed concurrent bootstrap at
  the later Participant persistent coordinator open. This is a separate uncovered
  open path, not a passing end-to-end result or a reason to retry tests until green.

After bounded pre-action persistent-open handling:
- Fixed three bootstrap runs each exercised five simultaneous processes across
  five rounds (75 cold clients total), all passed; logs `wal-bounded-open-linux/bootstrap-{1,2,3}.log`.
- Complete adapted baseline + four new safety targets: 132/132, no skips.
- Added nine structural WAL cases to `run-source.mjs`: 141/141, no skips, 63.07s.
  This last run is **transitional evidence only**: protocol SHA changed during
  execution (maintenance-error observability edit). Before/after hashes are in
  `wal-bounded-open-linux/full-141/`; repeat final frozen version with checkpoint
  coverage before claiming final acceptance. Linux results do not replace Windows.
