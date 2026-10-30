# Fresh fixed-path initialization admission

This is controlled phase-two infrastructure, not default enablement. The production
entrypoints must integrate the checks below; this module alone does not fence them.

## API and required ordering

- `initializeFixedPathStorage(dataDir, buildClosedCandidate, options?)` creates only
  initial schema/storage in a private candidate. The callback is synchronous and must
  close every native database handle before returning; it must not index source files.
- `recoverFixedPathInitialization(dataDir)` runs before normal project database opens.
  It acquires the same OS-backed owner lease as initialization; a live initializer
  cannot be displaced by PID, age or a retry deadline.
- `hasFixedPathInitializationIntent(dataDir)` is a presence-only directory-discovery
  hint. Damaged intents still select this directory rather than falling back elsewhere.
- `assertNoFixedPathInitialization(dataDir)` rejects pending unregistered root access.
  A valid committed fixed layout can admit through its normal controller even when
  initialization cleanup is deferred. Once the marker is committed, a SQLite BUSY
owner lock only means initialization cleanup is still active; recovery may return to
normal fixed admission without synchronously waiting for its own initializer. Other
owner errors are not swallowed.

**Low-level open ordering matters:** check root database existence before checking
initialization intent, then check fixed layout/admission again immediately before
opening SQLite. If root is absent, fail immediately; do not allow a check-before-install
race to open a root that appears later as an unleased legacy connection. Private
candidate paths are not root database opens. Bare fixed root creation must not bypass
this initializer. All current-version CLI/MCP/daemon/SDK/probe/low-level entries need
these rules; old binaries and external SQLite tools remain outside the protocol and
must be kept offline.

`canonicalFixedPathDataDirectory()` (exported from `fixed-path-layout`) rejects a
symlink data directory itself, but resolves aliases of its parent project. The
initialization and layout journals therefore store the same real paths across aliases.

## Protocol

1. Create a uniquely owned operation directory and a durable `building` intent under
   `.runtime/fixed-initialization/`. The intent precedes both root creation and the
   legacy `codegraph.lock` token, including a crash between intent and lock creation.
2. Acquire the exact recorded legacy writer token. The SQLite OS owner lock serializes
   current initializers/recovery and proves when an earlier process has exited.
3. Build private schema, close all handles, validate/checkpoint/seal the complete
   SQLite file, persist `sealed` plus digest. No root is visible yet.
4. Recheck root absence, install the sealed candidate at `codegraph.db`, persist
   `installed`. The durable intent blocks known-version legacy reads throughout.
5. Release only the recorded legacy token and call the existing layout migration
   registrar. The initialization intent remains a fence during that handoff.
6. Once the fixed layout marker commits, it is authoritative. Initialization recovery
   becomes cleanup-only: later public offline replacement and confirmed root writes
   are never reverted or compared against the original candidate digest.
7. Persist terminal `cleaning` and its committed/aborted outcome before deleting
   operation artifacts. Remove the intent last. Owner-unlink/rmdir/intent-unlink
   failures and process exits can resume from an owned empty/missing directory.

Before sealing, an exited failed builder's clearly owned candidate/logs can be
removed; unknown artifacts or any unexpected root preserve evidence and fail closed.
After sealing, recovery completes only the exact known candidate/installed root.
No existing root, CURRENT, foreign writer, or valuable root WAL/SHM is overwritten
or deleted to force initialization.

## Exceptional native-close ownership

A callback exception is **not** evidence that its native handle closed. Without proof,
the initializer retains its actual OS owner handle until process exit. Another process
cannot recover/delete the candidate while that failed handle may still exist.
`builderClosedOnError()` is an optional explicit exceptional-path proof supplied by
the owner of construction/close. It must return true only after successful real close;
an attempted close, caught exception, fulfilled/rejected Promise or elapsed time is
not proof. Returning a Promise violates the synchronous callback contract and retains
the owner until process exit even after the Promise settles. Internal sealing close
failures retain ownership as well. Registration failure before the fixed marker
commits also retains initialization ownership conservatively: the registrar may have
failed closing a native root-validation handle. Recovery is then deferred until the
process exits rather than assuming those root handles disappeared.

Committed cleanup failures are diagnosed and preserve evidence while normal fixed
admission remains usable. A later startup retries cleanup. Unreferenced directories
left before the first intent is committed are retained conservatively, never deleted
by age. Directory fsync is not claimed on Windows; process-exit tests do not establish
power-loss durability.

## Regression

```sh
npm run build
node --liftoff-only --test scripts/tests/fixed-path-initialization.test.cjs
node --liftoff-only --test scripts/tests/fixed-path-layout.test.cjs
```

These tests include current/independent-process admission checks, real exits at initial
and cleanup phases, native-close failure with an independent blocked recovery process,
public overwrite/new-write preservation, unknown roots/logs, and parent alias recovery.
Production entrypoint integration and Windows execution remain separate requirements.

## Low-level legacy root creation

`withFixedPathInitializationCreationGate(dataDir, action, {closedOnError?})` holds the
same OS owner while a native legacy root constructor runs. It rejects initialization
intent or an existing fixed marker. Managed-generation/private-candidate creation is
not this path. The root must actually exist before the gate releases: an in-memory
sql.js constructor must flush under the gate first, otherwise a later WASM flush could
overwrite a concurrently initialized fixed root. Missing root, Promise return, or an
exception without `closedOnError()` proof retains ownership until process exit.

This helper requires `node:sqlite` and contains no implicit lockless fallback. The
calling layer must keep its explicit Node 18 / pure-legacy compatibility policy;
mixed unsupported runtimes cannot concurrently perform first fixed registration.
Existing fixed markers/intents must always reject unsupported legacy opens rather
than silently downgrade. No fixed initialization is attempted without native support.
