# Linked-worktree compatibility regression — Linux

Source base: `76eefe7`; benchmark-plan predecessor: `f7d6b4a`. Runtime: Linux, Node v24.22.1. This is the phase-one WAL prototype branch; no fixed-path production integration is introduced.

## Change

A shared on-disk Git metadata resolver follows `.git` directories or gitfiles and resolves `commondir` relative to the actual gitdir. The effective repository-local `info/exclude` is in the common directory. Configuration fingerprints retain the logical `.git/info/exclude` key and hash contents, never machine-specific metadata paths. Invalid gitfiles and inaccessible/broken metadata fail explicitly, rather than swallowing `ENOTDIR`.

The scanner and watcher share this resolution. External common-directory controls are watched on recursive Windows/macOS as well as Linux; global Git ignore settings remain intentionally outside CodeGraph's project-scoped policy.

## Executed

- `npm run build`: passed (`build.log`).
- Targeted Vitest: **120/120**, no skips (`targeted-vitest.log`). Covers real Git worktree, common-dir resolution against `git rev-parse --git-path info/exclude`, portable fingerprints, sync/async scan exclusion, malformed metadata and native external exclude watcher.
- Extraction: **483/483**, no skips (`extraction-liftoff.log`).
- Adaptive lifecycle, ownership and scan optimization: **45/45**, no skips (`lifecycle-scan-ownership.log`).
- Real linked-worktree integration: **3/3**, no skips (`real-worktree.log`):
  - Public `CodeGraph.init({index:true})`, ordinary incremental sync, then 140 added files and actual adaptive child rebuild (`adaptive.strategy === 'rebuild'`), with complete source ownership asserted.
  - Independent child process with no uncaught-exception handler: temporary malformed `commondir` is diagnosed without host termination; repairing it and editing common excludes resumes native watcher notifications.
  - Fixed-path WAL build, source check, effective common exclude edit, real rebuild/publication, postcheck; reverse exclude edit and a second real publication/postcheck.

The new integration test is part of `run-source.mjs` for subsequent cross-platform CI. Windows was **not** executed locally and is not claimed by this report.

## Reproduction commands

```
npm run build
node node_modules/vitest/vitest.mjs run __tests__/git-metadata.test.ts __tests__/adaptive-plan.test.ts __tests__/git-paths.test.ts __tests__/watcher.test.ts
CODEGRAPH_ALL_LANGUAGES=1 node --liftoff-only --test scripts/prototypes/fixed-path/git-worktree.test.mjs
```

The wider extraction run initially terminated inside V8 with `Fatal process out of memory: Zone` (retained in `initial-batch-v8-zone-oom.log`); this is not recorded as a passing batch. A separate one-worker run with explicit fork `--liftoff-only` passed all 483 assertions. The exact temporary Vitest config is retained in `vitest-config-used.txt`; place it at repository root and run Vitest `--config <file>` to repeat. It imports the repository's unchanged configuration and only sets one worker plus the Wasm compiler flag. The 45 lifecycle/scan/ownership tests were also independently rerun successfully with that config.

These regressions establish worktree compatibility, not the separate full-build query-tail or large-repository offline-cycle performance gates.
