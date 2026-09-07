import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { loadGrammarsForLanguages } from '../src/extraction/grammars';

beforeAll(() => loadGrammarsForLanguages(['cpp']));
describe('sync preserves cross-file target identity', () => {
  let cg: CodeGraph | undefined;
  let directory: string | undefined;
  afterEach(() => { cg?.destroy(); if (directory) fs.rmSync(directory, {recursive: true, force: true}); });
  const db = () => (cg as any).db.db;
  const edges = () => db().prepare(`SELECT source,target,kind,line,col,metadata,provenance
    FROM edges ORDER BY source,target,kind,line,col,metadata,provenance`).all();
  async function setup() {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-graph-identity-'));
    fs.writeFileSync(path.join(directory, 'provider.cpp'),
      'int api(int x) { return x; }\nint api(double x) { return 2; }\n');
    fs.writeFileSync(path.join(directory, 'caller.cpp'), 'int caller() { return api(1); }\n');
    cg = CodeGraph.initSync(directory);
    await cg.indexAll();
  }
  it('a tail comment preserves the complete edge set without reindexing callers', async () => {
    await setup();
    const before = edges();
    const callerTime = cg!.getFile('caller.cpp')!.indexedAt;
    fs.appendFileSync(path.join(directory!, 'provider.cpp'), '\n/* harmless comment */\n');
    const result = await cg!.sync({ paths: ['provider.cpp'] });
    expect(result.filesModified).toBe(1);
    expect(cg!.getFile('caller.cpp')!.indexedAt).toBe(callerTime);
    expect(edges()).toEqual(before);
  });
  it('line shifts rewire to the same overload signature, not the reused ID', async () => {
    await setup();
    const caller = cg!.getNodesByName('caller')[0]!;
    const original = db().prepare(`SELECT e.*,n.signature FROM edges e JOIN nodes n ON n.id=e.target
      WHERE e.source=? AND e.kind='calls'`).get(caller.id);
    expect(original).toBeTruthy();
    const source = fs.readFileSync(path.join(directory!, 'provider.cpp'), 'utf8');
    fs.writeFileSync(path.join(directory!, 'provider.cpp'), '\n' + source);
    const result = await cg!.sync({paths:['provider.cpp']});
    const after = db().prepare(`SELECT e.*,n.signature FROM edges e JOIN nodes n ON n.id=e.target
      WHERE e.source=? AND e.kind='calls'`).get(caller.id);
    expect(result.filesModified).toBe(1);
    expect(after.signature).toBe(original.signature);
    expect(after.target).not.toBe(original.target);
    expect(after.metadata).toBe(original.metadata);
  });
  it('an emptied provider parks and later restores the unchanged caller reference', async () => {
    await setup();
    const source = fs.readFileSync(path.join(directory!, 'provider.cpp'), 'utf8');
    fs.writeFileSync(path.join(directory!, 'provider.cpp'), '// now empty\n');
    expect((await cg!.sync({paths:['provider.cpp']})).filesModified).toBe(1);
    expect(db().prepare(`SELECT status FROM unresolved_refs WHERE reference_name='api'`).get()?.status).toBe('failed');
    fs.writeFileSync(path.join(directory!, 'provider.cpp'), source);
    await cg!.sync({paths:['provider.cpp']});
    expect(db().prepare(`SELECT COUNT(*) n FROM edges e JOIN nodes n ON n.id=e.target
      WHERE e.kind='calls' AND n.name='api'`).get().n).toBeGreaterThan(0);
    expect(db().prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('equally ranked candidates keep the same target after reinsertion', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-graph-tie-'));
    for (const [file,source] of Object.entries({
      'a.cpp':'int shared() { return 1; }\n',
      'b.cpp':'int shared() { return 2; }\n',
      'caller.cpp':'int caller() { return shared(); }\n',
    })) fs.writeFileSync(path.join(directory,file),source);
    cg = CodeGraph.initSync(directory); await cg.indexAll();
    const before=edges();
    const target=db().prepare(`SELECT t.file_path FROM edges e JOIN nodes s ON s.id=e.source
      JOIN nodes t ON t.id=e.target WHERE s.name='caller' AND e.kind='calls'`).get().file_path;
    // Move the current winner to the end of SQLite's insertion order, and
    // force the caller to resolve again. A no-op caller alone would miss it.
    for (const file of [target,'caller.cpp']) fs.appendFileSync(path.join(directory,file),'\n/* comment */\n');
    await cg.sync({paths:[target,'caller.cpp']});
    expect(edges()).toEqual(before);
  });
});
