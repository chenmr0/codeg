# Scoped reference recovery

## Stage 1 committed reference sources

A modified-file replacement can preserve incoming edges by semantic identity.
When an old target cannot be matched, stamped incoming edges become pending
references from unchanged source files. These sources are now reported by the
main store, the store-worker response after transaction commit, and single-file
fallback indexing. Sync resolves those sources directly; late fallback stores
have their own second drain.

Resolving base references does not prove synthesized relationships are current.
The store therefore atomically records `index_rewire_synthesis_pending` with
resurrected references before destructive replacement. The rewiring plan is
pure; if the obligation cannot be persisted, the old file has not been deleted.
The worker retains its existing whole-file transaction. On the main thread,
this protects the resurrected references without claiming that all other file
replacement writes have become one transaction. Any present value requires
full synthesis recovery.
Only a successful full tail clears it. Failed stores, failed synthesis and
process interruption cannot certify completion merely because pending rows
were consumed. Existing explicit incomplete/unknown coverage remains separate.

This first stage is a correctness and observability foundation, not a claim
that full synthesis has been eliminated. It is deliberately conservative:
when another file in the same batch later replaces a resurrected caller, the
obligation still survives until full synthesis. Planned writes are not proof
that the write, resolution or derived-edge recovery actually succeeded.

Legacy no-op behavior is unchanged: absent obligations do not create new input
records or trigger a global macro scan/full synthesis. Further producer-specific
recovery requires independent dependency evidence and validation; unknown
impact must retain the full fallback.

Verbose sync output includes `recovery-plan` (reported source files, resolved
references, remaining pending rows, persisted obligation and full-pass choice)
and `fallback-reference-sources` for late stores. These are stage diagnostics,
not wall-time performance guarantees.
