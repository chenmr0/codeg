import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { ExploreSourceSnapshots } from '../src/mcp/explore-source';
import { ExploreSemanticView } from '../src/mcp/explore-semantic';

describe('explore source snapshots against an extracted C++ index', () => {
  let root: string, outside: string, cg: CodeGraph;
  const original = 'namespace sample {\nint perform() {\n  return 17;\n}\n}\n';
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-explore-snapshot-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-explore-outside-'));
    fs.writeFileSync(path.join(root, 'worker.cpp'), original);
    cg = CodeGraph.initSync(root, { config: { include: ['**/*.cpp'], exclude: [] } });
    await cg.indexAll();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.writeFileSync(path.join(root, 'worker.cpp'), original);
  });
  afterAll(() => {
    cg?.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('exposes verified bytes and normalizes equivalent in-root paths', () => {
    const sources = new ExploreSourceSnapshots(cg);
    const snapshot = sources.get('worker.cpp');
    expect(snapshot.status).toBe('fresh');
    expect(snapshot.content).toBe(original);
    expect(snapshot.fingerprint).toBe(cg.getFile('worker.cpp')!.contentHash);
    expect(sources.get(path.join(root, 'worker.cpp'))).toBe(snapshot);
    expect(sources.get('./worker.cpp')).toBe(snapshot);
  });

  it('does not trust old line numbers after inserted lines', () => {
    fs.writeFileSync(path.join(root, 'worker.cpp'), 'int unrelated() { return 88; }\n\n' + original);
    const sources = new ExploreSourceSnapshots(cg);
    expect(sources.get('worker.cpp')).toMatchObject({ status: 'changed' });
    expect(sources.get('worker.cpp').content).toBeUndefined();
    expect(new ExploreSemanticView(cg, sources).enclosingBody('worker.cpp', 3)).toBeUndefined();
  });

  it('detects same-size edits even when their timestamp is restored', () => {
    const file = path.join(root, 'worker.cpp');
    const stat = fs.statSync(file);
    fs.writeFileSync(file, original.replace('17', '92'));
    fs.utimesSync(file, stat.atime, stat.mtime);
    expect(new ExploreSourceSnapshots(cg).get('worker.cpp').status).toBe('changed');
  });

  it('treats a timestamp-only rewrite as fresh', () => {
    const later = new Date(Date.now() + 60000);
    fs.utimesSync(path.join(root, 'worker.cpp'), later, later);
    expect(new ExploreSourceSnapshots(cg).get('worker.cpp')).toMatchObject({ status: 'fresh', content: original });
  });

  it('shares immutable query bytes with semantic recovery and refreshes next query', () => {
    const sources = new ExploreSourceSnapshots(cg);
    const first = sources.get('worker.cpp');
    fs.writeFileSync(path.join(root, 'worker.cpp'), '\n\n' + original);
    expect(sources.get('worker.cpp')).toBe(first);
    expect(sources.get('worker.cpp').content).toBe(original);
    expect(new ExploreSemanticView(cg, sources).enclosingBody('worker.cpp', 3)?.name).toBe('perform');
    expect(new ExploreSourceSnapshots(cg).get('worker.cpp').status).toBe('changed');
  });

  it('reports a deleted indexed source as missing without exposing content', () => {
    fs.unlinkSync(path.join(root, 'worker.cpp'));
    const snapshot = new ExploreSourceSnapshots(cg).get('worker.cpp');
    expect(snapshot.status).toBe('missing');
    expect(snapshot.content).toBeUndefined();
  });

  it('does not use unindexed source bytes as evidence for old graph ranges', () => {
    fs.writeFileSync(path.join(root, 'unindexed.cpp'), 'int fresh() { return 1; }\n');
    expect(new ExploreSourceSnapshots(cg).get('unindexed.cpp')).toMatchObject({ status: 'unverified' });
    expect(new ExploreSourceSnapshots(cg).get('unindexed.cpp').content).toBeUndefined();
  });

  it.each(['', 'size-limit:1000:2000'])('fails closed for unsupported index fingerprints: %s', fingerprint => {
    const stored = cg.getFile('worker.cpp')!;
    vi.spyOn(cg, 'getFile').mockReturnValue({ ...stored, contentHash: fingerprint });
    const snapshot = new ExploreSourceSnapshots(cg).get('worker.cpp');
    expect(snapshot.status).toBe('unverified');
    expect(snapshot.content).toBeUndefined();
  });

  it('fails closed if indexed metadata cannot be read', () => {
    vi.spyOn(cg, 'getFile').mockImplementation(() => { throw new Error('database unavailable'); });
    expect(new ExploreSourceSnapshots(cg).get('worker.cpp').status).toBe('unverified');
  });

  it('rejects lexical escapes and directory symlinks that escape the project', () => {
    fs.writeFileSync(path.join(outside, 'secret.cpp'), 'int secret() { return 999; }\n');
    const sources = new ExploreSourceSnapshots(cg);
    expect(sources.get(path.join(outside, 'secret.cpp'))).toMatchObject({ status: 'unverified' });
    const link = path.join(root, 'outside-link');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const snapshot = sources.get('outside-link/secret.cpp');
    expect(snapshot.status).toBe('unverified');
    expect(snapshot.content).toBeUndefined();
    expect(snapshot.reason).toContain('outside the project');
  });
});
