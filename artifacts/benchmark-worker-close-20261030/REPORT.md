# Benchmark worker: leased statistics and normal close

Baseline `878442d970b33cae615d743995fdaac4c173b2c1`; isolated worktree `codeg-benchmark-close`. This change affects the benchmark harness only. `protocol.mjs` is unchanged.

## Confirmed harness defect

The benchmark `sync` worker closed its participating graph, then opened the active database again via raw `graphAt(..., {readOnly:true})` to collect statistics. This read did not hold the protocol's connection lease. A final read-only WAL connection can leave empty WAL/SHM files; the subsequent offline-overwrite readiness check correctly refused them. The `plan` branch also used a raw active-path reader.

Two small real-worker checks independently demonstrate the old bug:

- Original worker completes `sync` but leaves an active `-wal` file; the offline readiness assertion fails (`baseline-sidecars.log`).
- A preload assertion inside the actual `CodeGraph.getStats()` can obtain an exclusive connections lease, proving that statistics bypassed protection; the old worker fails (`baseline-unleased-stats.log`). This injection tests lease protection, not an alternate implementation of statistics.

## Fix and boundary

Active-path planning and statistics now run through a read-only `Participant.request()` and its normal `Participant.close()`. Final sidecar cleanup is performed by the **existing** protocol close path, under its gate and connection fence, using SQLite checkpoint/close. No manual WAL/SHM deletion and no special cleanup added to the offline-ready check.

A detached `init` destination remains a standalone, already sealed public snapshot and can be read directly. The regression asserts that reading its statistics does not introduce sidecars. Operation timing remains captured before post-operation statistics, as before; whole-worker time includes the actual participating statistics and shutdown.

## Executed Linux validation

- `npm run build`: passed (`build.log`).
- New actual benchmark-worker regression: two complete cycles of public-file offline copy → modified incremental sync → plan → real rebuild → source verification → next public-file copy. Every step requires no active WAL/SHM/journal and all leases released; no test-side checkpoint or unlink is used. Statistics additionally assert that an exclusive connections lease cannot be acquired during the real query. Both rebuilds are asserted to occur, not no-change shortcuts.
- Existing real CodeGraph repeated public import/incremental/automatic rebuild/query/sync regression remains passing.
- **2/2 tests passed, zero skipped**, full log and existing graph-cycle evidence retained.

This does not rescue the stopped three-round OceanBase run: its original block and results remain evidence. A new frozen revision must rerun all three full rounds. Linux tests are not a Windows substitute; the new worker lifecycle regression is included in `run-source.mjs` for CI.
