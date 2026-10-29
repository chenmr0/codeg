# Windows gate: bounded decision, not phase-two approval

Status at CI [40910525611](https://github.com/chenmr0/codeg/actions/runs/40910525611),
remote `00f03a48` / prototype `b36aa642`: Linux 125/125 plus three contention
repeats passed; Windows 116/125 failed nine cases. Real Windows symlink checks
passed without skips. These facts do **not** qualify the complete prototype.
Earlier successful Windows runs and the full Linux OceanBase result remain valid
for their recorded versions/scopes, not a substitute for this failed gate.

## Established evidence

- Prior Windows timeline showed one coordination COMMIT holding the lock for
  556.7 ms without retries, followed by another 97 ms COMMIT. A 500 ms admission
  attempt can therefore fail even without redundant opening or expensive graph
  construction inside its gate.
- The bounded-admission experiment still failed ordinary switching and long-
  request cases with admission timeouts. Its 600 ms real-lock tests could report
  BUSY. This is consistent with the owner being checked after the gate failure:
  the owner can have released before the probe; a per-native-step probe timeline
  has not yet established that cause for every failed case. A negative *current* probe does not prove that the
  earlier contention was not caused by a publisher.
- Long-lock tests observed about 1,267 ms before returning. The implementation
  inspected the owner before testing an already expired total deadline. That
  ordering is a correctness bug, not an acceptable relaxation of the 1 s gate.
- The minimal follow-up checks error eligibility in memory, then the deadline,
  then the owner probe, then the deadline again regardless of the probe result.
  I/O errors, corruption, and ambiguous COMMIT outcomes retain their original
  errors. This fix does not solve the owner-release race or establish latency.

## Bounded alternatives

| Alternative | What is safely established | Remaining limitation / decision |
| --- | --- | --- |
| Existing OS lease with a deterministic held-owner witness | A particular probe observes a real owner lock; IPC can keep a test owner alive until the probe completes. | Useful diagnosis, not a replacement acceptance test: it cannot prove which actor caused an earlier gate lock, nor fix a real owner exiting before a probe. Native probe work can still exceed the remaining deadline. |
| Owner witness before each request attempt | A witness can authorize another **pre-action**, same-deadline attempt without executing business work twice or changing publication state. | Adds probe/open work to admission; misses a publisher starting after the witness and may misattribute later contention. It does not prove 1 s latency. Not implemented. |
| Events / a persistent independent coordinator | Requests can queue asynchronously with deadlines rather than repeatedly probe SQLite; a synchronous SDK can delegate ownership to an independent process. | Events alone are not publication authority. Lost events, reconnection, crashes, and stale sessions still require durable state and OS leases. Does not remove durable COMMIT/native I/O latency. A new protocol/design effort, not a small fix; not implemented. |

None supplies a proved 1 s bound on arbitrary uninterruptible filesystem I/O.
A single syscall cannot safely be interrupted by extending a JavaScript timer.
The requirement remains: normal short-query switching must meet the observed
1 s gate, with drain budget at most 1 s. We do not enlarge either threshold and
announce success, discard failing Windows runs, retry until one green run, or
use Linux latency as Windows evidence.

## Decision and next evidence, if further work is authorized

Retain the isolated prototype, deterministic reproductions, and failed CI.
Complete only the deadline-order correction and its tests. **Do not start
production/default integration, migration, or npm publication.** The existing
verification branch is for review, not a merge recommendation.

A further bounded investigation would first require a common arrival-to-return
timeline splitting owner probe `lstat/open/PRAGMA/lock/close`, each publication
COMMIT, all admission attempts, and query completion/retirement. Test both a
witness held through observation and a real owner releasing earlier; neither may
replace the other. Report timeout rates and maxima over fixed Windows repeats
under the same load, retaining failures. A coordinator redesign needs a separate
failure/reconnection/synchronous-SDK design and acceptance matrix before coding.

Large-repository measurements and the separately successful offline update
cycle are reviewable in `artifacts/real-oceanbase-20261029/REPORT.md`; they do not
remove this Windows blocker. Raw failed CI traces remain downloadable from the
linked run artifacts; local retained evidence is under
`ci-fixed-path-evidence/windows-round9` (or the run-specific evidence directory).
