# Bounded sync deletion: validation and performance

Date: 2026-10-27. Environment: Windows x64, Node 22.23.3, local disk.

## Separate changes

- `e7e53fe`: bounded WAL contention retries and durable caller recovery.
- `2013ef0`: committed removal progress and per-operation/checkpoint timing.
- This change: bounded multi-file removal transactions on top of both fixes.

The production baseline is the compiled `2013ef0` diagnostics runtime. The
candidate is a clean tracked-source build plus the removal implementation,
not the earlier JavaScript-only experiment. Source/test SHA-256 values were
checked against the compiled candidate before the final benchmark.
Unrelated untracked experiments, including a file referencing absent
`src/context/entry-points`, were excluded from the build and left untouched.

## Admission and protection

The batch limit is 16 files, 128 nodes, 512 combined node/incident-edge/owned-ref
rows, and 128 KiB of measured text/record/journal work, cumulatively. All core
variable-length fields are included; oversized fields are tested explicitly.
Statements are prepared lazily, and noop/single-file/disabled-valve syncs do not
perform admission probes. The policy uses the active valve and real database
WAL observer, not a reconstructed environment value or database filename.

Near `cap - min(64 MiB, cap/4)`, and for heavy or late-detected removals, the
original single-file/worker path remains. A transaction checks visible WAL
after each file and stops adding files on pressure or the 25ms cooperative
target. Every commit passes through the unchanged WAL gate before new writes.
There is no checkpoint or await inside a batch. The default boundary cap
remains 512 MiB, and persistent contention still fails closed.

Proof invalidation, pending refs, legacy caller journals, and deletions share
one transaction. Commit advances progress; rollback does not. Callers queued
for later deletion are still recoverable if sync stops before reaching them.

These bounds constrain work, not exact SQLite dirty-page bytes. The 25ms
target does not interrupt a running SQLite statement. Neither the old file
transaction nor the new bounded batch promises zero byte overshoot at commit.

## Final production comparison

Same source snapshot: 400 target headers, 400 retained caller files, then 300
target headers removed. Diagnostic soft threshold 8 MiB, physical boundary
16 MiB for both versions. The test uses real SQLite transactions and
checkpoints. AB / BA / AB runs were sequential, without concurrent builds or
functional tests. Three pairs are local samples, not population estimates.

| Metric | Diagnostics baseline | Production batching |
| --- | ---: | ---: |
| Whole sync samples (ms) | 5269, 4258, 4470 | 4640, 3702, 3661 |
| Whole sync median (ms) | 4470 | 3702 (-17.2%) |
| Removal samples (ms) | 1281, 1044, 1084 | 478, 438, 375 |
| Removal median (ms) | 1084 | 438 (-59.6%) |
| Explicit main-connection COMMITs | 906 | 25 |
| TRUNCATE calls | 5 | 2 |
| Observed positive WAL allocation growth | about 60.18 MiB | about 8.81 MiB |

Positive WAL file-size growth is not total physical disk writes: file reuse
can hide writes from this observation. Both versions take the same scan route.
Every pair improved, and all six normalized node/edge-metadata/reference-state/
file snapshots are equal. Each following no-change sync converges with no
deletions. The production probe is more conservative than the prototype and
its real admission overhead is included in these results.

## Correctness and recovery

The final source combination compiled successfully and passed 96 tests across
11 files. These include whole-batch rollback; stamped and legacy caller edges;
two consecutive abort/reopen cycles; a later caller reappearing; target re-add;
old proof/journal rollback; oversized payload and worker fallback; unknown
late-removal totals; progress only after commit; bounded retries; real SQLite
readers; actual store-worker boundaries; and automatic watcher sync.

The actual built CLI also passed a generated-project smoke test that observes
both `Removing stale index entries` committed counts and an over-cap
`checkpoint-detail` result. Source files retained in the project remain intact.

Real low-cap/default-cap reader results and their normalized graph checks are
recorded in `artifacts/wal-delete-batching-20261027/benchmark/production/`.
The default-cap pressure setup uses real source updates to fill the WAL before
the deletion; that preparation is excluded from deletion performance and is
not represented as a naturally accumulated single sync.

| Final-production real-reader case | Observed result |
| --- | --- |
| Near the 16 MiB diagnostic cap, reader held about 2s | Pauses, then completes in the same sync after release |
| Reader held indefinitely above the diagnostic cap | 21 blocked attempts, abort after about 10.011s; no batch writes while blocked |
| Release that reader, close/reopen and retry | Completes the remaining 294 removals; 12 pending refs become zero |
| Default 512 MiB cap, real updates prefill WAL to 535,946,112 B, reader held 2013ms | Six near-cap single-file removals; peak 537,074,992 B; pauses and then completes three batches after release |

All 11 final-production/control runs passed integrity/FK/dangling-edge checks;
5,080 retained source-file hashes were verified. Normal, short-reader and
abort/reopen final normalized graphs agree, and their no-change syncs converge.

## Evidence and limits

- `artifacts/wal-delete-batching-20261027/production-source-verification.json`
- `artifacts/wal-delete-batching-20261027/diagnostics-cli.log`
- `artifacts/wal-delete-batching-20261027/benchmark/production/`
- Earlier mechanism/control evidence: `benchmark/summary.json`,
  `batch16-runtime-correctness.json`, `batch16-runtime-rollback-correctness.json`.

The earlier one-file atomic-transaction experiment reduced COMMIT count but
did not materially reduce WAL generation or sync time; it is not the source
of the improvement reported above. The community comparison also does not
serve as a performance baseline: its deletion loop omits the per-write cap
gate, and its WAL budget/other sync behavior differ.

The user's Linux filesystem, large existing index, and storage latency were
not reproduced. Gains are demonstrated for this workload; query-heavy storage
and larger/denser files may hit single-file fallback more often. Database
schema, extraction version, WAL retry budget and disk-boundary setting are
unchanged.
