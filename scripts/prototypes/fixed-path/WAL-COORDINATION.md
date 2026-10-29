# Isolated WAL coordinator experiment

This is a phase-one structural experiment, not production integration, a migration,
a default feature, a release package, or a merge recommendation. The preceding
DELETE-coordinator Windows failures remain recorded in `WINDOWS-BLOCKER.md`.
Their timeouts are not fixed by changing a threshold in this experiment.

## Separation of responsibilities

Only `.runtime/fixed-path-prototype/gate.sqlite` (state, operations, costs) uses
WAL, with `synchronous=FULL`. `publisher.sqlite`, `connections.sqlite`, and
`writers.sqlite` remain DELETE-mode SQLite OS-lock leases. WAL EXCLUSIVE write
transactions do **not** substitute for these real lease fences.

The actual graph is still `.codegraph-wx/codegraph.db`. There is no CURRENT
fallback, symlink, or compatibility copy. Public distribution still contains one
sealed standalone graph database, not the coordinator or its WAL/SHM.

No live DELETE-to-WAL conversion is implemented. An established DELETE
coordinator is rejected explicitly. Run on fresh isolated fixtures, or prepare
an explicitly isolated experiment only after all previous participants exit.
Never run two protocol versions or separate coordination directories against the
same active graph. Unknown direct SQLite users remain outside the protocol.

## Read admission

A Participant keeps one coordination connection, but no read transaction or
cursor is retained across requests. Each read admission:

1. Acquires/reuses its real connection SHARED lease.
2. Begins a **new** coordination read transaction and reads durable state.
3. Counts the request active only when that snapshot is idle, then ends it.
4. Opens the graph (if cold) under the lease, outside all global transactions.

An earlier cached/preliminary idle observation cannot authorize a new open.
Reading old idle while a publisher's draining transaction is uncommitted is
safe: the already acquired lease prevents replacement until this reader ends.
A publisher that acquired EXCLUSIVE first prevents the reader acquiring its
lease, even if the WAL snapshot already says idle after final commit.

Write admission remains separate: a durable revision intent precedes business
writes, and writers remain protected by the writer lease. Ordinary queries do
not reserve a coordinator writer or DELETE cost history. Conservative cost
invalidation is done at startup outside read admission and at publication commit.
Missing cost history never forces init.

finish/idle retirement reads a fresh WAL state without a durable write. It never
closes an active reader. Closing a native graph succeeds before its lease is
released; a close failure retains protection. Corruption and unexpected
coordination-file replacement remain errors, not implicit idle or fallback.

## Publication and recovery

Build, full candidate validation, source checks, and checkpoint precede drain.
After durable draining and actual connection EXCLUSIVE acquisition, publication
persists a single replacing intent with old/candidate identities and paths.
Both before/after rename fault hooks and old-moved/new-moved hooks remain, but
those intermediate hooks no longer incur redundant state commits.

Recovery of an intent acquires publisher and connection EXCLUSIVE leases first,
then checks exact file identity combinations. Unknown combinations preserve
files and fail closed. Neither path existence nor a guessed phase authorizes
restoration. A committed outcome and idle/revision/cost update are one durable
transaction; the connection EXCLUSIVE lease remains held until its COMMIT has
returned. A crash/hook failure after that commit cannot roll back B or its writes.
The state may be readable as idle before the fence releases; lease-first readers
still cannot open the database prematurely.

The synchronous SDK cancellation write still competes for WAL's single writer.
It remains independent from the same event loop's older asynchronous reader;
WAL is not an excuse to block that loop waiting for its own callback.

## WAL maintenance

Automatic checkpoint on each coordination COMMIT is disabled. After publication
fences are released and state is idle, or after successful recovery, a separate
PASSIVE checkpoint attempts maintenance. It records `busy`, `log`,
`checkpointed`, and whether work is partial/deferred. A persistent reader may
prevent completion; a later publication/recovery may retry. PASSIVE does not
promise to shrink the WAL file. No runtime WAL/SHM is manually removed.

Maintenance I/O failure is reported in publication metrics or recovery evidence;
it cannot roll back committed graph data. SQLite still manages checkpoint/close
on final connection shutdown. Corrupt database/WAL handling must preserve a
recognized committed authority or report failure, never guess a previous graph.

## Verification boundary

`WAL-TEST-MAPPING.md` identifies assertions that depended on DELETE mechanics and
how their safety objective is tested here. A WAL writer holding uncommitted idle
metadata should **not** make queries wait; actual publication exclusion is tested
with the connection lease instead. The old failed Windows artifacts are retained.

The unchanged budgets are 1 second for draining and the requested normal short-
query switching gate; queries are measured end-to-end, not only during rename.
Native filesystem calls cannot be forcibly interrupted, so no hard realtime or
Windows power-loss guarantee is claimed. Windows and Linux must both run the
full adapted suite, strict real symlinks, fixed-count contention repeats, and the
new deterministic cross-process matrix before considering any later phase.

An interrupted *first bootstrap* that leaves lease files without a committed
state table is rejected and preserved for explicit diagnosis; it is not silently
reinitialized as idle. This prototype does not promise automatic repair of that
incomplete setup or arbitrary coordinator corruption. Normal offline graph
replacement does not delete or recreate an established coordinator.
