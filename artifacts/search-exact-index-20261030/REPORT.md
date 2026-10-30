# Exact-name supplement: remove avoidable full name-index scan

Base: f41b859; this is a minimal query-only change, not phase-two fixed-path integration.

For ordinary search terms the supplement now uses `lower(name) = lower(?)`, allowing the existing `idx_nodes_lower_name` expression index. SQLite's built-in lower and NOCASE both fold only ASCII; this is not JS Unicode lowercasing. Terms containing NUL retain the old NOCASE expression because equal-byte-length strings with different tails after NUL compare equal under NOCASE but not lower(). No schema/index migration, candidate count, ranking, ordering or filter change.

Linux Node 24.22.1 build passed. New 4 regressions pass on native SQLite and SQL.js: full ranked results vs old predicate with kind/language/path/name filters, offset/limit/path hint; expression-index EXPLAIN; ASCII/non-ASCII/embedded NUL semantic matrix. Tests inspect SQL emitted by the actual search method rather than testing a detached new SQL string. SQL.js WASM initialization in Vitest disables fetch only while loading the local WASM file, following existing suite fixtures.

`probe.cjs` is an independent native read-only OceanBase microbenchmark: 5 paired, alternating-order repeats for each of ObObj/ObString/ObServer, complete row equality asserted, original deterministic ORDER BY and LIMIT 20 retained. All 15 pairs retained in native-probe.json. Input is the preserved full B graph under bounded-2-timeout180/init-b-data, not a new cutover run. Plans: old scans idx_nodes_name; new searches idx_nodes_lower_name. Cache state is not controlled; this is mechanism evidence, NOT proof of the 902ms observed tail's cause or closure of the <=1s full-build gate. No Windows execution claimed.

Existing exact-search, parser, natural-language and new supplement suite: **68/68 pass**, no skips. Reproducible command: `node --liftoff-only node_modules/vitest/vitest.mjs run --config artifacts/search-exact-index-20261030/vitest.config.mts`. Explicit fork config passes `execArgv: ['--liftoff-only']`; an initial attempt to specify this array through a CLI scalar stalled before any test and was interrupted (aborted-cli-config.txt), not counted as a pass. Actual completed output is search-regressions.txt. Build output is build.txt.

All 15 native microprobe old timings: 36.53–39.06 ms; indexed 0.199–1.397 ms. Again, this does not explain the entire 902 ms search tail nor substitute for retained full-build repetition.
