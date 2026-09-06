import { defineConfig } from 'vitest/config';
import base from './vitest.config';
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['__tests__/rust-scan*.test.ts'],
    pool: 'forks', minWorkers: 1, maxWorkers: 2,
    poolOptions: { forks: { execArgv: ['--liftoff-only'] } },
  },
});
