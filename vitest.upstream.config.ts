import { defineConfig } from 'vitest/config';
import * as path from 'node:path';
// Source checkout for the two optional UI-oracle imports; independent from
// CODEGRAPH_UPSTREAM_ORACLE, which switches the indexing engine under test.
const oracleRoot = process.env.CODEGRAPH_UPSTREAM_SOURCE
  ? path.resolve(process.env.CODEGRAPH_UPSTREAM_SOURCE)
  : process.env.CODEGRAPH_UPSTREAM_ORACLE
    ? path.resolve(process.env.CODEGRAPH_UPSTREAM_ORACLE, '../..')
    : path.resolve(__dirname, '../explore-upstream');
export default defineConfig({ resolve: { alias: { '@upstream-v162': path.join(oracleRoot, 'src') } }, test: {
 globals: true, environment: 'node', include: ['__tests__/upstream-v162/*.test.ts'],
 testTimeout: 60000, hookTimeout: 120000, maxWorkers: 2, minWorkers: 1,
 env: { CODEGRAPH_ALLOW_UNSAFE_NODE: '1', CODEGRAPH_ALL_LANGUAGES: '1', CODEGRAPH_NO_DAEMON: '1' }
} });