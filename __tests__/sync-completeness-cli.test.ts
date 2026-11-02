import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
const { DatabaseSync } = require('node:sqlite');
import { getCodeGraphDir } from '../src/directory';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const directories: string[] = [];
const createDirectory = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-completeness-cli-'));
  directories.push(dir); return dir;
};
const run = (directory: string, args: string[], smallHeap = false) => {
  const result = spawnSync(process.execPath, [
    '--liftoff-only', ...(smallHeap ? ['--max-old-space-size=128'] : []), BIN, ...args,
  ], {
    cwd: directory, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, CI: '1', CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_NO_SYNTHESIS: '0',
      CODEGRAPH_PARSE_WORKERS: '1' },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return `${result.stdout}\n${result.stderr}`;
};
const status = (dir: string) => {
  const output = run(dir, ['status', '--json']);
  const line = output.split('\n').find(value => value.startsWith('{'))!;
  return JSON.parse(line).index;
};
// Portable facades deliberately do not expose a raw connection. Test-only SQL
// opens the fixed database only after all graph owners have been closed.
const withDatabase = <T>(directory: string, action: (db: DatabaseSync) => T): T => {
  const db = new DatabaseSync(path.join(getCodeGraphDir(directory), 'codegraph.db'));
  try { return action(db); } finally { db.close(); }
};
const edges = (directory: string) => withDatabase(directory, db => db.prepare(`
  SELECT source,target,kind,line,col,metadata,provenance FROM edges
  ORDER BY source,target,kind,line,col,metadata,provenance`).all());

afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('built CLI sync completeness with actual parse workers', () => {
  it('persists real low-heap synthesis skip, then converges to a fresh graph without another source edit', async () => {
    const directory = createDirectory();
    const files: Record<string, string> = {
      'api.h': 'int target(int value);\n',
      'api.c': '#include "api.h"\nint target(int value) { return value + 1; }\n',
      'caller.c': '#include "api.h"\nint caller(void) { return target(3); }\n',
    };
    for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(directory, file), content);
    run(directory, ['init']);
    expect(status(directory).completeness).toBe('complete');

    const before = await CodeGraph.open(directory);
    let callerId: string;
    try { callerId = before.getNodesByName('caller')[0]!.id; }
    finally { before.close(); await before.whenIdle(); }
    withDatabase(directory, db => db.prepare(`INSERT INTO unresolved_refs
      (from_node_id,reference_name,reference_kind,line,col,file_path,language,status,name_tail)
      VALUES (?, 'missing', 'calls', 99, 0, 'caller.c', 'c', 'pending', 'missing')`).run(callerId));
    files['api.c'] += '\n/* current source revision */\n';
    fs.writeFileSync(path.join(directory, 'api.c'), files['api.c']);

    const skipped = run(directory, ['sync', '--verbose'], true);
    expect(skipped).toContain('parse worker pool=1');
    expect(skipped).toContain('reason=heap-headroom');
    expect(skipped).toContain('Sync usable with incomplete graph coverage');
    expect(status(directory)).toMatchObject({ completeness: 'incomplete', diagnostics: [
      expect.objectContaining({ code: 'synthesis_skipped_memory' }),
    ] });
    run(directory, ['sync'], true);
    expect(status(directory).completeness).toBe('incomplete');

    const recovered = run(directory, ['sync', '--verbose']);
    expect(recovered).not.toContain('parse worker pool=');
    expect(status(directory)).toMatchObject({ completeness: 'complete', diagnostics: [] });
    const freshDirectory = createDirectory();
    for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(freshDirectory, file), content);
    run(freshDirectory, ['init']);
    expect(edges(directory)).toEqual(edges(freshDirectory));
    withDatabase(directory, db => {
      expect(db.prepare("SELECT value FROM project_metadata WHERE key='index_synthesis_pending'").get()).toBeUndefined();
      expect(db.prepare("SELECT key FROM project_metadata WHERE key LIKE 'sync-retry:pending:%'").all()).toHaveLength(0);
    });
  }, 60000);
});
