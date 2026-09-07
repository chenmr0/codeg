import { defineConfig } from 'vitest/config';
import base from './vitest.config';
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['__tests__/macro-scan*.test.ts', '__tests__/rust-macros*.test.ts',
      '__tests__/pure-macro-header.test.ts', '__tests__/cpp-declaration-macros.test.ts',
      '__tests__/c-adaptive-macro-recovery.test.ts', '__tests__/c-funcptr-typedef-macro-pollution.test.ts',
      '__tests__/c-macro-identifier-suffix-collision.test.ts', '__tests__/enum-bodyless-macro-collision.test.ts',
      '__tests__/sync*.test.ts', '__tests__/rust-scan*.test.ts', '__tests__/resolution*.test.ts',
      '__tests__/store-diagnostics.test.ts',
      '__tests__/cpp-*.test.ts', '__tests__/c-*.test.ts',
      '__tests__/extraction.test.ts', '__tests__/orphaned-refs-sweep-cpp.test.ts',
      '__tests__/git-paths.test.ts', '__tests__/rust-git-ignore.test.ts',
      '__tests__/rust-macro-artifact.test.ts',
      '__tests__/scan-optimizations.test.ts', '__tests__/symlink-dedup.test.ts'],
    pool: 'forks', minWorkers: 1, maxWorkers: 2,
    poolOptions: { forks: { execArgv: ['--liftoff-only'] } },
  },
});
