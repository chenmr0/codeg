# Cold-bootstrap schema-read retry boundary

Baseline `59cccaccd75ecf1371e2f9e05f7877d4eaa716f7`; independent worktree `codeg-bootstrap-read` / branch `fix/wal-bootstrap-read`. The ongoing large-repository frozen worktree was not changed.

## Original Windows evidence

CI https://github.com/chenmr0/codeg/actions/runs/40982132525: the 18th of 20 fixed cold-bootstrap repetitions failed. Original `acceptance.json` and `run.tap` are retained here. The stack points to `initialize()`'s `SELECT name FROM sqlite_master WHERE name='state'` `.get()` at baseline protocol.mjs:121. That read occurred **after** the coordinator open retry returned and **before** any bootstrap mutation.

The previous stale-DELETE mode correction is not undone. This is another read-only pre-admission boundary omitted from bounded retry. The original worker IPC preserved only stack text (`database is locked`), not numeric SQLite errcode, so the exact BUSY subtype is unknown. It must not be asserted from that text alone.

## Narrow change

Coordinator opening and the first schema read now form one read-only probe under the existing **single 500 ms deadline**. The connection is closed before retry. Only the existing numeric SQLite BUSY primary family is retryable; LOCKED, IOERR, corruption, invalid codes, real DELETE incompatibility, missing leases and other errors still fail explicitly. The subsequent gate/action which creates lease files and state is outside this loop and is never replayed by it.

Terminal probe errors retain their identity and now attach numeric code, errcode, attempts and elapsed time to diagnostic stack text, so a future worker failure is diagnosable without changing IPC or retry policy.

## Validation

Linux, Node v24.22.1:

- New deterministic **fault-injection** tests exercise schema `.prepare()` and `.get()` independently: BUSY codes 5/261/517/773, close-before-retry sequence, persistent contention exhausting the existing budget, and immediate non-BUSY failures with zero bootstrap writes.
- Running those tests against untouched `59cccac`: **10 failed, 2 passed**, retained in `formal-baseline.log` (expected defect demonstration, not a passing run).
- Fixed related suite: **46/46 passed, zero skipped**, including preceding real-process stale-DELETE race, compatibility, lease fault preservation, BUSY family and cold-open lifecycle. `regression.log` contains the full result.
- Predeclared **20/20 five-process cold-bootstrap repetitions passed**, all round logs/JSON retained, no failed rounds discarded, no budget increase.

This does not claim to recreate the original Windows scheduling interleaving on Linux. Windows must run the repaired source before this gate can close. Earlier large-repository benchmark results cannot be relabeled as complete validation for this newer revision.

## Commands

```
node --liftoff-only --test --test-concurrency=1 scripts/prototypes/fixed-path/bootstrap-schema-busy.test.mjs scripts/prototypes/fixed-path/coordinator-bootstrap-race.test.mjs scripts/prototypes/fixed-path/coordinator-busy-family.test.mjs scripts/prototypes/fixed-path/lease-bootstrap.test.mjs scripts/prototypes/fixed-path/wal-compatibility.test.mjs scripts/prototypes/fixed-path/cold-open.test.mjs
node --liftoff-only --test --test-name-pattern='^simultaneous cold clients' scripts/prototypes/fixed-path/acceptance.test.mjs
```

The new tests are included in the cross-platform `run-source.mjs` suite. No production integration or second-phase migration is introduced.
