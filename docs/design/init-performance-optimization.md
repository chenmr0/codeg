# C/C++ `codegraph init` Performance Optimization

## Goal

Reduce fresh `codegraph init` time for C and C++ repositories without reducing
graph completeness, determinism, or recovery behavior. Changes must be useful
across repositories; no default is tuned only for one project.

## Scope and principles

- The integration branch is `integration/main-ch-new-init-perf`, based on
  `upstream/main-ch-new` (`a1d3ade`). The original worktree is not modified.
- Optimizations preserve the default graph. A performance shortcut must have a
  semantics-preserving proof or a graph-fingerprint regression test.
- Instrumentation is opt-in through `codegraph init --profile <file>` so normal
  initialization does not retain profiling data or compute a graph fingerprint.
- C/C++ is the primary target. Mixed-language repositories retain supported
  cross-language graph behavior, but passes must not scan unrelated C/C++ data.

## Implemented work

### Profiling and observability

- `init --profile` records environment, effective switches, phase wall times,
  input size, graph statistics, resources, extraction scheduling, parser-pool
  state, reference-resolution summary, and per-synthesis-pass output.
- Extraction records source/file distributions, file turnaround versus extractor
  duration, task-window pressure, and C/C++ macro recovery timing totals.
- Macro recovery also records candidate invocation count, sparse recovery-source
  bytes, auxiliary parse attempts, and retained recovered nodes. These counters
  distinguish expensive productive recovery from expensive empty recovery.
- The top turnaround file samples include the same macro-recovery metrics when
  present, so a profile can attribute auxiliary parse cost and recovered-node
  output to individual heavy C/C++ files.
- Resolution and synthesis are reported as separate phases. This prevents a
  large resolver total from being confused with the synthesis tail.

### Fresh-index write and extraction path

- Fresh native stores batch bundles and deduplicate repeated node rows with
  deterministic last-write-wins semantics.
- C/C++ fresh extraction uses a bounded ordered streaming window instead of the
  legacy fixed ten-file batch barrier. Bounds cap queued tasks, source bytes,
  and extracted result rows.
- Large declaration-macro recovery is split into line-preserving sparse shards
  after 256 KiB or 64 macro invocations. Each shard retains the source line
  layout and required container context, so recovered node locations and IDs
  remain unchanged while one monolithic auxiliary parse no longer monopolizes a
  parser worker.
- Rollback switches remain available: `CODEGRAPH_NO_STORE_BATCHING=1`,
  `CODEGRAPH_NO_STREAMING_EXTRACTION=1`, and
  `CODEGRAPH_NO_DECLARATION_MACRO_SHARDING=1`.

### Resolution and synthesis path

- Reference resolution runs read-only worker chunks while the main thread keeps
  all database writes ordered.
- Resolver chunks are now dynamically dispatched: a worker receives another
  500-reference chunk only after completing its current chunk. This avoids the
  static-assignment tail caused by uneven C++ template/overload resolution.
- C/C++ synthesis remains enabled (`cppEdges`, declaration/definition bridges,
  and variable declaration/definition bridges).
- The Swift/Kotlin closure-collection pass now reads only Swift/Kotlin methods.
  A repository containing one Swift file no longer causes that pass to read all
  C/C++ methods.
- The React render pass now reads only Java and JS-family classes. A small JS
  utility no longer makes it inspect every C/C++ class.
- Language-specific synthesis now streams `kind + language` candidates from
  SQLite instead of hydrating all nodes and filtering in JavaScript. The
  field-channel pass is restricted to languages whose valid member syntax is
  `this.`; C/C++ uses `this->`, so it cannot lose a valid field-channel edge.

## Evidence from representative profiles

### GoogleTest

- Extraction dominated init. Declaration-macro auxiliary parsing accumulated far
  more worker time than primary parsing for macro-heavy test sources.
- A failed `gtest_unittest.cc` attempt reached approximately 90 seconds, which
  matches the parser pool's configured hard-timeout policy.
- Small files with short extractor duration had long turnaround because macro
  heavy parser tasks occupied workers. Macro recovery therefore remains a
  dedicated optimization track.
- The heaviest successful recovery source was about 792 KiB, took about 32.9
  seconds of auxiliary parsing, and recovered 2,180 nodes. Recovery is thus
  productive and is not skipped. The new sharding path preserves all recovered
  symbols in a targeted equivalence test; it still needs repository benchmarks.

### GoogleTest follow-up result after declaration-macro sharding

- A clean A/B run with all other switches unchanged completed successfully in
  35.2 seconds with sharding, including 1.24 seconds of profile overhead. The
  no-profile estimate is 34.0 seconds.
- The rollback run with `CODEGRAPH_NO_DECLARATION_MACRO_SHARDING=1` took 140.2
  seconds (139.1 seconds excluding 1.10 seconds of profile overhead), then
  finished incomplete. Sharding therefore lowered the comparable estimate by
  about 75.5% on this macro-heavy repository.
- The formerly failed `gtest_unittest.cc` now completed in about 9.0 seconds:
  469 declaration-macro invocations were recovered through eight shards,
  producing 3,646 recovered nodes.
- In the rollback run, `gtest_unittest.cc` again hit the 90-second auxiliary
  parse hard timeout. Its base AST was retained, but macro-generated
  declarations were skipped, which explains the incomplete graph.
- Aggregate declaration-macro auxiliary parser time was about 88.0 seconds
  across workers with sharding, down from about 168.6 seconds without it.
  This is worker time, not wall time, but corroborates that sharding removed
  the long monolithic parser tasks.
- The completed graph contains 36,377 nodes and 64,758 edges, with fingerprint
  `sha256:16e44060559e8ebf7b6dc108368eceea470bd62048f4750ddedb86351270c739`.
  The rollback graph has only 32,792 nodes and 61,120 edges, and a different
  fingerprint, because the timed-out recovery necessarily omits declarations.
  The targeted unit test still proves equivalence when both recovery strategies
  finish; this A/B demonstrates that the unsharded strategy cannot do so here.

### OpenCV

- The profile indexed 4,749 files (3,026 C++ and 886 C files), producing about
  255 thousand nodes and 839 thousand edges.
- Extraction took about 144 seconds, reference resolution about 76 seconds,
  and synthesis about 49 seconds. This is a different shape from GoogleTest.
- The resolver handled about 917 thousand references, including about 465
  thousand exact matches. Parallel work was present, so reducing worker-tail
  imbalance and measuring exact-match cost are higher priority than adding a
  duplicate name cache.
- `closureCollEdges` consumed about 23 seconds while adding no edge. The cause
  was a whole-graph method scan enabled by a handful of Swift/Kotlin files; the
  language-local filter above removes the unrelated native scan.
- Generated Protobuf headers were genuine expensive extraction tasks. They are
  not excluded by default because their symbols can be part of the user graph.

### OpenCV follow-up result after synthesis and resolver changes

- A fresh profiled run completed in 233.1 seconds versus 288.3 seconds before
  the change (about 19% lower). Excluding profile overhead, the estimate is
  218.8 seconds versus 274.3 seconds (about 20% lower).
- Synthesis fell from 48.6 seconds to 25.8 seconds. `closureCollEdges` fell
  from 22.8 seconds to 1.43 seconds and `renderEdges` from 3.37 seconds to
  0.26 seconds, while both continued to add their previous number of edges.
- Reference resolution fell from 76.2 seconds to 68.1 seconds. This is
  consistent with dynamic worker chunk dispatch, but requires repeated runs
  before treating the full difference as a stable gain.
- The graph fingerprint remained
  `sha256:8a3c741002173d3629e58abb17d9871eee158ebbeaed80a4ff6e3eeee3d544be`.
  Node count (254,796), edge count (839,492), database size, completeness, and
  diagnostics count were unchanged.
- Extraction fell from 143.8 seconds to 123.2 seconds even though this round
  did not alter the extraction hot path. Treat this difference as run-to-run
  variation until it is reproduced with alternating repeated runs.

## Next work

1. Add profile counters and wall-time breakdowns for resolver strategies and
   cache use, especially exact-name lookup. Do not claim an exact-match cache
   gain until the existing per-worker candidate cache is measured.
2. Repeat the declaration-macro sharding A/B on OceanBase and OpenCV. Measure
   normal-init wall time, peak RSS, recovered-node counts, and graph
   fingerprints whenever both configurations complete.
3. Benchmark GoogleTest, OpenCV, OceanBase, and a small C++ repository with
   normal init (no profile overhead), then compare graph fingerprints and peak
   RSS. `streamingTaskLimit` should not be raised blindly: OpenCV already kept
   all seven parser workers busy and did not hit byte or result-row bounds.
4. Consider additional synthesis candidate gates only when their predicates are
   proven to be an over-approximation of every edge the pass could emit.

## Verification required for each change

- TypeScript build succeeds.
- Focused behavior tests succeed.
- `git diff --check` is clean.
- On benchmark repositories, compare a clean fresh index with the rollback
  configuration where applicable; graph fingerprints must match unless a
  documented correctness fix intentionally changes the graph.
