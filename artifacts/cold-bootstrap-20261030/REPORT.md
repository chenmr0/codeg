# Concurrent cold bootstrap: stale DELETE observation

Source baseline: `dd3166bfa4c046f90135d3f5331acb351cad5ed4`.
Independent diagnosis branch: `fix/wal-cold-bootstrap`. The frozen large-repository benchmark source and its worktree were not modified.

## Observed failure and cause

Windows CI run https://github.com/chenmr0/codeg/actions/runs/40981002929 passed its 183-test main suite, but the third predeclared simultaneous-cold-bootstrap repetition failed with `Incompatible DELETE coordinator` at `protocol.mjs:44`. The original job output is retained in `windows-original-job.log`. This is not treated as a passing CI run.

A deterministic Linux interleaving reproduces the exact rejection:

1. Parent opens the new, empty coordinator. Its first `PRAGMA journal_mode` genuinely returns `delete`.
2. Before that result reaches the caller, an independent process runs the real `initialize()` to completion: coordinator WAL, state table, and lease files.
3. The parent's next plain journal-mode PRAGMA can still return its cached DELETE mode. Its subsequent schema query refreshes SQLite's pager and sees the committed state table (the connection now reports WAL).
4. The old code checks that new schema/lease evidence using the obsolete local `mode` and wrongly rejects an initialized WAL coordinator.

The new formal success-behavior test fails on the untouched baseline with this exact error (`formal-baseline.log`, exit 1). It does not fake journal modes or locks. `deterministic-before.log` / `deterministic-after.log` retain the explicit observation trace.

## Narrow fix

Only when the first observed mode is non-WAL, perform a short read transaction: read schema to refresh the pager, re-read mode, and check initialized/lease evidence within that protected observation. A real DELETE coordinator with established state or lease evidence is still rejected, with files unmodified. A confirmed WAL coordinator is adopted without conversion. Only an empty admissible bootstrap may attempt WAL conversion after committing the read transaction; lock contention uses the unchanged bounded preopen BUSY retry.

Already-WAL startup and query paths are unchanged. No retry of a protocol action, cleanup, publication, or write transaction has been introduced. This is not online migration support.

## Executed Linux evidence

Node v24.22.1:

- **34/34 related tests passed**, zero skipped: deterministic bootstrap race, genuine DELETE rejection, BUSY family/deadlines, failed lease-bootstrap preservation, compatibility and cold-open lifecycle (`regression.log`).
- **20/20 predeclared five-process cold-bootstrap repetitions passed**, each selects exactly one test and records zero skipped. All per-round TAP/log and JSON evidence retained in `repeat-1` through `repeat-20`; plan and all exit statuses retained.
- Baseline formal comparison: 1 expected failing new race regression, 2 real-DELETE negative cases passing. This is retained as failure evidence, not counted as a green run.

Windows validation of this fix is still required. Linux repetitions do not substitute for the failed Windows gate. Full large-repository observations currently running on the frozen baseline cannot be relabeled as this revision's complete validation.

## Repeat

```
node --liftoff-only --test --test-concurrency=1 scripts/prototypes/fixed-path/coordinator-bootstrap-race.test.mjs scripts/prototypes/fixed-path/coordinator-busy-family.test.mjs scripts/prototypes/fixed-path/lease-bootstrap.test.mjs scripts/prototypes/fixed-path/wal-compatibility.test.mjs scripts/prototypes/fixed-path/cold-open.test.mjs
node --liftoff-only --test --test-name-pattern='^simultaneous cold clients' scripts/prototypes/fixed-path/acceptance.test.mjs
```

The new deterministic regression is added to `run-source.mjs` for cross-platform validation. The broad validation test which injects a persistent fake DELETE mode now expects an additional genuine revalidation query; it still requires rejection and does not relax validation.
