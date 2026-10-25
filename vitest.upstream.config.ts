import { defineConfig } from 'vitest/config';
import * as path from 'node:path';
const oracleRoot = process.env.CODEGRAPH_UPSTREAM_ORACLE ? path.resolve(process.env.CODEGRAPH_UPSTREAM_ORACLE, '../..') : path.resolve(__dirname, '../../community-v1.6.2-p0-20261022/community');
export default defineConfig({ resolve: { alias: { '@upstream-v162': path.join(oracleRoot, 'src') } }, test: {
 globals: true, environment: 'node', include: ['__tests__/upstream-v162/*.test.ts'],
 testTimeout: 60000, hookTimeout: 120000, maxWorkers: 2, minWorkers: 1,
 env: { CODEGRAPH_ALLOW_UNSAFE_NODE: '1', CODEGRAPH_ALL_LANGUAGES: '1', CODEGRAPH_NO_DAEMON: '1' }
} });