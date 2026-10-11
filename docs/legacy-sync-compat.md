# Known legacy index compatibility

A successful pre-proof index can remain usable without silently paying for a
whole-graph synthesis verification on its first ordinary sync. This is an
availability policy, not evidence that all historical derived edges are correct.

Admission is deliberately narrow: package `1.1.1`, exact extraction stamp 24–34,
a nonempty indexed history, stored `complete` coverage with an empty diagnostic
list, no completion-proof value, no verification-start intent, and no pending
reference, synthesis, conformance, language-scope, file-failure or retry journal.
Extraction 35 is ambiguous across the introduction of completion proofs, so it
and unknown/malformed provenance retain the existing conservative behavior.
Historical failed references are not themselves unfinished work.

Status inspection does not write a compatibility marker. An admitted sync,
under the existing writer lock, records `index_legacy_synthesis_unverified=1`.
The public coverage remains `unknown` with `legacyUnverified: true`; CLI/MCP
say the graph is usable but synthesis coverage is unverified. Available symbols
and relationships are queryable, while absence is not advertised as proven.
The engine does not invent a completed proof or upgrade extraction stamps.

Ordinary changes still use the incremental pipeline. Real failures and pending
work retain their recovery behavior. Explicit raw incomplete/unknown coverage
is not hidden by an existing compatibility marker. A full verification/index
attempt removes that marker and writes durable start intent before its work,
preventing an interrupted attempt from being reclassified using old build
stamps. `codegraph index` already forces replacement of unchanged files when
extraction is stale; `--force` (clear first) is unnecessary for this upgrade.
Successful full verification writes the existing completion proof normally.

For an admitted legacy index with no macro fingerprint, unchanged sync also
avoids the first whole-macro fingerprint scan. The old macro state is captured
immediately before the first node deletion/replacement (including worker
handoff); the usual post-write invalidation remains. This does not change macro
dependency semantics or skip a fingerprint that already exists.

This change does not certify arbitrary old databases, infer health solely from
missing markers, or repair unknown historical corruption without verification.
Back up the index with old writers stopped before changing engine versions.
