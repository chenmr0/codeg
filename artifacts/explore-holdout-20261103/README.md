# OceanBase Explore holdout (34 queries)

This is the small reproducible input/runner/scorer bundle. It contains no source checkout, database, dependencies, or full responses. Queries/gold were frozen before execution; do not edit them after seeing output.

## Prerequisites
- Node 24 and Python 3. Build/install the three runtimes using their repository instructions.
- OceanBase source commit `5e8a63d29dae9fde5e962b8fcc7b167d438fc343`.
- Baseline codeg `39a13ebb7ce54bf93e9727b6d24c0245ed0e5ac9`; final local `f9e893b4ddb26d1ecd469abd394856b0a39ea4f7` (maintainer supplies equivalent remote tree); community `f72c9d2efb14454ff4f9fd7b8460abd82f19a287`.
- Already completed full native indexes. Baseline/final use the SAME fork project/database; community its own completed graph. Do not treat interrupted/partial indexes as completed.
- `config.example.json` is a template: copy to `config.json`, replace relative paths with your actual installed runtime/index locations. Relative paths resolve from that configuration file, not the working directory. Each runtime needs `dist/index.js` and `dist/mcp/tools.js`.

## Execute (one pass, sequential)
Choose a NEW empty output directory, also set as outputDir in config. Save `queries-gold.json` and `FREEZE.json` there before running. Record git SHAs, runtime checksums, hardware and DB checksums before/after separately.

```sh
mkdir run-output
cp queries-gold.json FREEZE.json run-output/
for arm in baseline final community; do
  NODE_OPTIONS=--max-old-space-size=6144 node --liftoff-only run.cjs "$arm" config.json > "run-output/$arm.log" 2>&1
  echo $? > "run-output/$arm.exit"
done
python3 assess.py run-output ./repos/oceanbase-source
```

Runner fixes maxFiles=12, new ToolHandler/call, no daemon/session dedup. At full graph sizes all three versions use 24000char/7000perfile budgets. Outputs and latency are recorded; one fixed-order pass is NOT a performance benchmark. Runner logs individual call errors; scorer fails closed on missing/duplicate results, call errors, failed process, mismatched output hashes, or changed frozen gold. Scorer accepts only numbered lines in source fences after `**Source Code**`; indentation-only normalization accommodates skeletons.

## Interpretation
32 queries have 82 minimum source evidence checks; 2 ambiguous/negative controls need manual review. Report per-check retrieval and per-query all-required-evidence counts, NOT answer accuracy, whole-output precision, or file-count relevance. Six intents have three correlated language/symbol variants. Include source-errors.json; nonempty source errors require review before interpreting scores.

Original run: 102 successful calls; all three arms 45/82 evidence items and 17/32 full checklists. This did not demonstrate holdout gains. It also does not prove no regressions: independent manual review found lost peripheral context outside gold. Natural-language no-symbol variants were notably weak. Gold recall alone is insufficient; review full source-window diffs and caller/control-flow context. Do not modify code or gold to make this suite pass and then call it held out.

## Bundle provenance and license boundaries
`queries-gold.json` is byte-for-byte frozen (SHA in FREEZE.json). It includes short exact source-line excerpts, not a third-party source checkout: 82 checks / 54 distinct path-line positions. Those excerpts originate from OceanBase at the source commit above, Copyright (c) 2021 OceanBase, SPDX-License-Identifier: Apache-2.0. The original license and notice are retained as OCEANBASE_LICENSE and OCEANBASE_NOTICE. Inclusion does not relicense these excerpts under the host repository's MIT license. The original NOTICE also describes upstream dependencies; no dependency source or binaries are bundled here. New evaluation queries, scripts and commentary are separate from the quoted lines.

The checked-in scorer is v2.2: compared with the original v2.0 bundle it rejects Python optimization mode (which disables assertions), requires a clean tracked Git source checkout at the fixed OceanBase SHA, validates every gold line against source, and exits nonzero for source-content errors. It pins the original gold digest in trusted validation.py (not merely the output FREEZE.json), checks both bundle and output gold, and rejects absolute/traversing/untracked/source-symlink-escape headers before reading source. Conflicting duplicate source lines and unclosed source fences also fail closed. The runner rejects changed gold and an already-used arm output directory. Run `python3 -B -m unittest discover -s . -p test_validation.py` from this bundle directory for negative guard tests. These are harness safeguards, not changes to frozen inputs or product behavior. Source archives without `.git` are not supported by this scorer.

Runtime Git SHAs, working-tree patches, compiled dist checksums, DB completeness and exported budgets remain explicit operator checks, not automatically certified by the runner. Record them before and after every run. A new runtime may be evaluated, but must be labeled as a new arm version; the name `final` alone does not prove it is f9e893b. For a nondefault config outputDir, change the shell redirection/exit paths to the same directory. Output/scorer paths are resolved by the shell; only config paths resolve relative to config.json.

Execute only one process per arm/output directory. The runner's existing-output checks are not an inter-process locking guarantee. Shell redirection may truncate logs; use a fresh directory and optionally `set -C`. `openReadOnlySync` is preferred but older runtimes may fall back to `openSync`; verify before/after DB hashes rather than assuming the runner guarantees read-only operation.


## Subsequent withdrawal replay
The original f9e893b results above remain historical. A later built working-tree candidate withdrew the co-named owner/member promotion and ran the same 34 queries plus one old transaction case on the same native graph. The frozen checklist stayed 45/82 and 17/32; backup/DDL context returned, but transaction remained incomplete and five query windows still differed from the baseline. See EVALUATION.zh-CN.md for scope and expected failures. This replay is a regression check on already-seen inputs, not an additional independent holdout, and the extra transaction is not in the gold denominator. No raw responses or DBs are bundled.
