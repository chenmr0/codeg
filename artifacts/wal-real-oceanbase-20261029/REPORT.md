# WAL coordinator / real OceanBase — 2026-10-29

## Verdict: functional publication succeeds; complete performance gate NOT passed

Frozen code `ae76291ac273b2b90824cb5a03122d85e5cb9b2c` performed an actual complete A→B build, validation, fixed-path publication and source post-check under five-process 10-QPS query load. It ended `published` → `verified-observation`, complete. All **9,429 / 9,429** requests completed with zero errors, pending arrivals, mixed identity reads or missing search nodes; all five readers reopened and observed B. However two first-new-database requests took **1,267.64 ms** and **1,055.43 ms**. The short 94.60-ms admission pause alone is NOT sufficient to claim the one-second end-to-end switching budget passed. No phase-two integration was performed.

## Isolation and fixture

A new local shared clone with a genuine `.git` directory was checked out at OceanBase B `9bdfa9e22b618cc4ad0a724010b1bb9567629399`. Only the trusted complete standalone A database (A `7e2de11a0e3c328dddaaaefedd6e911be36fb58d`) was placed in its fixed `.codegraph-wx/codegraph.db`. At startup that was the only graph-directory file; the WAL coordinator runtime was fresh. No old coordinator runtime was converted. Code/source/database hashes and initial layout are included.

A prior separate Git worktree attempt was **blocked**, not passed: the existing adaptive planner treats `.git` as a directory and reads `.git/info/exclude`, causing `ENOTDIR` when `.git` is a worktree indirection file. No build/publication happened, and old A stayed complete and queryable. This compatibility defect remains open; switching to an independent clone is a disclosed fixture change, not a fix.

Environment and workload match the earlier Linux experiment: Node 24.22.1, 9 visible CPUs, ~9.9GB RAM, all languages enabled, parse/resolve/macro workers 2, 180s parse budget, five real graph protocol-adapter clients at 500ms scheduled intervals each. Production CLI/MCP/daemon entrypoints are not yet integrated.

## Measurements

| Measure | Observed |
| --- | ---: |
| Complete operation | 937.252 s |
| Actual candidate build | 864.758 s |
| Validation | 52.068 s |
| Pre-publication checkpoint | 2.357 s |
| Drain | 89.412 ms |
| Final checkpoint | 0.359 ms |
| File replacement | 1.808 ms |
| Publisher reopen / resume | 0.656 / 0.088 ms |
| Admission pause | 94.602 ms |
| Initial / post-publication source check | 5.997 / 5.182 s |
| Service p50 / p95 / p99 / maximum | 111.28 / 187.53 / 215.23 / **1267.64 ms** |
| Scheduled latency maximum | **1266.49 ms** |
| Idle p95 / maximum | 166.45 / 178.74 ms |
| Sampled peak graph-directory disk | 6,459,235,732 bytes |
| Sampled aggregate process-tree RSS | 5,052,600,320 bytes |

The result has 812,129 nodes, 5,362,580 edges, 13,565 files and 3,385,122,816 database bytes: counts match independent B init. This is not exhaustive graph semantic comparison. Disk/RSS are 500-ms sampled peaks, not instantaneous bounds; graph-directory disk excludes source and external baseline archives; aggregate RSS is not unique physical memory. Timings are one run and are not a performance-improvement promise relative to earlier versions.

## Tail diagnosis — unresolved

`switch-query-breakdown.json` joins per-request rows to equally sized per-request admission arrays. The slowest request began 51ms after `resumed`: 1,267.64ms total = **135.91ms admission/reopen + 1,131.73ms after admission**. The other slow request is 213.83ms admission + 841.60ms after admission. No request admission itself exceeded 214ms. The slowest client ran `ObServer`; its preceding 30 same-pattern requests had median 162.04ms (difference 1,105.61ms), which is indicative rather than a paired causal control.

Protocol cleanup hashes the entire old ~3GB database synchronously after resume, before emitting its cleanup hook. Both slow requests overlap that interval. A separate **diagnostic-only** copy of the code added hash start/end hooks and query substage timing, and reused a previously complete B candidate instead of repeating extraction; all validation and publishing checks remained. It measured a **2,157ms old-database hash**, but did **not reproduce the slow request**: max338.09ms, mainly175.48ms admission +161.90ms search, finish<1ms. The first-new query pattern and memory/cache state differ from the full build. Therefore old-hash I/O contention is a candidate explanation, not an established sole cause; the fast cached run cannot override the failed full-run tail gate. No cleanup check was removed or deferred in that diagnostic.

### Bounded follow-up matrix: no causal reproduction

Exactly one normal-cleanup and one deferred-cleanup diagnostic run were then executed, both reusing the complete B candidate and forcing **each client's first B query to `ObServer`** at the same five-process 10-QPS load. Normal cleanup: max408.87ms, old-backup hash2221ms. Deferred cleanup: max353.35ms; cleanup waited625ms for all five first-B query completions, then performed the unchanged identity hash (2195ms) and automatic deletion. Both ended verified with zero query errors. The wait was bounded to10s with fail-and-preserve behavior, and existed only in the diagnostic worktree.

**Neither run reproduced the original 1.268s spike.** The bounded experiment stops here: it does not establish that deferred cleanup fixes the cause, does not supersede the full-build tail failure, and is not installed as the default. `matrix-summary.json` contains every first-B request's search/admission/finish timing and hash event boundaries; `diagnostic-only.patch` records the isolated instrumentation/candidate-reuse/deferred-cleanup changes. Full-build retained memory and page-cache state differ from these cached-candidate cases.

## Evidence

Compact summaries, exact hashes, initial layout and switching-request breakdown are committed here. Full local logs are retained at:

- `/workspace/scratch/75b00092a0fc/benchmark-real/evidence/wal-ae76291-clone-normal-10qps/` — real full run, five client traces, resource samples and operation phases.
- `.../wal-ae76291-normal-10qps/` — blocked worktree attempt.
- `.../wal-ae76291-profile-cached/` — diagnostic-only patch, hashes, full query substage logs and hash hooks.
- `.../wal-ae76291-matrix-normal/` and `.../wal-ae76291-matrix-deferred/` — the two bounded first-B ObServer diagnostic cases.

These raw directories are local evidence, not purported downloadable Git links. Reproduction uses the existing `scripts/prototypes/fixed-path/real-benchmark/` harness. The diagnostic has its own `codeg-wal-profile` worktree; the frozen tested code was not edited. The previous continuous offline-overwrite cycle was tested on an earlier coordinator version and is not silently claimed as rerun on this WAL version. Worktree compatibility, the observed switching tail, production entrypoints and power-loss durability are not declared closed.
