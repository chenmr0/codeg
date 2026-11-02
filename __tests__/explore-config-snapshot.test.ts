import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import CodeGraph from '../src';
import * as config from '../src/upstream-explore/project-config';
import { createUpstreamExploreGraph } from '../src/mcp/upstream-explore-adapter';

let root: string | undefined;
let cg: CodeGraph | undefined;
afterEach(() => { vi.restoreAllMocks(); cg?.close(); if (root) fs.rmSync(root, { recursive: true, force: true }); });
it('reads optional ranking config once per exploration, not per ranked candidate', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-explore-config-snapshot-'));
  fs.writeFileSync(path.join(root, 'service.ts'), 'export function loadInvoice() { return 1; }\n');
  cg = CodeGraph.initSync(root); await cg.indexAll();
  const load = vi.spyOn(config, 'loadDeprioritizePatterns').mockReturnValue(['vendor/**']);
  const graph = createUpstreamExploreGraph(cg);
  await graph.findRelevantContext('loadInvoice');
  await graph.findRelevantContext('invoice');
  expect(load).toHaveBeenCalledTimes(1);
  load.mockReturnValue(['service.ts']);
  createUpstreamExploreGraph(cg);
  expect(load).toHaveBeenCalledTimes(2);
});
