# Migration retry / cleanup-authority regression

Run after a full build, with no concurrent rebuild:

```sh
CODEGRAPH_MIGRATION_RETRY_EVIDENCE="$PWD/artifacts/migration-retry-final" \
  node --liftoff-only scripts/tests/fixed-path-migration-retry.test.cjs
```

`CODEGRAPH_TEST_PACKAGE` may point to the actual installed package. The same tests use production SDK, migration/recovery, native SQLite, actual subprocess exits and cross-process leases. All fixtures are retained. Root-name sets, recursive runtime files/bytes, task and business-copy counts are saved at each phase. A completed retry must preserve custom SQL data, return the latest post-rollback symbol, reopen in another process, satisfy the complete root contract, reclaim old databases/tasks within ten seconds without test deletion, and tolerate repeated migration.

The reviewer-provided P1 sequence is reproduced by intercepting only the actual marker rename and throwing EIO, after cleanup inventory is durable but before layout commitment. Other tests cover three consecutive failures, repeated actual exits, legal incremental sync after rollback, second-attempt exits, recovery exits around durable rollback/revocation, a prior-version v1 aborted inventory, two overlapping migration processes and a separate live legacy lease holder.

Safety counterexamples require changed or unknown artifacts to remain intact: a new unknown entry after rollback, a root/CURRENT source conflict, postcommit historical modification, postcommit unknown entries, and source mutation before rollback is confirmed. These are deliberately blocked cases, not claimed successful layout convergence. No hash validation is bypassed, no root/old/task file is removed by the harness, and the existing cleanup authority is not manually repaired by the test. The v1 compatibility fixture changes only the serialization version to represent the older on-disk format.

Windows execution is required separately; successful Linux subprocess tests do not prove Windows rename/handle behavior. These tests do not assert daemon success or resolve cold-start-tail performance. Original failing reproductions and raw logs should be retained with the final passing evidence rather than erased.

For the valid legacy database in the precommit-unknown-artifact scenario, preservation is checked with a canonical hash of **every user/FTS table's schema and all rows**, not its raw main-file hash: the explicitly authorized offline SQLite checkpoint may legitimately normalize WAL/DELETE page-header fields before rejecting an unknown filename. The unknown file itself remains byte-for-byte unchanged. Raw-byte preservation checks remain in place for conflicting source images, source changes before rollback, and postcommit tampering; this distinction does not bypass the product's cleanup-identity hashes.
