/** Compact routing policy emitted once during MCP initialization. */
export const SERVER_INSTRUCTIONS = `# CodeGraph — cost-based code intelligence

Prefer CodeGraph when exploring source code. For a known symbol, request its
implementation directly with \`codegraph_wx_node(symbol=..., includeCode=true)\`.
For necessary non-symbol local code, use offset + limit<=200 and expand only
adjacent missing content. Stop once sufficient evidence is available.
Use native grep/Read only for unindexed files, explicitly reported stale/pending
indexing, repeated exact-symbol misses, references outside AST coverage, or
configuration/documentation/Markdown; keep the fallback narrowly scoped.

## Routing

- Symbol lookup → \`codegraph_wx_search\`. Batch 2–8 names with
  \`queries=[...]\`; true misses share one multi-pattern raw-source scan. Search
  defaults to strict case-sensitive lookup. Fuzzy suggestions, case correction,
  and owner recovery require server environment \`CODEGRAPH_SEARCH_FUZZY=1\`;
  exact raw-source fallback applies in either mode. Set
  \`includeCode: "if_unique"\` for implementation source plus a compact
  declaration pointer in the same response. Oversized source is safely truncated
  rather than replaced by an outline. With fuzzy mode enabled, a wrong owner is
  recovered only when the owner itself is absent; an indexed owner with no such
  member does not inline unrelated leaf candidates.
- Precise implementation bundle → ONE \`codegraph_wx_node(targets=[...])\` or ONE
  \`codegraph_wx_context(targets=[...])\`. Targets may be a selected container with
  members, exact text anchors, or exact file windows. Overlapping ranges and
  declaration/definition partners are deduplicated. Caller/callee trails are off
  by default. JSON-stringified targets arrays are parsed automatically.
- Relationships → \`codegraph_wx_callers\`, \`codegraph_wx_callees\`, or
  \`codegraph_wx_impact\`. Use file + line or signature for overloads. These tools do
  not aggregate distinct overloads; callers includes the exact virtual-dispatch
  family and base-declaration call sites.
- Known file, unknown symbol →
  \`codegraph_wx_node(file=..., symbolsOnly=true, outlineQuery=...)\`. Outline filters
  match leaf symbol names, not parameter text. A bare batch \`{file}\` target
  becomes a compact symbol outline.
- Literals/macros/registrations → ONE \`codegraph_wx_text_search\` call with a narrow
  path and several queries. A zero-match identifier can recover an exact symbol.
  Generated directories are skipped unless \`includeGenerated=true\` or the path
  identifies one exact generated file.
- Generated artifacts → request the source-of-truth definition and exact generated
  function/tail together, then run the repository generator after editing.

## Guards and evidence

Single-target file mode accepts \`{ file, symbolsOnly: true }\` or
\`{ file, offset, limit<=500 }\`; it rejects bare/full-file reads. Do not paginate
file windows. Preflight is decided by the 20K character budget: an over-budget
plain-window batch emits no partial source, so trailing targets cannot disappear.

Unexpected misses may include compact raw-source matches. \`CONFIRMED_ABSENT\`
means a complete current-source scan found nothing; \`DECLARATION_ONLY\` means the
exact callable has no paired definition; \`RAW_MATCHES\` signals an index/parser
gap; \`INCONCLUSIVE\` requires a narrower scope. Internal backend, coverage, and
cache details are omitted.

The index normally trails writes by about one second. Compiler, tests, and linters
remain the source of truth for live correctness.
`;
