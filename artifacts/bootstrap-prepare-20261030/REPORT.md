# Cold-bootstrap lock-hold diagnosis and structural repair

Source: `812e21881f28b721e88715c1213c9f446e8f9c35`; parent `d14b35c6`.

## Confirmed cause, not fairness speculation
Windows run 40984447794 cold-bootstrap-6 fixture `fixed-path-cold-pPbTJt`:
- winner PID 6468 acquired coordinator at 1793322982715; action 655.59 ms, commit 104.68 ms, close 491.29 ms.
- four losers began at 1793322982712/2728 and exhausted the unchanged 500 ms gate budget at 500–512 ms, actionStarted=false.
- winner built and FULL-synced three DELETE lease databases while holding coordinator's writer transaction. No retry policy can finish losers inside that interval.

## Change
Prepare complete private lease files before acquiring coordinator writer gate. Under gate recheck state, adopt existing committed state without replacing its files, or rename all completed leases and commit initial state. Gate deadline remains 500 ms. No IOERR or LOCKED retry broadening.

Deterministic old-versus-new regression: pause parent at first lease CREATE and synchronously launch another real process initializing the same project. Old protocol holds the gate and child fails BUSY at 501.81 ms. New protocol allows child to finish before parent resumes; parent then waits an additional 550 ms and does not replace winner's lease identities. This demonstrates lock placement rather than favorable timing.

## Failure boundaries
- Preparation errors publish no fixed lease and clean only this invocation's definitely closed candidate files.
- Uncertain close preserves its database and rollback journal.
- Unknown files prevent directory cleanup; cleanup errors preserve original failure via AggregateError.
- Crash during private preparation: private directory retained, never adopted or age/PID swept; later initialization can proceed.
- Crash after any fixed lease promotion but before state COMMIT: fixed evidence retained and later initialization fails closed, as before.
- Crash after state COMMIT: later initialization adopts committed state normally.

Private crashed bootstrap directories contain small coordination lease files, not graph candidates. They intentionally remain evidence requiring diagnosis; this change does NOT claim automatic reclamation of every bootstrap artifact. Graph build candidate cleanup is a separate protocol. Directory rename durability under power loss is NOT established by these process-crash tests.

## Validation scope
Linux Node 24.22.1. New tests cover three private-preparation crashes, three promotion crashes, state COMMIT before/after crashes, uncertain close, unexpected file, and deterministic interleaving. Existing fault-injection tests updated to assert no fixed-path promotion before preparation succeeds. Windows final CI remains required; this report does not substitute Linux for Windows.

Frozen source validation: full suite **211/211**, zero failed/skipped; preregistered 20 repeated cold tests **20/20** (each internally has 5 projects × 5 processes). Full build passed. Independent reviewer separately ran 20 × 6 barrier-synchronized fresh processes, all succeeded.
