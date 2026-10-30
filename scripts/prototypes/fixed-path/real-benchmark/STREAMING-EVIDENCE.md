# Incremental request evidence

`load-profile.mjs` retains the original final aggregate and client JSON outputs.
Each client also creates `<client-output>.ndjson` exclusively (`wx`), recording a
start record, every completed successful/failed request and a normal stop record.
Existing evidence is never truncated. The benchmark protocol is unchanged.

Requests are timed before serialization/enqueue. Logging pressure is nevertheless
included in the next request's scheduled-arrival latency, not subtracted away.
A 250 ms timer or 32 pending records triggers serial asynchronous file appends.
There is no synchronous file write per request. A 4 MiB outstanding byte limit
fails the attempt rather than silently dropping evidence. Normal completion drains
all writes before emitting the final report. Reports include enqueue CPU elapsed
time, asynchronous write elapsed time, bytes, batch counts and peak backlog.
Write time includes I/O scheduling and is not CPU time.

## Interruption boundary

Completed appends preserve evidence after a producer process exit/SIGKILL.
An event-loop delay or stalled filesystem can exceed 250 ms: this interval is not
a durability deadline. Queued/in-flight trailing records can be lost or leave a
partial final line after termination. Only complete newline-delimited JSON records
are evidence; report any truncated final line. Malformed complete records are
errors, not records to silently skip. A missing stop/final aggregate means the
attempt is incomplete, even when all available request records look successful.
No `fsync` is performed; this does **not** establish power-loss durability.

The interrupted d14b35c OceanBase attempt remains separate. This feature cannot
reconstruct its unflushed request buffers and does not convert it into a pass.

## Reproduction

```
node --liftoff-only --test scripts/prototypes/fixed-path/benchmark-request-journal.test.mjs
node scripts/prototypes/fixed-path/real-benchmark/journal-overhead.mjs /new/evidence/directory
```

The second command preregisters three baseline/journal pairs at 10 QPS, 100
synthetic records per run, with alternating order. It records every outcome.
This measures diagnostic logging overhead only, not real CodeGraph query latency
or the large-repository replacement performance gate. The full frozen large-repo
experiment must still include journaling enabled and count all scheduled latency.

Linux Node 24.22.1 diagnostic run (2026-10-30), all six runs retained under
`artifacts/request-journal-20261030/`: journaling enqueue p95 **0.035–0.086 ms**,
max **0.275 ms**; scheduled-lag p95 baseline **1.054–1.101 ms**, enabled
**1.079–1.134 ms**. Each enabled run persisted all 100 records in 40 batches,
56,090 bytes, peak backlog 1,683 bytes. These small synthetic runs do not prove
absence of I/O interference during a full large-repository rebuild. The six
regressions passed on Linux, including a real five-client CodeGraph load and
normal sidecar retirement. Windows execution remains for CI, not inferred here.
