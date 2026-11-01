# Linux native Git path resolution below 50,000 candidates

Base: `0ef5890143eeb54023bba541658abd4d91d15054`. Branch: `fix/noop-sync-planning`.

The independent OceanBase experiment reported that the preceding unchanged gate reduced the f265 median from 5.318 s to 4.723 s, with overlapping ranges; it remained above the earlier old-version result. Those are external observations, not measurements reproduced in this executor. This follow-up first diagnosed the remaining cost, then tested an existing opt-in backend before changing automatic selection.

## Diagnosis and design

On the isolated 14,253-source-file fixture, diagnostic worker attribution found roughly 433 ms in planning enumeration and 377 ms in execution enumeration. The planning worker took 925 ms overall; the execution scan worker took 486 ms including startup. Ordinary macro/recovery preflight took about 2 ms. These are instrumented attribution observations, not benchmark samples.

The existing native realpath backend was gated by the same 50,000-candidate threshold as the Rust ignore helper. Native realpath is a Node filesystem API and has no external helper startup cost. The read-only `benchmark-git-paths.mjs` compared exact path strings and order before timing:

| Fixture | Raw Git candidates | Enabled source files | Legacy scan median | Native scan median | Exact path/order parity |
| --- | ---: | ---: | ---: | ---: | --- |
| Nested C fixture | 14,254 | 14,253 | 403.46 ms | 275.04 ms | Yes |
| Current repository | 815 | 3 under default language scope | 42.98 ms | 36.14 ms | Yes |

Each used five interleaved observations per backend after verify. Verify reported zero path mismatches. These scan-only times exclude process/module startup and database reconciliation.

Before changing code, seven interleaved full default-CLI observations on the exact same 0ef implementation compared the existing `CODEGRAPH_GIT_REALPATH=native` override with its unset default. Medians were 1.819099 s and 1.559926 s respectively, a 14.25% reduction in this fixture. All commands reported already up to date and graph row hashes were unchanged.

The production change is only the automatic selector: nonempty ordinary Git candidate sets use the existing native backend on Linux. The Rust ignore threshold remains 50,000; Windows/macOS automatic behavior, explicit legacy/off/unknown-value rollback, explicit native/verify settings and empty-input behavior remain unchanged.

No new resolver, parent-path inference, inventory cache, snapshot reuse or source fast return was introduced. Every candidate still receives complete path resolution, logical ignore matching precedes canonicalization, and source extension filtering follows canonicalization. The native-error-to-legacy fallback is unchanged. Canonicalization failures still retain the logical candidate as before; actual denied source access is rejected by planning/reconciliation, not mistaken for a deletion. The default-layout EACCES regressions passed with automatic native selection.

This change affects Git scans that previously selected legacy on Linux. A project already logging `gitPathMode=native`, a non-Git/hybrid/Rust-directory route, or an explicit `CODEGRAPH_GIT_REALPATH=legacy` setting will not receive this policy-change benefit. Native API availability failures retain legacy behavior and may remove the performance gain. Other filesystem/platform performance is not inferred from local timings.

## Final default-versus-default benchmark

Both checkouts were built. The exact 0ef base and the final candidate each ran the same default CLI with `CODEGRAPH_GIT_REALPATH` unset against an equivalent unchanged index, sequentially in fresh processes. One warm-up per version was excluded, then seven observations per version were interleaved, alternating first-run order. No other build or test task ran concurrently in this executor during final timing.

| Version | Median | Range |
| --- | ---: | ---: |
| Exact base 0ef5890 | 1.787272 s | 1.711008–1.925664 s |
| New automatic Linux selection | 1.548915 s | 1.503003–1.646787 s |

The local median reduction is **13.34%**. The fixture has 14,253 C files in nested directories, 42,759 nodes and 42,759 edges; it represents scan scale/depth, not OceanBase's complete workload. All 14 measured commands exited zero and reported already up to date. Before/after sorted-row SHA256 values matched for files, nodes, edges and unresolved_refs; SQLite integrity was ok and foreign-key checks were empty.

Two source enumerations still remain. The current execution scan must observe source and ignore changes after planning/callbacks/recovery; this patch does not change that contract. Worker startup, planning metadata/control checks and ordinary reconciliation remain measurable costs. No claim is made that the complete OceanBase regression is resolved, or that a single scan now suffices.

## Correctness verification

Environment: Linux x86_64, Node v24.19.0, npm 11.9.0, non-root uid 1000.

- Build and strict production `tsc --noEmit`: passed.
- Path/canonicalization/symlink/scan/metadata suites: **109 passed**, five files.
- Adaptive planning, unchanged gate, deletion, entrypoints, integration, completeness and retry suites: **176 passed**, eight files.
- Default-layout built-runtime behavior: **17 passed**, zero skipped.
- Existing fullHash catch-up and async scan suites: **25 passed**, zero skipped.
- Supported-runtime cross-process admission suite: **6 passed**, zero skipped.
- CI-equivalent Linux planner/path step: **48 passed**, zero pending/todo/failed; includes actual native/legacy EACCES parity, alias chains, dangling/cyclic links, case-sensitive/Unicode names, explicit rollback, native failure fallback, real Git exclusions/embedded repositories, and exact path/order comparison.
- The expanded path suite on the exact base: **4 failed, 27 passed**. The four failures are the changed automatic policy and the three unset/empty/auto real small-candidate cases, demonstrating that tests distinguish the new default.
- The first scan-suite run found an existing mock bug: replacing `realpathSync` discarded its `.native` property, causing database-open failure. The exact base reproduced it (1 failed, 25 passed). The test mock now retains the real native API; no production admission rule or test assertion was relaxed. The final five-suite run passed all 109 cases.

CI's existing Linux boundary step now includes the Git path suite and still rejects pending/skipped tests. The actual Linux-specific leaf-link test is Linux-only; the real POSIX permission test skips on Windows/root in standalone runs. Selected final Linux runs had no skips. The cross-platform CJS regression step remains in place.

No full repository suite, Windows/macOS runtime acceptance, other Node-version matrix, Rust helper rebuild, or OceanBase timing matrix ran here. YAML and diff checks passed. PowerShell and GitHub-hosted CI execution were not available locally. No user worktree/index was modified, and no merge or release was performed.

## Reproduction and independent OceanBase retest

The adjacent `linux-native-path-evidence.tar.gz` includes raw logs, all timing observations, checksums, diagnostic wrapper and fixture/benchmark scripts. The earlier diagnostic runs are separated from final uninstrumented timings.

After installing locked dependencies and building both checkouts:

```sh
node scripts/benchmark-git-paths.mjs /absolute/isolated-fixture 5
node --liftoff-only /absolute/checkout/dist/bin/codegraph.js sync /absolute/isolated-fixture
```

For the saved synthetic fixture and timing method:

```sh
node --liftoff-only noop-remaining-evidence/create-fixture.cjs /absolute/base-checkout /absolute/new-fixture
node noop-remaining-evidence/benchmark.cjs 7 /absolute/base-checkout /absolute/candidate-checkout /absolute/new-fixture
```

Use separate untimed `--verbose` invocations to record `mode`, `gitCandidates`, `gitPathMode`, `gitPathMismatches` and fallback fields. Do not mix verbose or instrumented samples into ordinary CLI timings. In the OceanBase environment, first confirm that the prior default was ordinary Git with `gitPathMode=legacy`; if it was already native, this change cannot explain any speedup. Preserve source/index state and verify graph counts/integrity as in prior measurements.

Only the authorized Git branch is used to deliver these artifacts. Library upload was not retried.

Archive: 31709 bytes; SHA256 `9a76b35deaaacfc4d469b2d597d3818a0c6857ca630d3b08fa59f80c88cd2348`. Internal SHA256SUMS covers 36 evidence files.
