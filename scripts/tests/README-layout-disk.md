# Fixed-layout disk acceptance

Run after a complete `npm run build` (including asset copying), without concurrently rebuilding `dist`:

```sh
CODEGRAPH_LAYOUT_EVIDENCE="$PWD/artifacts/layout-disk-linux" \
  node --liftoff-only scripts/tests/fixed-layout-disk-acceptance.test.cjs
```

Do **not** add `--test` to this command: `node:test` runs these tests itself. Production deliberately treats unsupported parent runtime flags as ineligible for automatic rebuild; testing with `--test` would instead exercise incremental fallback. Do not override that safety guard in the test.

To exercise the actual installed package rather than source checkout code:

```sh
CODEGRAPH_TEST_PACKAGE="/absolute/install/node_modules/@sdd/codegraph-wx" \
CODEGRAPH_LAYOUT_EVIDENCE="/absolute/evidence/installed" \
  node --liftoff-only scripts/tests/fixed-layout-disk-acceptance.test.cjs
```

On Windows, use the same environment variable names and command with PowerShell's `$env:NAME=...` syntax. A Linux run is **not** Windows acceptance. Real daemon acceptance is separately implemented in `fixed-path-real-mcp.test.cjs`; daemon fallback to direct stdio must not be called daemon coverage.

The test runner records the package path, platform, architecture, Node version, complete root-name sets, recursive file names/types/byte sizes, runtime total bytes, task counts and business-copy counts/bytes. Running, completed, closed and restarted/recovered checkpoints are written per scenario. Traversal is explicitly non-atomic: ENOENT caused by concurrent automatic reclamation is tolerated, but other filesystem failures are not. Stable boundary assertions enforce the full root contract.

All fixtures are retained, including failed ones. Tests never delete candidate, backup, old generation, runtime state, or task directories to obtain a passing result. Source-file edits and explicit damaged/missing-public-database fixtures are deliberate test inputs, not product cleanup. Cleanup polling only reads the filesystem, is bounded at ten seconds, and does not issue a query or invoke recovery to coax normal reader-release cleanup. Recovery is explicitly invoked only in recovery scenarios. After SDK close, the test awaits the production `graph.whenIdle()` maintenance-completion promise with a separate ten-second timeout before taking a closed snapshot or performing offline replacement. This waits for the actual worker exit, not a guessed delay; failures retain a diagnostic snapshot and fail the test. Restart subprocesses perform the same bounded close drain, and native-participant scenarios await `whenMaintenanceIdle`.

## Coverage and limits

- SDK initialization and ordinary incremental sync; three actual automatic rebuild/close/process-restart cycles.
- Worker progress failure and AbortSignal cancellation; old data and candidate reclamation checked after real worker completion.
- Bounded reader-drain cancellation and a real native in-flight reader spanning a successful publication (production protocol, native SQLite and a separate publisher process).
- Generational, root-only and scattered-fixed offline migrations, including custom SQL table preservation and repeated migration.
- Public main-file overwrite with unchanged local runtime, new query/custom data, old cost invalidation, and corrupt/missing replacement rejection.
- Six real migration-process exit points and eight real production publication-process exit points; independent process recovery and disk convergence.
- Unknown-file and conflicting-source preservation/reporting; Git ignore protection without a root `.gitignore` exception.

The minimal-SQL publication crash tests exercise the production protocol, not the prototype, but are not described as SDK/MCP query integration. MCP/daemon, watcher and broader protocol/performance suites remain separate. Directory success does not establish cold-start-tail performance or relax any existing latency budget. A process-exit test is not a power-loss durability test. Deferred cleanup or unknown conflicting artifacts are not a complete-layout pass.
