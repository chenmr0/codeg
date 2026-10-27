# WAL contention: community and release hotfix comparison

Date: 2026-10-26. This follows the [release hotfix validation](wal-sync-contention-hotfix-20261026.md).

## Implementations

- Community: exact `f6d8f19b29e5f571ffbc557e160aabc5d8d0373a`, package 1.6.2,
  from `D:/c_proj/codegraph-ori`, compiled into an isolated experiment runtime.
  The original checkout was read-only; its existing package-lock modification
  was not changed. Its installed dependencies were reused for compilation.
- Release baseline: exact `e1c038a59fd0194c87e935b262ba764d81e45668`, package 1.1.2.
- Hotfix: the release baseline plus the seven production source changes already
  validated. Product code was not changed to obtain the comparative results.

## Real source updates with default thresholds

Windows x64 / Node 22.23.3. All implementations index C files with four
independent functions per file, then change their function-body constants.
Checkpoints, transactions, thresholds and error behavior are not mocked.
Observations wrap checkpoint calls and record their real results.

Community has two limits: growth above its last recorded checkpoint baseline
(2 x soft) and physical file size (4 x soft). Soft is at least 256 MiB and scales
with database size. Our physical cap is 2 x soft. Short readers begin just below
each implementation's observed effective boundary. This aligns checkpoint
pressure, not the same source-file ordinal or a fixed wall-clock instant.

| Same source workload / condition | Community | Release baseline | Hotfix |
| --- | --- | --- | --- |
| 3,600 files, no concurrent reader | Completes; WAL peak 835,840,912 bytes | Completes (prior validation) | Completes (prior validation) |
| 3,600 files, reader held from sync start | WAL_VALVE_ABORT at 2,327/3,600; WAL 537,066,752 | WAL_VALVE_ABORT (prior validation) | Bounded WAL_VALVE_ABORT (prior validation) |
| 5,200 files, reader held ~2s near the actual boundary | WAL_VALVE_ABORT at 4,596/5,200 | WAL_VALVE_ABORT at 2,527/5,200 | Completes all 5,200 in the same sync |

In the 5,200-file case, community fails with a physical WAL of 1,073,849,192
bytes, above its 1 GiB file cap, despite growth above its checkpoint baseline
being only about 151 MiB. The release baseline and hotfix reach the same
537,050,272-byte peak around their unchanged 512 MiB boundary. The hotfix
waits for the real reader (2,014ms hold) and then resumes, rather than enlarging
the cap or allowing writes while waiting. Reopening the release baseline after
reader release completes the remaining 2,673 files; community similarly resumes
its remaining 604 files.

Community also passes a 5,200-file short-reader case held for 505ms, after
observed checkpoint contention. Its 20-pass allowance therefore helps some
short contention, but is not a fixed time budget and did not cover the 2s case.

Two earlier 3,600-file community short-reader probes did not start a reader:
timer backfills moved its effective boundary to 1 GiB, while that workload only
reached about 797 MiB. These are explicitly marked as **not exercising
contention** and are not counted as evidence that community resolved it.

## Identical WAL-state mechanism comparison

A separate controlled experiment uses Windows / Node 24.11.1 / SQLite 3.50.4,
each version's actual valve and checkpoint implementation, and the same SQLite
fixture. Initial WAL is exactly 6,435,472 bytes in every case. Soft is explicitly
1 MiB, above both our 2 MiB physical cap and community's 4 MiB file cap. There
are no further writes while parked, and no simulated busy/null results.

This is a low-threshold mechanism experiment, not a default-cap full sync.

| Reader state | Community | Release baseline | Hotfix |
| --- | --- | --- | --- |
| None | Reclaims WAL to 0 | Reclaims WAL to 0 | Reclaims WAL to 0 |
| Prevents full backfill; release after 500ms | Exits around 499ms after 20 PASSIVEs | Exits around 138ms | Succeeds around 968ms; WAL 0 |
| Prevents full backfill; release after 2s | Exits around 492ms | Exits around 132ms | Succeeds around 2,048ms; WAL 0 |
| Full backfill possible; TRUNCATE pinned for 500ms | Succeeds around 610ms; WAL 0 | Exits around 183ms | Succeeds around 590ms; WAL 0 |
| Full backfill possible; TRUNCATE pinned for 2s | Succeeds around 2,019ms; WAL 0 | Exits around 193ms | Succeeds around 2,172ms; WAL 0 |
| Full backfill possible; TRUNCATE pinned indefinitely | Returns normally around 2,330ms, WAL still 6,435,472 | Aborts | Aborts around 10,085ms with TRUNCATE busy diagnosis |

The last community result is not data corruption, but also not successful
space reclamation: TRUNCATE returns `busy=1`, the reader remains active, and
the file is still over its 4 MiB cap. Community updates its baseline and returns.
We do not copy that behavior into a patch intended to preserve the physical cap.

The 500ms partial-backfill case was repeated three more times: community failed
3/3 at 477–480ms, release failed 3/3 at 126–133ms, hotfix succeeded 3/3 at
952–969ms with WAL 0. All 33 mechanism cases completed without a harness timeout,
passed database integrity checks and retained the same data.

## Data and lifecycle checks

Across this round and the prior clean comparison, 22 retained full-sync
fixtures / 85,600 indexed file records were verified against both actual source
content and the expected updated source: all stored SHA-256 hashes match.
This includes failed-and-resumed community and release runs, rather than only
checking graph counts or process exit codes.

An additional 50 checkpoint startup-cancellation probes on Node 22.23.3 /
Windows x64, using 1/5/20ms timeouts, returned typed timeout errors without
process crashes and passed database integrity checks. This does not validate
Windows ARM64 / Node 24's distinct worker teardown problem documented upstream.

The source regression suite now has 189 passing relevant tests across 15 files,
including three cases added after this comparison. The independent review found
no new blocking issue in the hotfix. Linux filesystem behavior and the user's
actual repository remain untested; cross-process readers held indefinitely
cannot be guaranteed to complete within a bounded wait budget.

## Implementation decision and evidence

Retain the existing hotfix: bounded contention retries, unchanged ordinary
checkpoint behavior and byte cap, typed failure diagnostics, confirmed worker
exit, and durable caller recovery. Do not enlarge the disk budget, reinstate
the growth-baseline shortcut, accept an over-cap busy TRUNCATE, or add concurrent
open-time TRUNCATE as an untested part of this fix.

Local evidence:

- `artifacts/wal-community-ab-20261026/summary.json`
- `artifacts/wal-community-ab-20261026/hash-verification.json`
- `artifacts/wal-community-ab-20261026/full-sync.cjs`
- `artifacts/wal-community-mechanism-20261026/results.json`
- `artifacts/wal-community-mechanism-20261026/results-repeat-500.json`
- `artifacts/wal-community-mechanism-20261026/compare.cjs`
- `artifacts/wal-stability-review-20261026/checkpoint-startup-stress-results.json`

Community context: [issue #1539](https://github.com/colbymchenry/codegraph/issues/1539)
and [merged PR #1751](https://github.com/colbymchenry/codegraph/pull/1751) explicitly
retain over-cap failure as the alternative to unbounded WAL growth.
