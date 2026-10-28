import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { installSourceOwnership, isSourceOwned, beginSourceWrite, finishSourceWrite } from '../src/sync/source-ownership';

const databases: DatabaseConnection[] = [];
const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-ownership-'));
  roots.push(root);
  const connection = DatabaseConnection.initialize(path.join(root, 'codegraph.db'));
  databases.push(connection);
  return { connection, db: connection.getDb() };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function addFile(db: ReturnType<DatabaseConnection['getDb']>, name = 'a.cpp') {
  db.prepare(`INSERT INTO files(path, content_hash, language, size, modified_at, indexed_at, node_count)
    VALUES (?, 'hash', 'cpp', 20, 1, 1, 0)`).run(name);
}

describe('source-only ownership', () => {
  it('only installs on an empty exact stock schema and never re-adopts', () => {
    const { db } = fixture();
    expect(installSourceOwnership(db)).toBe(true);
    expect(isSourceOwned(db)).toBe(true);
    expect(installSourceOwnership(db)).toBe(false);
    db.prepare("INSERT INTO project_metadata VALUES ('custom', 'keep me', 1)").run();
    expect(isSourceOwned(db)).toBe(false);
    expect(installSourceOwnership(db)).toBe(false);
  });
  it.each(['graph', 'metadata', 'table', 'trigger'])('refuses a fresh-looking custom %s database', kind => {
    const { db } = fixture();
    if (kind === 'graph') addFile(db);
    if (kind === 'metadata') db.exec("INSERT INTO project_metadata VALUES ('custom', 'x', 1)");
    if (kind === 'table') db.exec('CREATE TABLE custom_data(value TEXT)');
    if (kind === 'trigger') db.exec('CREATE TRIGGER custom_trigger AFTER INSERT ON files BEGIN SELECT 1; END');
    expect(installSourceOwnership(db)).toBe(false);
    expect(isSourceOwned(db)).toBe(false);
  });
  it('invalidates direct writes and cannot bless a legacy operation', () => {
    const { db } = fixture();
    expect(beginSourceWrite(db)).toBeNull();
    expect(finishSourceWrite(db, null, true)).toBe(false);
    expect(installSourceOwnership(db)).toBe(true);
    addFile(db);
    expect(isSourceOwned(db)).toBe(false);
    expect(beginSourceWrite(db)).toBeNull();
  });
  it('restores only a complete source operation with the same schema', () => {
    const { db } = fixture();
    installSourceOwnership(db);
    const token = beginSourceWrite(db);
    expect(token).not.toBeNull();
    expect(isSourceOwned(db)).toBe(false);
    addFile(db);
    expect(finishSourceWrite(db, token, true)).toBe(true);
    expect(isSourceOwned(db)).toBe(true);
    expect(finishSourceWrite(db, token, true)).toBe(false);
  });
  it('does not restore an incomplete operation', () => {
    const { db } = fixture();
    installSourceOwnership(db);
    const token = beginSourceWrite(db);
    addFile(db);
    expect(finishSourceWrite(db, token, false)).toBe(false);
    expect(isSourceOwned(db)).toBe(false);
    expect(finishSourceWrite(db, token, true)).toBe(false);
  });
  it('binds write proof to its database connection', () => {
    const one = fixture(); const two = fixture();
    installSourceOwnership(one.db); installSourceOwnership(two.db);
    const token = beginSourceWrite(one.db);
    expect(finishSourceWrite(two.db, token, true)).toBe(false);
    expect(finishSourceWrite(one.db, token, true)).toBe(false);
    expect(isSourceOwned(one.db)).toBe(false);
  });
  it('rejects schema additions and removed ownership guards', () => {
    const { db } = fixture();
    installSourceOwnership(db);
    const token = beginSourceWrite(db);
    db.exec('CREATE TABLE custom_data(value TEXT)');
    expect(finishSourceWrite(db, token, true)).toBe(false);
    expect(isSourceOwned(db)).toBe(false);
    const other = fixture(); installSourceOwnership(other.db);
    other.db.exec('DROP TRIGGER adaptive_owner_files_ai');
    expect(isSourceOwned(other.db)).toBe(false);
  });
  it('permits temporary bulk-index schema changes only if fully restored', () => {
    const { db, connection } = fixture();
    installSourceOwnership(db);
    const token = beginSourceWrite(db);
    connection.beginBulkNodeLoad(); connection.endBulkNodeLoad();
    expect(finishSourceWrite(db, token, true)).toBe(true);
  });
  it('permits ANALYZE-generated SQLite statistics', () => {
    const { db } = fixture();
    installSourceOwnership(db);
    db.exec('ANALYZE');
    expect(isSourceOwned(db)).toBe(true);
  });
  it.each(['INSERT', 'UPDATE', 'DELETE'])('invalidates external metadata %s', operation => {
    const { db } = fixture();
    installSourceOwnership(db);
    const token = beginSourceWrite(db);
    db.exec("INSERT INTO project_metadata VALUES ('built-in', 'original', 1)");
    finishSourceWrite(db, token, true);
    if (operation === 'INSERT') db.exec("INSERT INTO project_metadata VALUES ('external', 'x', 1)");
    if (operation === 'UPDATE') db.exec("UPDATE project_metadata SET value = 'x' WHERE key = 'built-in'");
    if (operation === 'DELETE') db.exec("DELETE FROM project_metadata WHERE key = 'built-in'");
    expect(isSourceOwned(db)).toBe(false);
  });
  it('invalidates a second native connection write durably', () => {
    const { db, connection } = fixture();
    installSourceOwnership(db);
    const second = DatabaseConnection.open(connection.getPath());
    try { addFile(second.getDb()); } finally { second.close(); }
    expect(isSourceOwned(db)).toBe(false);
  });
  it.each(['nodes', 'edges', 'files', 'unresolved_refs', 'schema_versions'].flatMap(table =>
    ['INSERT', 'UPDATE', 'DELETE'].map(operation => [table, operation])))('guards direct %s %s', (table, operation) => {
    const { db } = fixture(); installSourceOwnership(db);
    const token = beginSourceWrite(db);
    const node = (id: string) => db.prepare(`INSERT INTO nodes(id, kind, name, qualified_name, file_path, language,
      start_line, end_line, start_column, end_column, updated_at)
      VALUES (?, 'function', ?, ?, 'a.cpp', 'cpp', 1, 1, 0, 1, 1)`).run(id, id, id);
    node('n1'); node('n2');
    addFile(db);
    db.exec("INSERT INTO edges(source,target,kind) VALUES ('n1','n2','calls')");
    db.exec("INSERT INTO unresolved_refs(from_node_id,reference_name,reference_kind,line,col) VALUES ('n1','f','call',1,0)");
    expect(finishSourceWrite(db, token, true)).toBe(true);
    if (operation === 'INSERT') {
      if (table === 'nodes') node('n3');
      if (table === 'edges') db.exec("INSERT INTO edges(source,target,kind) VALUES ('n2','n1','calls')");
      if (table === 'files') addFile(db, 'b.cpp');
      if (table === 'unresolved_refs') db.exec("INSERT INTO unresolved_refs(from_node_id,reference_name,reference_kind,line,col) VALUES ('n2','g','call',2,0)");
      if (table === 'schema_versions') db.exec("INSERT INTO schema_versions(version,applied_at,description) VALUES (999,1,'custom')");
    } else if (operation === 'DELETE') {
      db.exec('DELETE FROM ' + table);
    } else {
      const assignments: Record<string, string> = { nodes: "name='changed'", edges: "kind='references'", files: "content_hash='changed'", unresolved_refs: "reference_name='changed'", schema_versions: "description='changed'" };
      db.exec('UPDATE ' + table + ' SET ' + assignments[table!]);
    }
    expect(isSourceOwned(db)).toBe(false);
  });

});
