import { it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import CodeGraph from '../src';
import { EXTRACTION_VERSION } from '../src/extraction/extraction-version';

it('rebuilds legacy JS/TS docs, members and dispatch edges without changing source bytes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-native-explore-upgrade-'));
  const file = path.join(root, 'workflow.ts');
  fs.writeFileSync(file, [
    "import { createAsyncThunk } from '@reduxjs/toolkit';",
    '/** Request contract documentation. */',
    'export interface RequestContract { traceId: string; send(value: number): void; }',
    '/** Account service documentation. */',
    'export class AccountService { owner = "service"; }',
    "export const sink = createAsyncThunk('sink', async (n: number) => n);",
    "export const source = createAsyncThunk('source', async (n: number, { dispatch }) => dispatch(sink(n)));",
  ].join('\n'));
  const hash = () => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const before = hash();
  let graph = CodeGraph.initSync(root);
  try {
    await graph.indexAll();
    expect(graph.getNodesByName('traceId')).toHaveLength(1);
    expect(graph.getNodesByName('AccountService')[0]?.docstring).toContain('documentation');
    const db = graph.getExploreQueryConnection();
    // Reproduce the previous persisted shape, without relying on an old binary.
    db.prepare("UPDATE nodes SET docstring=NULL").run();
    db.prepare("UPDATE nodes SET kind='method' WHERE name='owner'").run();
    db.prepare("DELETE FROM nodes WHERE name IN ('traceId','send')").run();
    const origin = graph.getNodesByName('source')[0]!;
    db.prepare("DELETE FROM edges WHERE source=? AND kind='calls'").run(origin.id);
    (graph as any).queries.setMetadata('indexed_with_extraction_version', String(EXTRACTION_VERSION - 1));
    graph.close();
    graph = CodeGraph.openSync(root);
    expect(graph.isIndexStale()).toBe(true);
    expect((await graph.sync()).filesModified).toBe(0);
    // sync must not pretend to have upgraded extraction of unchanged files.
    expect(graph.isIndexStale()).toBe(true);
    expect(graph.getNodesByName('AccountService')[0]?.docstring).toBeUndefined();
    expect(graph.getNodesByName('traceId')).toHaveLength(0);
    expect((await graph.indexAll()).complete).toBe(true);
    expect(graph.getNodesByName('AccountService')[0]?.docstring).toContain('documentation');
    expect(graph.getNodesByName('traceId')[0]?.kind).toBe('property');
    expect(graph.getNodesByName('send')[0]?.kind).toBe('method');
    expect(graph.getNodesByName('owner')[0]?.kind).toBe('property');
    const sink = graph.getNodesByName('sink')[0]!;
    const source = graph.getNodesByName('source')[0]!;
    expect(graph.getOutgoingEdges(source.id).some(e => e.kind === 'calls' && e.target === sink.id)).toBe(true);
    expect(graph.getIndexBuildInfo().extractionVersion).toBe(EXTRACTION_VERSION);
    expect(graph.isIndexStale()).toBe(false);
    expect(hash()).toBe(before);
  } finally {
    graph.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
