---
title: CLI
description: Every CodeGraph command and the flags it accepts.
---

```bash
codegraph                         # Run interactive installer
codegraph install                 # Run installer (explicit)
codegraph uninstall               # Remove CodeGraph from your agents (inverse of install)
codegraph init [path]             # Initialize in a project (--index to also index)
codegraph uninit [path]           # Remove CodeGraph from a project (--force to skip prompt)
codegraph index [path]            # Full index (--force to re-index, --quiet for less output)
codegraph sync [path]             # Incremental update
codegraph status [path]           # Show statistics
codegraph query <search>          # Search symbols (--kind, --limit, --json)
codegraph files [path]            # Show file structure (--format, --filter, --max-depth, --json)
codegraph context <task>          # Build context for AI (--format, --max-nodes)
codegraph callers <symbol>        # Find what calls a function/method (--limit, --json)
codegraph callees <symbol>        # Find what a function/method calls (--limit, --json)
codegraph impact <symbol>         # Analyze what code is affected by changing a symbol (--depth, --json)
codegraph affected [files...]     # Find test files affected by changes
codegraph serve --mcp             # Start MCP server
```

## Query commands

`query`, `callers`, `callees`, and `impact` all accept `--json` for machine-readable output.

```bash
codegraph query UserService --kind class --limit 10
codegraph callers handleRequest --json
codegraph impact AuthMiddleware --depth 3
```

## Experimental locate

`codegraph locate` is available directly without an environment switch. It remains experimental and CLI-only; no locate MCP tool is registered. It reads an existing index and verifies a bounded set of source files; it does not call an LLM or automatically index the project. Requires Node.js 22.5–24 for read-only native SQLite.

```bash
codegraph locate --file issue.md --json
codegraph locate --file issue.md --path /path/to/project --json
codegraph locate --text 'Improve VideoManager::saveSnapshot error reporting' --path /path/to/project
codegraph locate --file requirements.md --max-tokens 3000 --max-tokens-per-clue 500
```

Provide exactly one of `--file` or `--text` (maximum 128 KiB). Defaults: `--limit 10`, `--timeout-ms 45000`, `--max-tokens 20000`, `--max-tokens-per-clue 2000`. Output budgets use the locally bundled `o200k_base` tokenizer and include metadata and evidence. Truncation and incomplete retrieval are explicit in the structured result.

Output is written directly to stdout, so `codegraph locate --file issue.md --json > result.json` saves the JSON, including source snippets in `candidates[].source`. Without `--path`, the CLI looks for the nearest initialized project starting from the current working directory. Relative document paths are resolved from that working directory, independently of `--path`.

Default output provides prefetched source context to reduce an agent's subsequent grep/read calls: line-numbered code grouped by file comes first, followed by indexed relationships and precise missing ranges for optional follow-up reads. Overlapping source is merged; short definitions are included whole when the budget permits. Use `--verbose` for document excerpts, matching evidence, ranking scores and statistics, or `--json` for structured data. Both formats enforce their final output token limits.

## affected

Traces import dependencies transitively to find which test files are affected by changed source files. See [Affected Tests in CI](/codegraph/guides/affected-tests/) for options and a CI example.
