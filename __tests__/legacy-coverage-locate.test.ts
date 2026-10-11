import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import type { QueryBuilder } from '../src/db/queries';
import { runLocate } from '../src/locate/engine';
import { extractLocateDocument } from '../src/locate/signals';

let directory: string;
let cg: CodeGraph;
const queries = () => (cg as unknown as { queries: QueryBuilder }).queries;
const locate = () => runLocate({
  projectPath: directory, document: extractLocateDocument('Find `target`.'),
  timeoutMs: 10_000, maxCandidates: 10, maxTokens: 6000, maxTokensPerClue: 1500,
}, () => {});

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-legacy-coverage-locate-'));
  fs.writeFileSync(path.join(directory, 'api.c'), 'int target(void) {\n  return 1;\n}\n');
  cg = CodeGraph.initSync(directory);
  expect((await cg.indexAll()).complete).toBe(true);
});

afterEach(() => { cg?.close(); fs.rmSync(directory, { recursive: true, force: true }); });

describe('locate persisted legacy coverage advisory', () => {
  it('reports persisted legacy uncertainty without marking useful results partial', () => {
    queries().applyMetadataChanges({
      index_legacy_synthesis_unverified: '1', index_synthesis_completed_version: null,
    });
    const result = locate();
    expect(result.candidates.some(candidate => candidate.symbol === 'target')).toBe(true);
    expect(result.notes).toContain('旧版索引可用，但合成关系覆盖尚未验证；运行 codegraph index 验证并升级覆盖。');
    expect(result.partial).toBe(false);
    expect(result.stopReasons).not.toContain('index_incomplete');
  });

  it('does not warn after completion proof exists, even with a stale legacy marker', () => {
    queries().setMetadata('index_legacy_synthesis_unverified', '1');
    expect(locate().notes.join('\n')).not.toContain('旧版索引');
  });

  it('retains the existing incomplete stop reason', () => {
    queries().applyMetadataChanges({
      index_completeness: 'incomplete', index_legacy_synthesis_unverified: '1',
      index_synthesis_completed_version: null,
    });
    const result = locate();
    expect(result.partial).toBe(true);
    expect(result.stopReasons).toContain('index_incomplete');
    expect(result.notes.join('\n')).not.toContain('旧版索引可用');
  });
});
