# Single-DB portability validation

Date: 2026-11-01. Base: `ad25a497101d83fad11877233a53679f90ac7237`.
Branch: `feat/portable-single-db`. Linux x64, Node v24.19.0.
No user indexes were used. No merge, release, npm publication or heavy performance
matrix was performed. See [design and operating limits](../design/portable-single-db.md).

## Result

A new portable fixed-path index carries identity, snapshot revision and import
verification in its business DB. A complete offline replacement in an existing
registered domain is adopted under exclusive OS leases and receives full-hash
catchup. Existing publication catchup is preserved. Missing sources cannot silently
empty the imported index through sync. Source-owned indexes still rebuild; unknown
custom content is preserved and remains ineligible for automatic replacement.

DB-only and missing-runtime imports require `migrate-storage --offline` before
mutation. Queries of a DB-only portable root remain read-only. This is deliberate:
there is no independent stable arbitration namespace proving that old processes
with deleted runtime files have exited. Partial/unknown coordination, unresolved
publication, nonempty import logs, incomplete or corrupt images fail explicitly.
Native close failures retain handles and leases until the process exits.

## Executed checks

- `npm run build`: passed on the final production files (includes TypeScript check
  and asset copy). `git diff --check`: passed.
- Eight CJS production suites: **215 passed, 0 failed, 0 skipped**. Includes
  portability, post-publication catchup, production SDK/CLI, no-op planning,
  initialization, layout, reclamation and writer-open admission.
- Final `npm run test:portable-single-db`: **20 passed, 0 failed, 0 skipped**, after
  adding the final pre-open regular-file/sidecar checks. Eighteen of these overlap
  the 215-case run; counts are not additive independent cases.
- Six Vitest suites: **130 passed, 0 failed, 0 skipped**. Source ownership, actual
  official legacy provenance, adaptive planning, WAL worker lifecycle, SDK reader
  retirement and same-generation reader cache.
- A separately built, unmodified **1765271** SDK created a real one-file Python
  index. Current code registered it offline, completed catchup, retained exact
  legacy structural provenance, then automatically rebuilt after 140 additions.
  Final graph contained 141 files. No source-ownership proof was fabricated.
- Remote branch absence was checked before creating the independent branch.

The portable suite is wired into the existing fixed-path production workflow and
has a package script. The workflow's existing push filters were not broadened;
its Windows/Linux matrix was not dispatched in this session.

```sh
npm run build
npm run test:portable-single-db
node --liftoff-only --test \
  scripts/tests/fixed-path-catchup.test.cjs \
  scripts/tests/fixed-path-production.test.cjs \
  scripts/tests/fixed-path-noop-planning.test.cjs \
  scripts/tests/fixed-path-initialization.test.cjs \
  scripts/tests/fixed-path-layout.test.cjs \
  scripts/tests/fixed-path-reclamation.test.cjs \
  scripts/tests/fixed-path-writer-open-admission.test.cjs
CODEGRAPH_FIXED_PATH=0 CODEGRAPH_LEGACY_DIST=/path/to/built/1765271/dist \
  node --liftoff-only node_modules/vitest/vitest.mjs run \
  __tests__/source-ownership.test.ts __tests__/legacy-source-provenance.test.ts \
  __tests__/adaptive-plan.test.ts __tests__/wal-checkpoint-worker-lifecycle.test.ts \
  __tests__/sdk-reader-retirement.test.ts __tests__/same-generation-reader-cache.test.ts
```

## Behavior covered by the 20 portable tests

1. DB-only copy: query, denied write, offline registration, scoped sync full-hash recovery.
2. Runtime removed after clean shutdown: same recovery and stable reopen/no-op.
3. Foreign DB over existing runtime: old identity invalidated, hash catchup, later rebuild.
4. Same index ID with a different managed revision: prior local acknowledgement cannot bypass verification.
5. No source files: explicit sync error, node count/symbols and pending marker retained; retry after restoring sources.
6. Independent live reader process: replacement adaptation blocked until actual exit.
7. Real CLI missing-runtime failure exits nonzero and reports the offline command.
8. Partial runtime loss: missing gate is not silently recreated.
9. Unknown/legacy replacement: explicit offline acknowledgement; custom table survives sync and broad changes without rebuild.
10. Malformed identity and corrupt replacement: errors, exact bytes retained, no retired-image resurrection.
11. Incoming nonempty WAL: rejection before probe cleanup can checkpoint it; exact WAL bytes retained.
12. Incomplete incoming index: rejected with graph bytes unchanged.
13. Process exits after DB import obligation, before binding: same obligation survives and converges.
14. Publication catchup token in copied DB survives and clears only after full-hash convergence.
15. New process reader during an actual managed writer: admitted, no false external-import classification.
16. Runtime deleted while a child holds old handles: no new mutable domain; explicit offline registration after child exit.
17. Injected native read-close failure retains real connection exclusion until process exit.
18. Injected native import-write-close failure retains exclusion; remaining WAL is explicitly rejected, then a known coherent test bundle is recovered offline.
19. Main DB symlink rejected before opening SQLite; target bytes unchanged.
20. Sidecar symlink rejected before opening SQLite; target bytes unchanged.

Assertions inspect symbols, file counts, graph rows, durable tokens, custom data,
SQLite sidecar bytes and actual cross-process leases, not only exit status.

## Failed attempts and limits

All original logs, including failed attempts, are retained in the evidence archive.
The following failures were investigated rather than omitted:

- An old replacement test expected immediate rebuild. Imported images now perform
  their own incremental/full-hash obligation first; the regression now checks the
  distinct token and graph semantics. It also awaits final maintenance after
  `close()` before declaring the copy offline.
- A WAL test exposed that the original generic open probe could checkpoint before
  import validation. Registration now checks mismatched-image sidecars under a
  connection lease before that probe runs.
- The writer-open test's publication assertion also failed on exact ad25. Its
  Node test-launcher arguments differed from worker runtime arguments. The test
  now normalizes `execArgv` like the other fixed-path suites; all three cases pass.
- Initial legacy adaptive fixtures ran under the new fixed default and three
  history tests failed with missing runtime paths. Their explicit legacy fixture
  environment passes in the final matrix.
- One SDK retirement run overlapped compilation and failed five source snapshot
  checks. Isolated reruns on both exact ad25 and this branch, and the final matrix,
  pass. Runtime files change during compilation; no claim of a reproducible
  product regression is made from that overlapping run.
- Early new tests used a nonexistent old SDK accessor, a CLI `--path` option where
  a positional path is required, and a CommonJS require for an uncompiled TS
  fixture. These harness errors were fixed. Read-only SQLite may create temporary
  WAL/SHM files; tests now allow only those expected transient siblings.
- Actual old-library import initially lost rebuild eligibility because completed
  configuration reconciliation adds `adaptive:index-config-v1`. Exact validated
  SHA256 configuration metadata and validated portable identity are now accepted
  by the existing conservative legacy provenance checker; custom schema/content
  exclusions remain. Added positive and malformed-metadata regressions pass.
- Full prototype-to-production parity was **not completed**. Its transformed
  `bootstrap-prepare.test.mjs` child stopped producing output for over two minutes;
  the owned runner/children were terminated and partial logs retained. There is
  no overall pass/fail claim for that run. The direct production initialization,
  layout and reclamation suites completed successfully. This parity hang is an
  outstanding validation limitation, not classified as pre-existing without a
  matching baseline run.

Windows behavior and power-loss durability were not tested here. No overall npm
suite, heavy performance comparison or release packaging was run. In-use raw
replacement, unsupported/noncooperating programs, discarded WAL and mixed SQLite
bundles are outside the supported copy contract. These are not made safe by an
identity marker. Additional metadata admission work was not performance-benchmarked.

## Evidence

[Raw logs and old-library probe](portable-single-db-evidence.tar.gz): 49,742 bytes.
SHA256: `c0cc8da54c8705be6a54289cde3c67966afad15ab70b4d1c3ec1d20d456130d1`.
The archive includes a per-log byte/SHA256 manifest and both failed and successful
runs. The interrupted parity source and its artifacts are additionally preserved
locally in `/workspace/portable-evidence/`; they are not represented as a completed
run. The legacy probe has executor-specific module paths; adapt those paths to the
two separate builds when reproducing.
