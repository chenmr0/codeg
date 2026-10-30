# FTS external-content join optimization — HOLD, not integration-ready

**Post-test blocker:** equivalence is proven only for maintained FTS indexes, not every existing public mutation sequence. See the critical limitation below. Do not treat the 72 passing tests as unconditional semantic equivalence.

Base `366b594`. Source change only: join FTS candidates directly to `nodes.rowid`, with `nodes.id IS NOT NULL` preserving old equality-join behavior for SQLite-legal NULL text primary keys. No schema changes, prewarming, ranking weights, ordering, filtering or candidate budgets changed. No phase-two integration.

Schema defines `nodes_fts` with `content='nodes', content_rowid='rowid'`; insert/delete/update triggers propagate corresponding OLD/NEW rowids. The old join reads the FTS external `id` column, which first fetches the content row by rowid, then joins by text primary key. The new join directly fetches that same row without the redundant external-content read. Rowid stays in SQL and is not converted through a JS number.

## Tests
Linux Node 24.22.1 build passed. `search-tests.txt`: 72/72 pass, no skips (existing exact search/parser/natural-language/supplement plus new native and SQL.js tests). Reproduce with:

```
npm run build
node --liftoff-only node_modules/vitest/vitest.mjs run --config artifacts/fts-rowid-20261030/vitest.config.mts
```

New tests compare both the FTS stage and full search outputs against the original text-ID join, including BM25 scores, same-name deterministic order, filters, limit/offset, path hint, no matches; assert rowid lookup EXPLAIN; exercise insert/update/delete, text-ID changes, rowid reuse, rowids -7/0/9223372036854775806, nullable ID exclusion, FTS rebuild/integrity-check and reopen on native + SQL.js. They assert actual FTS hits to prevent fallback paths from hiding failures.

## Read-only OceanBase diagnostic
The prior analysis `benchmark-real/evidence/search-tail-analysis/native-fts-rowid-probe.json` showed the redundant lookup. This artifact independently reruns the actual final guarded patch with ABBAABBA order, freshly reopened read-only connections, five terms per experiment and complete result+score equivalence asserted against the first original run. All 40 timed queries and results are preserved in `native-abba.json`, executable script `probe.cjs`. No explicit prewarm; cache state is not controlled and later runs naturally reuse OS cache.

On this diagnostic ObServer old 122.7–130.1 ms versus new 41.5–43.7 ms. This is warm/mixed-cache standalone evidence only, not the complete-build/cutover scenario. It does not establish the full cause of the production-observed tail or close the <=1 second gate. All full-build rounds must be rerun on the next frozen version. Windows not run here.


## Critical limitation found after initial regression pass

Public `insertNode()` uses INSERT OR REPLACE. With recursive triggers disabled, replacing the same text ID allocates a new rowid without deleting the old FTS posting. This is an existing index-integrity defect, reproducible on native SQLite and SQL.js without raw database edits. The old text-ID join raises a missing-content-row error and the existing FTS catch falls back; the new rowid join skips the missing row, potentially returning different results for mixed terms. `replace-integrity-repro.cjs` and `.jsonl` preserve the actual failing equivalence case. FTS integrity-check independently reports malformed on both backends.

Therefore **aac6ff0 must remain an experimental candidate, not a ready-to-integrate optimization**. We did not change trigger/migration behavior to hide this difference.

A possible compatibility guard detects matching orphan postings through a rowid LEFT JOIN and executes the exact original query if any exist. `orphan-check-cost.json` preserves a 3-round read-only native cost diagnostic: the guard remains selective and has plausible cost. However, separate precheck and optimized query can see different snapshots during concurrent writes. Making the guard safe needs a shared read transaction or a single-statement conditional UNION/CTE, plus new concurrency and performance validation; that is not part of this minimal substitution. No such guard is implemented or approved here.

Recommendation: hold this FTS optimization; retain the already independently validated exact-name expression-index optimization and explicit stage timing as the minimal safe alternative. The wider integrity fix or guarded-query design requires separate scope and review. Full-build/cutover gate remains open.
