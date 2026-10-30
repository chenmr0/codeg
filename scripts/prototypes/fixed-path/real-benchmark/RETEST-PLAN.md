# Preregistered full OceanBase retest (2026-10-30)

Exactly **three serial complete cycles**, all using the same committed/build-verified code and instrumentation after the Git worktree fix. Every attempted round and request is retained. No candidate reuse, cache-drop command, best-of selection, automatic failed-round replacement or hidden resource/timeout changes.

Each round:
1. Confirm benchmark-owned participants have exited, all three OS-backed leases are available, durable state idle with no unresolved operation, and no active SQLite sidecars. Preserve all existing runtime files and earlier evidence.
2. Offline copy standalone public A to the actual fixed `codegraph.db`. Checkout A; query it under the fixed load.
3. Append one comment to `src/observer/ob_server.cpp`; run real ordinary incremental sync; require one modified file and complete=true.
4. Restore source edit, checkout B; collect 30-second idle query baseline against A's index.
5. Perform genuine complete B candidate construction, integrity/source validation, safe publication, cleanup and source convergence under 5 processes / aggregate 10 QPS. No cached B candidate substitutes for this step.
6. Await all client/publisher exits; normal close and checkpoint. Copy independently built standalone public B over active fixed path **without deleting runtime**. Verify byte identities and unchanged runtime around the copy.
7. Query B and run ordinary sync; require correct B marker, complete no-change sync, no init.

## Evidence and decisions
- Every request: scheduled/actual start/end; pattern; admission+native reopen; before-file metadata lookup; search; each getNode; after-file metadata lookup; callback total; finish/promise completion. All timing is observational, protocol code unmodified by instrumentation.
- Every phase: construction, candidate validation, source checks, old checkpoint, draining, rename, reopen, resumed, cleanup and final confirmation. Record complete operation output and phase IPC timestamps; explain nested timings rather than adding overlapping durations.
- 500ms sampling: aggregate process RSS/CPU/read/write counters; active/candidate logical and allocated disk. Sampling peaks are lower bounds, not exact maxima.
- Report both all-lifetime and actual operation-window request counts and distributions. Include queued requests and errors, not only successful service time. Negative timer-early delay is not credited.
- Conservative sufficient performance pass: every measured request's total service and scheduled-to-completion latency <=1000ms, no errors/backlog/mixed identity/missing nodes, cutover pause <=1000ms. This is stronger than inferring extra wait by subtracting unrelated medians. Baseline patterns are references, not strict causal pairs.
- A latency failure remains a failure even if later rounds are faster. Finish the three planned rounds unless a data-safety/invalid-state/process/source failure prevents safe continuation; record that blocker instead of quietly replacing a round.
- Full raw traces remain locally available; commit compact summaries and hashes plus exact commands, not generated databases. No production entry integration in this experiment.

## Fixed conditions
OceanBase A `7e2de11a0e3c328dddaaaefedd6e911be36fb58d` to B `9bdfa9e22b618cc4ad0a724010b1bb9567629399`; complete source range. Parse/resolve/macro workers=2; parse timeout=180000ms; all languages enabled; experimental shared-read flag disabled; 5 fixed-arrival clients each500ms. Do not compare with prior50QPS overload as controlled optimization evidence.

Reuse only our dedicated, closed WAL fixture to avoid a second3GB copy exhausting disk; prior logs and runtime survive. Unknown external readers are outside the cooperative protocol, never presumed safe based on PID absence. The full-cycle runner performs fuser and explicit lease/state checks before each overwrite.
