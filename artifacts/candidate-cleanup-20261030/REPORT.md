# Interrupted real candidate cleanup audit (phase one only)

Base: d14b35c6dbf36ce58c34f0921d9628007648dad5. Linux, Node v24.22.1.

## Confirmed defect
The interrupted OceanBase build left operation `045d6cdc-9116-4c89-a6f0-b63bc64ee3f0` with a 519,888,896-byte unsealed candidate plus the real indexer's `codegraph.lock`. The ordinary recovery code marked it aborted, but its artifact allowlist rejected the lock and retained the directory. Recovery intentionally suppresses cleanup errors for retry, so a successful recovery result did not mean cleanup succeeded. The actual incident evidence remains under `benchmark-real/evidence/full-cycle-d14b35c-3rounds/interruption/`; this audit did not change that fixture.

## Bounded repair
Only aborted **unsealed** operations admit `codegraph.lock` as a known artifact. All recognized files are checked with lstat before deletion; unknown files, symlinks/directories, or a lock alongside a sealed candidate preserve evidence. Cleanup continues to rely on the existing operation marker and publisher OS lease: the candidate builder runs in the publisher process. No PID liveness/age inference, manual unlock, root `codegraph.lock` deletion, production changes, or phase-two integration.

An empty/partially written candidate lock is permitted: its contents do not establish liveness. The OS lease does. This does not protect arbitrary external tools that violate the cooperative protocol or a future detached candidate builder; that architecture would need its own lifetime lease.

## Regressions and evidence
- `baseline-d14-regression.log`: same six tests against unchanged d14 protocol, **4 pass / 2 fail** (crashed and partially written lock candidate not collected).
- `regression.log`: fixed protocol **6/6 pass**.
- `related-regression.log`: new cases + complete acceptance + recovery observer suites, **59/59 pass, zero skips**.
- Uses the actual built `FileLock` implementation in a separate process. It retains the publisher owner and dirty WAL candidate, proves live-builder recovery refuses cleanup, SIGKILLs it, then proves normal recovery deletes only the operation directory and leaves the active database hash unchanged. Repeat recovery is idempotent.
- Negative tests: unexpected file, directory lock, symlink lock, sealed candidate lock preserve the entire candidate directory and active hash.
- `initial-test-fixture-failure.log` is retained: first test draft failed because its unused DatabaseSync object was garbage-collected and removed the WAL before the assertion. Keeping builder resources reachable fixed the fixture, not the cleanup assertion.
- Test util build is reused from the unchanged d14 tree; changes are standalone .mjs. Windows execution is pending CI and is **not claimed passed**.

Tests are registered in `run-source.mjs`. This closes only the known artifact omission, not the separate Windows coordinator contention failure or the large-repo/query-long-tail gates.
