# Frozen integrated Linux validation

- Frozen source commit: `d0e16ede592194a64e9ee8de557b9d53a7ea00f4`.
- `npm run build`: passed.
- `node scripts/prototypes/fixed-path/run-source.mjs`: **223/223 passed, 0 failed, 0 skipped**, 83.816 s. Source runner includes all 31 root test modules.
- Registered cold repeat: **20/20 test invocations passed**, each internally executes 5 fresh projects × 5 independent participants. Every attempt retained. These repetitions ran concurrently with the latter portion of the full suite (rather than sequentially as plan prose stated); no result was discarded or substituted. Not an isolated performance comparison.
- `git diff --check`: clean.
- Candidate cleanup and bootstrap changes affect distinct protocol functions; cherry-picks had no conflict. No production `src/` changes introduced in this integrated patchset.

Full raw output, environment and crash traces are retained under `linux/`; build output, full suite copy and all repeat stdout files are adjacent. The cold repeats also generated original per-run metadata under `artifacts/fixed-path-prototype/linux-17933238*` and these are retained with this evidence.

Limits: exact-version Windows remains required. Real large-repository three full cycles remain required. Retained private bootstrap directories after a process crash are explicitly **not automatically reclaimed**; partial fixed-lease promotion fails closed, not automatically repaired. No power-loss durability claim. Prototype only, not phase-two production integration.
