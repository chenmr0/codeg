# Fixed-path no-op sync planning overhead

Base: `f265dd88ed74a897c4b793cceff8e5f9fad7ffeb`.
Branch: `fix/noop-sync-planning`.

This change removes three unused costs in the default fixed-path layout:

- With no cost-history buckets, the worker defers hashing the installed implementation, grammars and native helpers until selection actually requests a rebuild. Legacy generation evaluation still computes its real runtime key before consulting history. The fixed-path placeholder is nonempty for the scoped negative gate and is replaced with a real SHA256 fingerprint before a rebuild plan leaves the worker.
- Ordinary incremental decisions do not transfer the unused complete source inventory to the parent. Full-hash catch-up always receives its plan, including incremental decisions.
- The fixed-bound ordinary sync no longer reads all file records for a cost sample that `recordCostSample()` unconditionally discards.

## Safety and scope

Source planning and execution enumeration both remain. Execution must observe files created, removed, edited or newly ignored after planning and its diagnostic callback. A zero-change plan does not bypass ordinary sync: include/macro/reference/retry/synthesis and completeness handling still run. There is no retained filesystem snapshot across stages or calls. Mutation admission, revision checks, reader leases, worker-exit barriers, publication validation and durable catch-up are unchanged.

This is a conservative removal of provably unused work. It does **not** establish that the entire reported OceanBase no-op regression is resolved, and does not claim one source scan per sync. The independent benchmark environment must measure the actual effect before making a speedup claim.

## Validation

Environment: Linux x86_64, Node v24.19.0, npm 11.9.0, non-root uid 1000.
Guidance: existing `CLAUDE.md` was used; this checkout has no `AGENTS.md` or `.agents/skills`. The two `.claude/skills` concern language addition and agent evaluation, neither applicable here. No user checkout or existing user index was modified.

The new built-runtime test `scripts/tests/fixed-path-noop-planning.test.cjs` uses real Git worktrees, native SQLite and the default fixed-path facade. Worker instrumentation counts actual fingerprint/scan calls and inspects real worker responses; it never supplies a mocked planning result.

Coverage includes:

- No-op graph equality, retained calls/foreign keys, one main-thread files-table read (baseline: two), no unused fingerprint or inventory transfer, and retained fresh execution scan.
- Add/modify/delete/ignore edits in `onAdaptiveDecision` after zero-change planning, durable reopened graph results and retained unaffected calls.
- A file created after planner enumeration; execution still discovers it.
- Real unlink after planner observation; error preserves graph rows and releases admission for retry.
- Configuration and extraction-version changes; rebuild still receives a real runtime fingerprint.
- Same-size/restored-mtime edit with pending full-hash catch-up; hashes/graph converge and the durable marker clears only afterward.
- Pending unresolved references and incomplete synthesis despite unchanged sources; ordinary sync still repairs them.
- Explicit forced extraction, scoped small-change boundaries and a later full sync discovering out-of-scope additions.
- Real second-process sync admission, cancellation before planning and successful retry after release.
- Legacy generation evaluation retains its plan and real runtime identity.

Final results and original stdout/stderr are in `noop-sync-planning-evidence.tar.gz` (adjacent to this report):

| Check | Result | Log |
| --- | --- | --- |
| Build, including production TypeScript | Passed | `build-final.log` |
| Strict production `tsc --noEmit` | Passed | `typecheck-final.log` |
| New CJS regression syntax check | Passed | `test-syntax-check.log` |
| New default-layout regression | 16 passed, 0 failed/skipped | `regression-final.log` |
| Same final regression on the exact base | 2 failed, 14 passed, 0 skipped | `base-regression-final.log` |
| Related Vitest suites | 159 passed across 7 files | `related-vitest-final.log` |
| Existing catch-up and async scan tests | 25 passed, 0 failed/skipped | `catchup-scan-final.log` |
| Existing cross-process admission suite, supported runtime | 6 passed, 0 failed/skipped | `admission-supported-final.log` |

The two baseline failures in the new suite are the extra files-table read and the unnecessary fingerprint in scoped evaluation. Early development test failures are retained: test fixture metadata/ownership setup was corrected, and the added scoped test caught an empty placeholder disabling the existing negative gate. That implementation issue was fixed before the final run.

Two existing admission tests fail under the unmodified `node --test` invocation in this environment because their parent-runtime path does not take the expected rebuild branch. Both failures also reproduce on the exact base (`base-admission-flags.log`); the same suite passes with production-supported `process.execArgv` as shown below. Their original logs, including existing asynchronous fixture-cleanup messages, remain available. No unrelated test or production coordination rule was relaxed.

The existing Vitest fixtures are run with `CODEGRAPH_FIXED_PATH=0` where their internals expect legacy storage. The prior deletion regression explicitly resets that override and still tests the default layout. The new CJS suite explicitly selects the default fixed layout. This is not a claim that the full repository suite passes with its default test fixtures.

No full repository suite, Windows/macOS acceptance, Rust helper build, OceanBase timing matrix or user-index migration was performed. There are no skipped tests in the final selected runs.

## Reproduce correctness checks

From the checked-out branch after installing its locked dependencies:

```sh
npm run build
node node_modules/typescript/bin/tsc --noEmit
node --check scripts/tests/fixed-path-noop-planning.test.cjs
node --liftoff-only --test scripts/tests/fixed-path-noop-planning.test.cjs
node --liftoff-only --test --test-concurrency=2 scripts/tests/fixed-path-catchup.test.cjs scripts/tests/async-scan-worker.test.cjs
node --liftoff-only -e 'process.execArgv=["--liftoff-only"];require("./scripts/tests/fixed-path-sync-admission.test.cjs")'
CODEGRAPH_FIXED_PATH=0 node --liftoff-only node_modules/vitest/vitest.mjs run \
  __tests__/adaptive-plan.test.ts __tests__/adaptive-read-worker.test.ts \
  __tests__/adaptive-sync-integration.test.ts __tests__/adaptive-sync-entrypoints.test.ts \
  __tests__/adaptive-worktree-deletion.test.ts __tests__/sync-completeness.test.ts \
  __tests__/sync-retry-state.test.ts --maxWorkers=2 --minWorkers=1
```

## Independent performance retest

Fetch this branch and the exact base into isolated checkouts. Build both. In the benchmark environment use equivalent copies of its baseline fixture/index, identical Node/flags/environment, and the same default CLI command:

```sh
node --liftoff-only /absolute/checkout/dist/bin/codegraph.js sync /absolute/isolated-fixture
```

For attribution, run a separate diagnostic invocation with `--verbose`; keep verbose logging out of the timed comparison if the baseline used ordinary output. Keep source/index state equivalent, separate warm/cold observations and record the complete wall time, exit status, changed-file counts and graph integrity. Do not assume the command is a no-op solely from exit code.

`profile.cjs` in the evidence creates and removes its own 1,000-file temporary Git fixture and reports cold planning components and one ordinary sync. It is a diagnostic, not a benchmark: the two saved invocations did not isolate identical concurrent load. Their raw logs (`base-profile.log`, `fix-profile.log`) must not be used to claim an improvement or extrapolate to OceanBase. The prior 3.659 s / 6.252 s observations came from another environment and were not reproduced here.

Evidence archive: 20947 bytes; SHA256 `8c7072a770228bb76c5bfc1485887dbc71f4d624956a6baa2a664ce2cf8c82a3`. Internal `SHA256SUMS` covers every saved evidence file.
