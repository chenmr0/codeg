# OceanBase real-repository prototype validation — 2026-10-29

## Conclusion

The final **isolated prototype** run passed the observed normal-load gate on Linux at `6ccced4276a0274cbdb7ab37752f5037bf1c5061`. Five processes completed 10,187 / 10,187 scheduled requests with **zero errors, zero backlog, zero mixed file-identity reads, and zero missing search-result nodes**. All five reopened onto B. The actual operation ended `published` → `verified-observation`, with complete index status. This is not production CLI/MCP/daemon integration or power-loss qualification.

A real large-database cold-open issue was found in the earlier `11ea183a` run (one `database is locked` query). The original gate held the expensive graph constructor. Fixed three-round, five-process comparison reproduced 5 failures / 15 old requests; the lease-first, constructor-outside-gate version passed 15 / 15. Maximum gate action went from 171.24 ms to 0.52 ms. This failure is preserved rather than discarded as environmental flakiness.

## Repository and environment

- OceanBase A / 4.3.5: `7e2de11a0e3c328dddaaaefedd6e911be36fb58d`.
- OceanBase B / 4.4.x: `9bdfa9e22b618cc4ad0a724010b1bb9567629399`.
- Real full-tree checkout, not synthetic subset: 8,431 Git-changed files; adaptive source check reports 8,004 indexed changes. B has 13,565 indexed files.
- Linux 6.18.55, AMD EPYC 9V74, 9 visible CPUs, ~9.9 GB RAM, Node 24.22.1.
- All languages enabled; parse/resolve/Rust macro workers each 2; parse timeout 180,000 ms.
- Five independent protocol-adapter query processes, fixed scheduled 500 ms interval each (10 total QPS), file identity → search → getNode → file identity. Stop finishes admitted requests and explicitly counts unserved scheduled arrivals.
- Complete A was built normally and sealed as one standalone database; no ownership or completeness markers were forged.

## Final complete rebuild (normal load)

| Stage / measure | Observed |
| --- | ---: |
| End-to-end operation | 1,012.512 s |
| Candidate build | 937.743 s |
| Candidate validation | 50.684 s |
| Pre-publish checkpoint | 2.501 s |
| Drain | 88.457 ms |
| Final checkpoint | 0.350 ms |
| File replacement | 4.639 ms |
| Publisher reopen | 0.356 ms |
| Request resume | 3.813 ms |
| Total admission pause | **101.723 ms** |
| Initial / post-publish source check | 5.950 / 7.345 s |
| Query service p50 / p95 / p99 / max | 125.78 / 217.92 / 257.17 / **840.40 ms** |
| Scheduled latency max (includes queueing) | **840.73 ms** |
| Sampled peak database-directory disk | 6,458,736,692 bytes |
| Sampled peak process-tree aggregate RSS | 5,190,332,416 bytes |

Pause is a subset of publishing, not a separate additive stage. Stage rows do not exhaust setup/fencing/record-writing overhead. Publisher reopen is not all five reader constructors; reader reopen durations remain in raw client logs. All observed absolute query waits were below one second, so observed extra switching wait was also below the proposed one-second bound. A single successful run is not a universal latency guarantee.

The final graph has 812,129 nodes, 5,362,580 edges, 13,565 files and a 3,385,122,816-byte database, matching independent full-init counts. Counts are not exhaustive semantic equivalence proof. After publishing, no old/candidate database remained; only four protocol coordination SQLite files were present in `.runtime`.

## Init / ordinary incremental comparison and limitations

- Fresh A init: 910.965 s, complete.
- Fresh B init: 913.769 s, complete, no concurrent query load.
- Ordinary A→B `sync({adaptive:false})`: 1,884.518 s, **incomplete** (`synthesis_skipped_memory`, insufficient heap headroom). It is not a successful equivalent result or valid speedup denominator. Under the earlier intentionally overloaded 50-QPS run, it also exposed 5 cross-call file-identity changes and 9 search/getNode misses. Those are same-generation incremental consistency observations, not cross-generation mixing.
- Earlier 50-QPS idle achieved only ~34 QPS and built a queue; its scheduled latency cannot be used for the normal short-query gate. It is preserved separately in `summary.json`.
- The ordinary-sync/stress version differs from the final cold-admission protocol. Full-init had no query load; no fully controlled throughput claim is made.
- Initial default-worker init was SIGKILLed; memory pressure is suspected, not proven. A later 2-worker/default-timeout init was incomplete because one macro parse exceeded 30 seconds. Ordinary repair made it complete but did not restore ownership, so it was rejected as benchmark baseline; fresh 180-second-timeout init was used instead.

## Offline override cycle

The executed sequence included standalone A offline placement → real incremental A→B attempt → standalone A placement → real full B rebuild → **another standalone public B overwrite** → fresh queries → ordinary sync. The incremental attempt's incomplete result above remains an explicit limitation, not a pass.

For the final overwrite, all processes were closed and WAL/SHM/journal absence checked. The independently initialized B file (different whole-file SHA-256 from rebuilt B) replaced the actual fixed `codegraph.db`; `.runtime` was left unchanged. Fresh five-process queries returned B with zero errors/backlog. Ordinary sync checked all 13,565 files, changed none, and completed successfully in 3.491 s without init. Evidence: `latest-normal/offline-*`, before/after runtime listings, and whole-file hashes.

### Successful continuous cycle follow-up

A further continuous cycle completed successfully: public A offline overwrite → one real `ob_server.cpp` comment edit → ordinary sync (1 modified file, 165 updated nodes, complete, **11.199 s**) → checkout B large change → validated safe B publication → public B offline overwrite with `.runtime` untouched → fresh queries and ordinary sync (13,565 checked files, no changes, complete, **3.604 s**). Queries read the expected B hash with no errors or backlog. Assertions and results are in `successful-cycle.json`.

For this lifecycle follow-up only, the candidate was **reused from the independently completed B init**, avoiding another redundant full extraction. A test-only generated copy of `source-reconciliation.mjs` substitutes precisely its `buildGraph` call with copying that standalone candidate; it leaves all completeness/source/ownership validation, fencing, publication, recovery and post-check logic unchanged. It is not a new full-rebuild performance result: copy took 3.375 s, full validation 90.533 s, and the whole follow-up publication took 114.549 s. The separate 1,012.512-s run above performed real full construction under query load. `success-cycle.sh ROOT PUBLIC_A PUBLIC_B OUTPUT` and `cached-cycle-publish.mjs` reproduce this follow-up on a dedicated clean checkout. Initial sidecars were safely checkpointed and the idle database sealed using the protocol before overwrite, not blindly deleted.

## Evidence and reproduction

The full local evidence directory `/workspace/scratch/75b00092a0fc/benchmark-real/evidence/normal-10qps-coldfix/` contains actual per-request logs, 500-ms resource samples, operation phases, source observations, code hashes, offline checks and completion markers; no database or source payload is distributed here. Raw logs (about 4 MB) are retained locally and are not included in this Git commit. `cold-open/SUMMARY.json` records the fixed three-round A/B diagnostic; full diagnostic logs remain in the local `benchmark-real/diagnostics/` directory. `summary.json` contains prior comparisons and final Boolean gate assertions.

Build this commit's `dist`, install grammars as normal, clone the pinned OceanBase commits, and use `scripts/prototypes/fixed-path/real-benchmark/worker.mjs` (`init`, `sync`, `plan`, `rebuild`, `check`) and `load.mjs` (`load ROOT OUTPUT idle|rebuild|sync`). Set the environment listed above and `BENCHMARK_QUERY_INTERVAL_MS=500`; wrap commands with `measure.py ROOT OUTPUT_PREFIX COMMAND...`. Keep evidence outside the source tree. Reuse the same normally generated, sealed A snapshot for each A→B comparison; never copy live WAL databases. `cold-race.mjs ROOT OUTPUT` performs three fixed five-process cold openings of an already complete active database; `COLD_PROTOCOL` can select a frozen previous protocol module.

Resource limits: disk/RSS are **500-ms sampled peaks**, not instantaneous bounds. Disk scope is `.codegraph-wx`, excluding external baseline archives/source; RSS sums process resident sizes, not unique physical pages. Earlier ordinary-sync/idle process discovery was incomplete, so their multi-process RSS/CPU/IO is not valid. Final sampling traverses `/proc` parent links correctly. Only Linux large-repository performance is measured here; Windows synthetic/cold-open CI is reported separately. The five roles use real extraction/query objects through protocol adapters, not yet production entrypoints. Conditional eventual source convergence remains the contract; no strict source snapshot instant or power-loss durability is claimed.
