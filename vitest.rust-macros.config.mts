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
      '__tests__/sync*.test.ts', '__tests__/rust-scan*.test.ts', '__tests__/resolution*.test.ts'],
    pool: 'forks', minWorkers: 1, maxWorkers: 2,
    poolOptions: { forks: { execArgv: ['--liftoff-only'] } },
  },
});
