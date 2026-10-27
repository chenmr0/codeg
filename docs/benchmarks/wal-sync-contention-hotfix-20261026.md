# WAL sync contention hotfix validation — 2026-10-26

## Scope and baseline

- Release baseline: `release/1.1.2-chinese`, `e1c038a59fd0194c87e935b262ba764d81e45668`.
- Candidate: the same release sources plus the WAL retry/error and caller recovery changes.
- Runtime: Node 22.23.3, Windows, local disk. The user's Linux filesystem and repository were not available.
- No schema or extraction version change; no threshold increase, removal of WAL protection, or global switch to automatic checkpointing.
- A clean release-source candidate was compiled with TypeScript. Its seven modified/new production source files match the workspace by SHA-256.
- The workspace also contains an existing untracked `src/mcp/cpp-explore.ts` referencing an absent `src/context/entry-points` on this release branch. Direct workspace `tsc --noEmit` encounters that unrelated error. The isolated build excludes unrelated untracked experiments and succeeds.

## Behavior

The normal first PASSIVE/TRUNCATE attempt and advisory timer retain the existing
60-second worker cancellation timeout. Once a retryable blockage is observed
above the byte cap, the writer stays paused for a bounded retry budget, default
10 seconds. Retry delays grow from 50ms to at most 500ms. The original 512 MiB
write-boundary cap remains in force.

The error retains `WAL_VALVE_ABORT` and now includes mode, reason, frame counts,
attempts, waited time and the original error where available. SQLite permanent
errors above cap abort without spending the contention retry budget. Actual
worker exit is required before resolving or rejecting a checkpoint.

Unstamped old edges that cannot be reconnected now create durable caller
re-extraction tasks in the same transaction that deletes the old target. These
tasks survive reopening and further interruptions. Successful sync acknowledges
only the recovered generation. A missing database file record does not imply
the source was deleted; scoped recovery checks the source before retiring work.

## Functional validation

189 relevant tests across 15 files passed on the independent candidate:

- WAL retries, real short/persistent readers, error classification and worker lifecycle.
- Real store-worker commit boundaries and sync deferral policy restoration.
- Normal and unstamped caller edges, target deletion/re-addition, reopening,
  a second interruption, transaction rollback, missing file rows, read failures,
  and default append-delta interaction.
- Existing retry, append-delta, node retention, graph identity and legacy-index suites.
- Watcher scheduling and a new automatic sync test with a real over-cap WAL,
  reader release after 500ms, no error callback and correct final nodes.
- Following the community comparison: partial progress cannot reset the retry
  deadline, a typed TRUNCATE busy error can recover, and complete backfill with
  a real reader still pinning TRUNCATE cannot release an over-cap writer.

An initial new read-failure test did not intercept Vitest's imported filesystem
binding. Its injection was moved to the extractor's `read_error`/`stored:false`
contract, preserving assertions that sync fails, retains work, then restores the
call edge. That test and the whole recovery file passed on rerun. The remaining
184 tests passed on their initial candidate run; the added watcher test passed.
The three later regression cases passed with the entire 18-case valve suite.

The subsequent exact-community comparison, matched-pressure tests and source
hash verification are recorded in [the community comparison](wal-community-comparison-20261026.md).

## Default-cap reproduction and performance

Each benchmark starts from 3,600 C files, four functions per file, 18,000 graph
nodes and 14,400 edges. Source function bodies are changed normally; there are
no unrelated table writes, injected checkpoint errors or lowered WAL thresholds.
The initial database size is 13,778,944 bytes for both implementations.

Performance used alternating AB / BA / AB runs, without concurrent functional
tests. All samples are milliseconds:

| Workload | Baseline samples | Candidate samples | Baseline median | Candidate median |
| --- | --- | --- | ---: | ---: |
| One changed file | 516, 522, 505 | 500, 495, 530 | 516 | 500 (-3.1%) |
| 3,600 changed files | 12,185, 12,315, 12,370 | 12,548, 12,857, 12,973 | 12,315 | 12,857 (+4.4%) |

These are three local samples, not a population latency estimate or proof of
zero overhead. Workload/configuration, changed paths, node counts and final
progress were checked for equivalence. Checkpoint call counts were not measured.

| Default-cap contention scenario | Baseline | Candidate |
| --- | --- | --- |
| Idle read-only connection | Completes | Completes |
| Reader held about 500ms near the cap | Aborts 159ms after crossing cap | Completes in the same sync |
| Reader held about 2s near the cap | Aborts 139ms after crossing cap | Completes in the same sync |
| Persistent read transaction | Aborts 146ms after crossing cap | Aborts after 10,032ms with diagnosis |
| Release persistent reader, reopen and sync | Completes in 5,016ms | Completes in 4,791ms |

The persistent-reader candidate fails at file 2,554/3,600 with
`wal=537000832, cap=536870912`, `PASSIVE busy`, `log=130340`,
`checkpointed=0`, `attempts=21`, `waited=10000ms`. No further writes grow the
WAL while paused. Reopening after releasing the reader finishes the remaining
1,046 files. All benchmark scenarios finish with zero pending journal/reference
rows, `integrity_check=ok` and no foreign-key errors.

The short-reader tests deliberately overlap the cap; their durations do not
estimate the frequency of this overlap in ordinary MCP use. Worker termination
can exceed a cancellation deadline under uninterruptible OS I/O; the writer
must continue waiting for confirmed exit in that case.

## Local evidence

Artifacts are under `artifacts/wal-hotfix-validation-20261026/`:

- `candidate-source-verification.json`: candidate/workspace source hashes.
- `comparison-20261026-171240/summary.json`: complete benchmark summary.
- `comparison-20261026-171240/equivalence.json`: workload equivalence.
- `comparison-20261026-171240/pinned-candidate.json`: bounded abort and recovery.
- `benchmark.cjs`, `run-comparison.ps1`, `summarize.cjs`: experiment harness.

The earlier `comparison-20261026-170650` run is marked discarded because it
overlapped functional tests and is not included in any result above.
