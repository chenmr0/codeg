/** Official legacy fixture is built by the unmodified release executable, not
 * by editing provenance stamps in a current index. Set CODEGRAPH_LEGACY_DIST
 * to a separately built 1765271/e1c038a5 dist when running outside this workspace.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseConnection } from '../src/db';
import { inspectLegacySourceProvenance, isSourceOwned, installSourceOwnership, beginSourceWrite } from '../src/sync/source-ownership';

const legacyDist = process.env.CODEGRAPH_LEGACY_DIST ?? path.resolve(__dirname, '../../adaptive-perf-20261028/codeg-baseline/dist');
let originalRoot: string;
let originalDatabase: string;
const roots: string[] = [];
const connections: DatabaseConnection[] = [];
function fixture(readOnly = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-legacy-admission-')); roots.push(root);
  const filename = path.join(root, 'codegraph.db'); fs.copyFileSync(originalDatabase, filename);
  const connection = readOnly ? DatabaseConnection.openReadOnly(filename) : DatabaseConnection.open(filename);
  connections.push(connection); return { root, filename, connection, db: connection.getDb() };
}
afterEach(() => { connections.splice(0).forEach(c => c.close()); roots.splice(0).forEach(r => fs.rmSync(r, { recursive: true, force: true })); });
afterAll(() => { if (originalRoot) fs.rmSync(originalRoot, { recursive: true, force: true }); });

describe.skipIf(!fs.existsSync(path.join(legacyDist, 'index.js')))('supported official legacy source format', () => {
  beforeAll(() => {
    originalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-official-legacy-'));
    fs.writeFileSync(path.join(originalRoot, 'main.c'), 'int first(void) { return 1; }\nint second(void) { return first(); }\n');
    const child = spawnSync(process.execPath, ['--liftoff-only', '-e', `
      const {CodeGraph}=require(process.argv[1]);
      (async()=>{const g=await CodeGraph.init(process.argv[2],{index:true});
      if(g.getIndexCompleteness().status!=='complete') throw Error('Legacy build incomplete');
      g.close();})().catch(e=>{console.error(e);process.exitCode=1;});
    `, legacyDist, originalRoot], { encoding: 'utf8', timeout: 30_000 });
    expect(child.status, child.stdout + child.stderr).toBe(0);
    originalDatabase = path.join(originalRoot, '.codegraph-wx', 'codegraph.db');
    expect(fs.existsSync(originalDatabase)).toBe(true);
  });
  it('admits an actual unmodified official release index without installing ownership', () => {
    const { filename, db } = fixture(true);
    const before = createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
    expect(isSourceOwned(db)).toBe(false);
    expect(inspectLegacySourceProvenance(db)).toEqual({ eligible: true, reason: 'supported-official-legacy-format' });
    expect(isSourceOwned(db)).toBe(false);
    expect(createHash('sha256').update(fs.readFileSync(filename)).digest('hex')).toBe(before);
  });
  it.each([
    ['table', "CREATE TABLE user_business_data(value TEXT)"],
    ['metadata', "INSERT INTO project_metadata VALUES('user:keep','important',1)"],
    ['build', "UPDATE project_metadata SET value='unknown' WHERE key='indexed_with_version'"],
    ['node', "UPDATE nodes SET kind='custom' WHERE kind='function'"],
    ['node provenance', "UPDATE nodes SET file_path='../custom.c' WHERE name='first'"],
    ['edge', "UPDATE edges SET kind='custom' WHERE kind='calls'"],
    ['edge extension', "UPDATE edges SET metadata='{\"businessSecret\":\"keep\"}' WHERE kind='calls'"],
    ['edge import', "UPDATE edges SET provenance='scip' WHERE kind='calls'"],
    ['pending recovery', "INSERT INTO project_metadata VALUES('sync-retry:pending:main.c','{}',1)"],
    ['incomplete', "UPDATE project_metadata SET value='incomplete' WHERE key='index_completeness'"],
  ])('refuses unknown/custom %s without deleting it', (_kind, mutation) => {
    const { db } = fixture(); db.exec(mutation);
    const before = db.prepare('SELECT count(*) AS n FROM nodes').get();
    expect(inspectLegacySourceProvenance(db).eligible).toBe(false);
    expect(db.prepare('SELECT count(*) AS n FROM nodes').get()).toEqual(before);
  });
  it('never recognizes a broken modern guard chain as legacy', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-not-legacy-')); roots.push(root);
    const connection = DatabaseConnection.initialize(path.join(root, 'codegraph.db')); connections.push(connection);
    const db = connection.getDb(); expect(installSourceOwnership(db)).toBe(true);
    expect(beginSourceWrite(db)).not.toBeNull();
    expect(inspectLegacySourceProvenance(db).reason).toBe('legacy-unknown-or-extended-schema');
  });
});
