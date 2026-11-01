# Conservative unchanged-planning preflight

Base: `4eea02359e4577dbe63d7eed679730c1d76c3584` (production code identical to `f32f9e6f829ec8e4217e66a3eb600d16a6c345df`). Branch: `fix/noop-sync-planning`.

The independent OceanBase comparison of the preceding optimization did not show a speedup (reported medians: f265 4.963 s; f32f 5.108 s). Those observations are not measurements from this executor. This follow-up targets the complete no-op inventory construction and repeated full-path resolution left in planning.

## Change and correctness boundary

The fixed-layout read worker may use a negative-only preflight when ownership is valid, a published configuration identity exists, and the request is full-project, ordinary-hash, with no upgrade/configuration/blocker flag. Pending fullHash catch-up, scoped evaluation and legacy history evaluation retain their original paths.

The preflight requires exactly the tracked path set and regular files with the same size and floored mtime as the original planner's shortcut. It resolves the canonical root once, rejects ambiguous ancestors, and checks each distinct ancestor with lstat instead of resolving each full filename repeatedly. It then rechecks every observed file's type, size, mtime, ctime and inode. Source disappearance or observed replacement rejects the evaluation. EACCES and other I/O errors propagate. Controls are hashed after source verification, matching the original ordering.

Only this zero-candidate case avoids materializing a full plan. It returns an incremental decision, **never a completed sync**. No source inventory is handed to execution or publication. Ordinary sync still rescans after recovery and `onAdaptiveDecision`, and still performs retry/reference/include/macro/synthesis work. Admission, revision checks, read leases and worker-exit coordination are unchanged. No filesystem lock or immutable snapshot is claimed.

Any inconclusive observation continues into the unchanged full planner within the same planning pass. The original enumeration is local to that pass; a failed preflight does not introduce a third complete source enumeration. Full publication validation and subsequent execution scans remain independent.

This deliberately narrower gate does not estimate a nonzero changed-file/node/byte bound or tune thresholds. It proves the same zero-candidate shortcut as the original planner. Both structural branches require nonzero changes. Every nonzero/inconclusive case still uses the original caller-supplied fallback policy. Differential tests compare complete plans and decisions under default, low, exact-boundary and above-boundary parameters.

## Validation

Linux x86_64, Node v24.19.0, npm 11.9.0, non-root uid 1000. Only isolated fixtures and checkouts were used.

- Build and strict production typecheck passed.
- New built-runtime Vitest boundary suite: 17 passed, zero skipped. Includes exact-plan comparison for add/modify/staged and unstaged delete/ignore/config/touch; real directory traversal and control-file EACCES; deletion/edit/recreation after observation; ancestor symlink replacement; configuration changes during final verification; fullHash and invalid inventory handling.
- Default-layout CJS behavior suite: 17 passed, zero skipped. Retains previous graph/DB assertions and verifies the real preflight is exercised, custom low thresholds still rebuild, and fullHash catch-up does not use the hint.
- Same CJS suite on the exact base: 15 passed, 2 failed because the new preflight is absent. The raw baseline failure log is retained.
- Related Vitest run: 175 passed across eight files (159 existing + the then-16 new boundary cases). After the final controls-ordering refinement, the complete new boundary suite (17 cases) and default-layout suite (17 cases) were rerun successfully on the final code.
- Existing catch-up and async scan suites: 25 passed; supported-runtime admission suite: 6 passed. No selected final Linux test was skipped.
- CI: existing CJS production matrix step automatically runs the expanded 17-case suite on both target platforms. A separate Linux step runs the new boundary suite and enforces zero skipped/pending tests; its two real POSIX permission tests explicitly skip on Windows/root in standalone runs. The existing cross-platform zero-skip gates were not weakened.
- YAML parses and `git diff --check` passes. PowerShell, GitHub-hosted CI and Windows execution were not available locally. No full repository suite, Rust helper rebuild, OceanBase timing matrix, or user-index migration was run.

Early development logs are preserved: the new Vitest fixture initially attempted to spy on immutable builtin ESM exports and staged deletion before its fixture commit. A CI-equivalent rerun also caught sub-millisecond mtime rounding in a restored-mtime fixture; timestamps now use exact integer milliseconds with an equality assertion. These test-harness issues were corrected by exercising the actual CommonJS worker implementation and committing the fixture. An early configuration-check ordering was moved after final source verification and covered by an added race test.

## Representative performance experiment

An isolated Git fixture contains 14,253 C files in nested directories, 42,759 nodes and 42,759 edges. Both built versions use the same unchanged fixture/index sequentially, with fresh CLI processes, `--liftoff-only`, identical environment and ordinary nonverbose output. This represents path-enumeration scale and depth; it does not reproduce OceanBase's language mix, database size or filesystem.

Final timing used one excluded warm-up per version and seven interleaved observations per version, alternating which version ran first. No other build or test task was run concurrently in this executor during the final timing. Raw stdout, stderr, exit status and wall time are retained for every observation. All 14 measured CLI executions exited zero and reported already up to date.

| Version | Median | Range |
| --- | ---: | ---: |
| Exact base 4eea023 | 1.965920 s | 1.926999–2.031950 s |
| This preflight | 1.874433 s | 1.773421–1.903730 s |

The median reduction is **4.65% in this fixture**. This is a modest local result, not evidence that the entire OceanBase regression is resolved. The earlier exploratory run overlapped test activity and is retained separately; it is not used for this comparison.

Before/after SQLite checks confirmed identical sorted-row SHA256 for files, nodes, edges and unresolved_refs, `integrity_check=ok`, and no foreign-key violations. A separate instrumented planner diagnostic (excluded from timing) measured 14,253 realpath calls in the base versus one root realpath in the preflight; file/ancestor lstat checks remain. Those counters cover the calling planner thread, not the nested enumeration worker; enumeration work is unchanged. Planning diagnostic wall times were 928.6 ms and 800.3 ms. Both source planning enumeration and execution enumeration remain; that remaining repeated scan is a material limitation and a candidate for further measured work.

## Reproduction

After installing locked dependencies and building both checkouts:

```sh
node --liftoff-only --test-reporter=tap scripts/tests/fixed-path-noop-planning.test.cjs
CODEGRAPH_FIXED_PATH=0 node --liftoff-only node_modules/vitest/vitest.mjs run __tests__/adaptive-unchanged-gate.test.ts --maxWorkers=1 --minWorkers=1
```

Extract the adjacent evidence archive. Its scripts accept checkout/fixture paths:

```sh
node --liftoff-only noop-major-evidence/create-fixture.cjs /absolute/base-checkout /absolute/new-fixture
node noop-major-evidence/snapshot.cjs /absolute/new-fixture > before.json
node noop-major-evidence/benchmark.cjs 7 /absolute/base-checkout /absolute/candidate-checkout /absolute/new-fixture > timing.jsonl
node noop-major-evidence/snapshot.cjs /absolute/new-fixture > after.json
```

The benchmark executes the unchanged default command for each checkout:

```sh
node --liftoff-only /absolute/checkout/dist/bin/codegraph.js sync /absolute/isolated-fixture
```

Use the complete new commit for independent OceanBase comparison; do not extrapolate the synthetic-fixture percentage. No Library upload was retried. Raw evidence is delivered through the authorized Git branch.

Evidence archive: 23083 bytes; SHA256 `fdd25665399d5b6af332421b90c78f893209634d4e7b82885a8836a1a91be953`. Internal SHA256SUMS covers each raw evidence file.
