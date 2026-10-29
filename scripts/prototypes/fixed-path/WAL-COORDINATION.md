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

## First Windows structural run: retained failures

CI `40938607438` passed Linux 152/152 and Windows 150/152 (strict symlinks
passed). Windows still failed simultaneous first bootstrap and the existing
650 ms replacement-fence admission test (814 ms observed, unchanged test limit).
Normal 1001-file query max/pause were 165/82 ms and source-checker max/pause
170/64 ms; those measurements do not override the two failed functional gates.

The next minimal correction makes lease probes nonblocking from their initial
SQLite PRAGMA (`busy_timeout=0`), rather than first using 25 ms and changing to
zero afterward. It also initializes each new lease's table and row in a single
FULL-durability transaction rather than two auto-commits inside the coordinator
bootstrap writer transaction. Neither change increases an admission/drain budget,
weakens a lease lock, removes a failure assertion, or changes the test load.
CREATE/INSERT/COMMIT fault tests preserve already committed earlier lease files,
roll back the current incomplete lease and never commit coordination state.
Remnants are retained and rejected on restart, not deleted to force success.


## Second structural run and narrowly scoped corrections

CI `40940851157` remained failed: Linux 161/162, Windows 160/162.
The separate fixed three-round bootstrap workflow `40941047624` passed Linux
2/3 and Windows 0/3. These are retained failures, not replaced by local results.
A fixed 40-batch / five-process cold-start diagnostic identified three failures
in 200 starts, all extended `SQLITE_BUSY_RECOVERY` (261), not exhausted budgets.
Coordinator initialization now recognizes the primary BUSY byte **only before
any protocol action**. Its existing absolute budget remains unchanged; LOCKED,
IOERR (including 1546), corruption, and action/COMMIT errors are not replayed.
The same fixed-count diagnostic after that correction completed 200/200 locally.

The other Windows error was `SQLITE_IOERR_TRUNCATE` (1546) during a coordinator
state open after the sole reader was killed at draining. Node 24.22.1 embeds
SQLite 3.53.4; its Windows first/quiescent WAL attachment can truncate shared
memory. This is a supported mechanism hypothesis, not proof of the failing
Win32 operation: the CI exception contains neither filename nor GetLastError.
No IOERR retry or error suppression is added.

Publisher/recovery ownership now includes one coordinator connection that has
actually completed a state SELECT. It holds no transaction or snapshot and
lasts through metadata updates and post-fence PASSIVE maintenance. Keeper close
errors after publication are reported without rolling back the new database.
This avoids publisher-created zero-connection gaps during an operation; it does
**not** prove all Windows last-close/first-open races impossible. Cold participants
before and after final keeper closure and reader death during draining are tested.
Windows must rerun the actual failures and full gates on this revision.

References: https://www.sqlite.org/rescode.html ;
https://sqlite.org/walformat.html ;
https://raw.githubusercontent.com/nodejs/node/v24.22.1/deps/sqlite/sqlite3.c .
