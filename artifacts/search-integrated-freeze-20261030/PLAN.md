# Search supplement and low-overhead diagnostic integration

Integrate reviewed beac767 and 0bbbc6e onto f41b859. Only production change is the indexed exact-name supplement with embedded-NUL fallback; no schema change or new public API.

Benchmark-only timedSearch intercepts SQL preparation/execution in the existing synchronous call, classifies FTS/exact-name supplement/other, and captures counts and durations. It issues no extra SQL, logs outside the measured request, restores QueryBuilder.db in finally, and charges cached statements to the current observation only. It must wrap searches from the first search on a new prototype graph; statements already cached before instrumentation are not retroactively instrumented. Non-SQL parse, row conversion and ranking remain within searchMs minus SQL durations (observer overhead included); no causal disk-I/O claim.

Validation: targeted real client/journal plus receiver/error/cache-evidence tests; full prototype suite; 68 search regressions; diagnostic-overhead alternating small fixture measurement. Preserve initial cached-statement metric failure and correction. Then freeze before new CI and all three real-repository full-build rounds. Earlier benchmark rounds do not validate this changed source.
