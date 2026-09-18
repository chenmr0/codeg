/**
 * The marker-fenced agent-instructions block the installer writes into each
 * agent's instructions file (CLAUDE.md / AGENTS.md / GEMINI.md).
 *
 * History: pre-#529 the installer wrote a full usage playbook here, which
 * duplicated the MCP `initialize` instructions for the main agent — so it
 * was removed and `mcp/server-instructions.ts` became the single source of
 * truth. A much smaller block returned for #704, because the MCP
 * instructions cannot reach two audiences that the instructions FILE does
 * reach:
 *
 *  - **Task-tool subagents** — they receive the project instructions file
 *    in their context but NOT the MCP initialize instructions. They hold
 *    the codegraph MCP tools only as deferred names and rarely think to
 *    load them: measured on a forced-delegation flow question (excalidraw,
 *    sonnet, high effort), subagents loaded + used codegraph in ~1 of 9
 *    runs without this block, and consistently with it — including runs
 *    with zero Read/grep fallback.
 *  - **Non-MCP harnesses** — agents with no MCP client at all can still
 *    run the `codegraph explore` CLI, which prints the same output as the
 *    MCP tool.
 *
 * Keep this block SHORT. The main agent reads it every turn on top of the
 * server instructions — the #529 duplication-cost argument still bounds
 * its size. Command names and the two surfaces, nothing more.
 */

/** Markers used by the marker-based section write/removal. */
export const CODEGRAPH_SECTION_START = '<!-- CODEGRAPH_START -->';
export const CODEGRAPH_SECTION_END = '<!-- CODEGRAPH_END -->';

/**
 * The full block, markers included, exactly as written to disk.
 *
 * The wording is deliberately CONDITIONAL ("in repositories indexed by…"):
 * a global install writes this into a user-scope file (~/.claude/CLAUDE.md,
 * ~/.cac/AGENTS.md, ~/.config/opencode/AGENTS.md) that applies to every
 * project the user opens — including unindexed ones, where an unconditional
 * "this repository is indexed" claim would send subagents into failing
 * codegraph calls (the noise the unindexed-session policy exists to
 * prevent).
 *
 * This fork has `codegraph_explore` DISABLED by default (the tool returned
 * too much data with too much noise, per user feedback) — see
 * `CODEGRAPH_ENABLE_EXPLORE` in `src/mcp/tools.ts`. So unlike upstream #704,
 * this block does NOT point at `codegraph_explore`; it points at the granular
 * tools that ARE on (`codegraph_search` / `codegraph_node` / `codegraph_callers`
 * / `codegraph_callees` / `codegraph_impact` / `codegraph_files`) and at the
 * `codegraph query|callers|callees|impact` shell commands for MCP-less
 * harnesses. Keep it SHORT — the main agent reads it every turn on top of
 * the server instructions.
 */
export const CODEGRAPH_INSTRUCTIONS_BLOCK = `${CODEGRAPH_SECTION_START}
## CodeGraph

Use CodeGraph only when a \`.codegraph-wx/\` directory exists, or a legacy
\`.codegraph/\` directory exists with legacy compatibility enabled (default;
disabled by \`CODEGRAPH_LEGACY_COMPAT=0\`). If the task already
gives an exact file and line and only neighboring code is needed, use host Read;
reserve CodeGraph for symbol pairing and relationships.

- Symbol → \`codegraph_search\`; batch names with ONE
  \`codegraph_search(queries=[...])\`. Set \`includeCode="if_unique"\` for
  implementation source plus a compact declaration pointer. Oversized source is
  safely truncated rather than replaced by an outline.
- Precise bundle → ONE \`codegraph_node(targets=[...])\` or
  \`codegraph_context(targets=[...])\`. Use \`{file, symbols:[...], texts:[...]}\`
  or \`{symbol:<container>, members:[...]}\`; ranges and decl/def partners are
  deduplicated. Caller/callee trails are off by default.
- Known file, unknown leaf →
  \`codegraph_node(file=..., symbolsOnly=true, outlineQuery=...)\`. Batch outlines
  support \`outlineQueries\`; filters match leaf names, not parameter signatures.
- Literals → \`codegraph_text_search\` with one narrow path and several queries.
  Exact generated-file paths are included; directory scans need
  \`includeGenerated=true\` for generated files.
- Exact non-symbol boundary → \`codegraph_node(file=..., offset=..., limit<=500)\`.
  Bare/full-file MCP reads are rejected; over-budget window batches preflight
  before emitting partial source.
- Relationships → \`codegraph_callers\`, \`codegraph_callees\`, or
  \`codegraph_impact\`. Pass file + line or signature for overloads; these tools
  refuse to aggregate distinct overloads. Callers includes base-declaration call
  sites for an exact override dispatch family.
- Miss evidence: trust \`CONFIRMED_ABSENT\`; \`DECLARATION_ONLY\` means no paired
  definition; compact raw-source matches/\`RAW_MATCHES\` signal an index gap;
  narrow after \`INCONCLUSIVE\`.
- Directory inventory → \`codegraph_files\`. Without MCP, use the equivalent
  \`codegraph query|callers|callees|impact\` commands.

If neither supported index directory exists, skip CodeGraph entirely — indexing is the user's decision.
${CODEGRAPH_SECTION_END}`;
