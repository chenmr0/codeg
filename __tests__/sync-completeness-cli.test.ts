import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';

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
const edges = (cg: CodeGraph) => (cg as any).db.getDb().prepare(`
  SELECT source,target,kind,line,col,metadata,provenance FROM edges
  ORDER BY source,target,kind,line,col,metadata,provenance`).all();

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
    try {
      const caller = before.getNodesByName('caller')[0]!;
      (before as any).db.getDb().prepare(`INSERT INTO unresolved_refs
        (from_node_id,reference_name,reference_kind,line,col,file_path,language,status,name_tail)
        VALUES (?, 'missing', 'calls', 99, 0, 'caller.c', 'c', 'pending', 'missing')`).run(caller.id);
    } finally { before.close(); }
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
    const current = await CodeGraph.open(directory);
    const fresh = await CodeGraph.open(freshDirectory);
    try {
      expect(edges(current)).toEqual(edges(fresh));
      const queries = (current as any).queries;
      expect(queries.getMetadata('index_synthesis_pending')).toBeNull();
      expect(queries.getMetadataByPrefix('sync-retry:pending:')).toHaveLength(0);
    } finally { current.close(); fresh.close(); }
  }, 60000);
});
