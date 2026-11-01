# Portable fixed-path indexes

The public database stays at `.codegraph-wx/codegraph.db`. A supported native
CodeGraph build stores the graph, file inventory, extraction/configuration stamps,
source-ownership proof, library identity, snapshot revision and outstanding source
verification inside this database. It remains the only portable index artifact.
The `.runtime` directory contains local coordination and recovery evidence.

## Supported copy procedure

Stop every producer and consumer process, including native workers and external
SQLite tools. In the SDK, wait for work, call `close()`, then await `whenIdle()`
again for final maintenance. Copy a complete, successfully checkpointed database;
do not discard WAL/journal files to make a database look standalone. The target
must also have completed normal shutdown. Keep the target's existing `.runtime`.

An existing registered portable coordination domain detects a different database
identity or managed snapshot revision. It excludes publishers, mutations, writers
and connections with actual OS-backed leases; verifies integrity, foreign keys and
completeness; records a database-owned full-hash import obligation; then updates
its local binding and cache revision. The next ordinary or scoped sync consumes
that obligation only after source, configuration and recovery work converge.
A managed writer rotates the snapshot revision before graph mutation, under the
same coordinator gate used to compare the database and binding. Normal concurrent
readers therefore do not mistake a managed write for an external replacement.

For a DB-only directory, or complete loss of runtime, queries are read-only.
After explicitly stopping **all** relevant programs, run:

```sh
codegraph migrate-storage /path/to/project --offline
codegraph sync /path/to/project
```

This creates local coordination and schedules the same full-hash verification.
It does not require copying, deleting or editing runtime manually. If all indexed
sources are absent, import sync fails and retains both the graph and its pending
obligation. Restoring matching sources permits retry. A partial runtime loss,
unknown replacement identity, corrupt input or unresolved publication can fail
open explicitly instead of offering an unprotected query.

## Why offline confirmation is sometimes necessary

A missing runtime cannot distinguish first import from deletion while another
process still holds unlinked lock files. No database identity, clean flag, PID
probe or process scan proves that all old readers exited. This change does not
introduce a new stable arbitration namespace outside runtime and does not claim
one exists. It therefore refuses automatic mutable registration when the binding
or coordination domain is absent. An older fixed layout without a portable
binding also needs explicit offline registration before accepting a portable
replacement. An unmodified legacy layout keeps its existing compatibility path.

The exclusion protocol applies to cooperating fixed-path clients. Community
versions, unsupported legacy runtimes and external SQLite tools do not necessarily
participate. They must be stopped explicitly. Raw overwrite while any client is
running is unsupported; rejecting subsequent admission cannot undo the overwrite
itself or protect an already executing external reader.

## State and recovery

| State | Location | Reason |
| --- | --- | --- |
| Nodes, edges, files, unresolved/retry work, extraction and config stamps | Business DB | Already belongs to the image; travels with it |
| `portable:index-v1` identity and managed snapshot revision | Business DB | Detect independent indexes and different managed snapshots of one index |
| `portable:import-pending-v1` | Business DB | Full-hash import verification survives a crash or another copy |
| `fixed-path:source-catchup-v1` | Business DB | Existing publication obligation is preserved, never inferred from a retired runtime record |
| Local image acknowledgement/cache revision | Coordinator DB in runtime | Local cache of the accepted image, not authority over a replacement |
| Reader/writer/mutation/publisher/admission leases | Separate runtime SQLite files | Must outlive individual business handles and retain distinct lock modes |
| Rename operations, owned candidates and backups | Runtime | Crash recovery must exist independently of the file being replaced |
| Daemon/socket/logs and legacy cost observations | Runtime | Host-local or disposable; fixed-layout planning does not use legacy cost history |

An import interrupted after writing and closing its DB obligation but before
acknowledging its binding reopens with the same obligation. A native close failure
retains the actual handle and OS leases until process exit. If that interruption
leaves a nonempty log, recovery remains an explicit offline operation with the
original coherent SQLite bundle; automatic adaptation does not checkpoint a
guessed bundle. Managed publication commits the new
binding with its existing coordinator commit. Existing publication recovery and
cleanup remain responsible for their recorded files; a foreign root cannot be
silently replaced with a retired database. A failed or incomplete incoming index
is rejected with its data retained. Empty schema-only databases may be registered.

Automatic rebuild eligibility still requires exact supported source provenance.
Portable metadata never grants ownership to a custom database. Custom tables and
unknown metadata continue to prevent replacement. A supported official old index
can retain its existing structural provenance after registration and a validated
configuration fingerprint, without installing a fabricated ownership proof.

## Limits

The portable identity is an image identifier, not a signature or proof that an
export is complete. A valid-looking main file copied without its committed WAL
cannot always be distinguished from an older valid snapshot. Mixing a replaced
main file with a target's old SQLite sidecars is outside the copy contract. The
implementation rejects observed nonempty WAL/journal files when adapting a
mismatched image; it does not claim to detect deleted WAL or repair mixed bundles.
Preserve the original bundle and recover using the producing program.

Snapshot revision tracking covers managed CodeGraph writes. Arbitrary SQL edits
or old programs can preserve a revision while changing its contents; such files
require explicit offline registration and verification. This is not a general
SQLite replication protocol. Native SQLite is required for portable coordination;
legacy/unsupported runtimes are outside that protocol. Windows filesystem and
process behavior has not been executed in this Linux environment. CI includes the
portable regression suite on the repository's existing platform matrix.
