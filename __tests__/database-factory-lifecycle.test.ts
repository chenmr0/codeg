import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as adapter from '../src/db/sqlite-adapter';
import { DatabaseConnection, DatabaseOpenError, getDatabasePath } from '../src/db';
import { cleanupGenerationCandidate, collectRetiredGenerations, createGeneration, GenerationCandidate, GenerationWriterLock, publishGeneration, publishInitialGenerationSync } from '../src/sync/generation-store';

let project: string;
const retained: DatabaseConnection[] = [];
beforeEach(() => { project = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-db-factory-')); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const db of retained.splice(0)) if (db.isOpen()) db.close(); fs.rmSync(project, { recursive: true, force: true }); });
const factories = ['initialize', 'open', 'openReadOnly'] as const;
describe('database factories own every opened handle, including failure paths', () => {
  it.each(factories)('%s closes an unreturned handle after configuration failure', method => {
    const failure = new Error('injected configuration failure'); const file = path.join(project, 'db.sqlite'); fs.writeFileSync(file, 'fixture');
    const raw = { open: true, pragma: () => { throw failure; }, close: vi.fn(() => { raw.open = false; }) };
    vi.spyOn(adapter, 'createDatabase').mockReturnValue({ db: raw as any, backend: 'node-sqlite' });
    expect(() => DatabaseConnection[method](file)).toThrow(failure); expect(raw.close).toHaveBeenCalledOnce(); expect(raw.open).toBe(false);
  });
  it.each(factories)('%s exposes and retains a still-open failed connection when close fails', method => {
    const failure = new Error('injected configuration failure'); const file = path.join(project, 'db.sqlite'); fs.writeFileSync(file, 'fixture');
    const raw = { open: true, pragma: () => { throw failure; }, close: vi.fn(() => { throw new Error('close failed'); }) };
    vi.spyOn(adapter, 'createDatabase').mockReturnValue({ db: raw as any, backend: 'node-sqlite' });
    let caught: unknown; try { DatabaseConnection[method](file); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(DatabaseOpenError); expect((caught as DatabaseOpenError).cause).toBe(failure);
    expect((caught as DatabaseOpenError).connection.getDb()).toBe(raw); expect((caught as DatabaseOpenError).connection.isOpen()).toBe(true);
    raw.close.mockImplementation(() => { raw.open = false; }); (caught as DatabaseOpenError).connection.close();
  });
  it('closes a raw handle when schema execution fails after configuration succeeded', () => {
    const failure = new Error('schema failed'); const raw = { open: true, pragma: () => undefined, exec: () => { throw failure; }, close: vi.fn(() => { raw.open = false; }) };
    vi.spyOn(adapter, 'createDatabase').mockReturnValue({ db: raw as any, backend: 'node-sqlite' });
    expect(() => DatabaseConnection.initialize(path.join(project, 'schema.db'))).toThrow(failure); expect(raw.close).toHaveBeenCalledOnce();
  });

  it('keeps the internal generation lease while an unreturned connection remains open after cleanup failure', async () => {
    const root = path.join(project, '.codegraph-wx'); fs.mkdirSync(root); const lock = new GenerationWriterLock(root); lock.acquire();
    const c = createGeneration(root, lock); fs.writeFileSync(c.databasePath, 'candidate');
    const raw = { open: true, pragma: () => { throw new Error('configure failed'); }, close: vi.fn(() => { throw new Error('close failed'); }) };
    vi.spyOn(adapter, 'createDatabase').mockReturnValue({ db: raw as any, backend: 'node-sqlite' });
    let caught: unknown; try { DatabaseConnection.open(c.databasePath); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(DatabaseOpenError);
    cleanupGenerationCandidate(root, c); await collectRetiredGenerations(root); expect(fs.existsSync(c.databasePath)).toBe(true);
    raw.close.mockImplementation(() => { raw.open = false; }); (caught as DatabaseOpenError).connection.close();
    await collectRetiredGenerations(root); expect(fs.existsSync(c.directory)).toBe(false); lock.release();
  });
  it('releases an acquired generation lease when raw database construction itself throws', async () => {
    const root = path.join(project, '.codegraph-wx'); fs.mkdirSync(root); const lock = new GenerationWriterLock(root); lock.acquire();
    const c = createGeneration(root, lock); fs.writeFileSync(c.databasePath, 'candidate');
    vi.spyOn(adapter, 'createDatabase').mockImplementation(() => { throw new Error('raw open failed'); });
    expect(() => DatabaseConnection.open(c.databasePath)).toThrow(/raw open failed/);
    cleanupGenerationCandidate(root, c); await collectRetiredGenerations(root); expect(fs.existsSync(c.directory)).toBe(false); lock.release();
  });


  it('strongly retains a failed connection even when a public caller discards the thrown error', () => {
    const file = path.join(project, 'db.sqlite'); fs.writeFileSync(file, 'fixture');
    const held = (DatabaseConnection as any).managedOrFailedConnections as Set<DatabaseConnection>; const before = new Set(held);
    const raw = { open: true, pragma: () => { throw new Error('configure failed'); }, close: vi.fn(() => { throw new Error('close failed'); }) };
    vi.spyOn(adapter, 'createDatabase').mockReturnValue({ db: raw as any, backend: 'node-sqlite' });
    try { DatabaseConnection.open(file); } catch { /* Deliberately discard exception. */ }
    const connection = [...held].find(value => !before.has(value)); expect(connection).toBeDefined(); expect(connection!.isOpen()).toBe(true);
    raw.close.mockImplementation(() => { raw.open = false; }); connection!.close(); expect(held.has(connection!)).toBe(false);
  });


  it('pins the canonical managed target when a public reader opens a symlink alias', async () => {
    if (process.platform === 'win32') return;
    const root = path.join(project, '.codegraph-wx'); fs.mkdirSync(root); const lock = new GenerationWriterLock(root); lock.acquire();
    const c = createGeneration(root, lock); const writer = DatabaseConnection.initialize(c.databasePath); writer.close();
    const alias = path.join(project, 'alias.db'); fs.symlinkSync(c.databasePath, alias);
    const reader = DatabaseConnection.openReadOnly(alias); retained.push(reader);
    cleanupGenerationCandidate(root, c); await collectRetiredGenerations(root); expect(fs.existsSync(c.databasePath)).toBe(true);
    expect(reader.getPath()).toBe(c.databasePath); reader.close(); await collectRetiredGenerations(root);
    expect(fs.existsSync(c.directory)).toBe(false); lock.release();
  });
  it('strongly holds a managed wrapper even when the caller retains only its raw adapter', async () => {
    const root = path.join(project, '.codegraph-wx'); fs.mkdirSync(root); const lock = new GenerationWriterLock(root); lock.acquire();
    const c = createGeneration(root, lock); const writer = DatabaseConnection.initialize(c.databasePath); writer.close();
    const held = (DatabaseConnection as any).managedOrFailedConnections as Set<DatabaseConnection>;
    const raw = DatabaseConnection.openReadOnly(c.databasePath).getDb();
    const wrapper = [...held].find(connection => connection.getDb() === raw); expect(wrapper).toBeDefined();
    cleanupGenerationCandidate(root, c); await collectRetiredGenerations(root); expect(fs.existsSync(c.databasePath)).toBe(true);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM nodes').get()).toMatchObject({ count: 0 });
    wrapper!.close(); expect(held.has(wrapper!)).toBe(false); await collectRetiredGenerations(root); expect(fs.existsSync(c.directory)).toBe(false); lock.release();
  });


  it('fails closed instead of using WASM to copy or overwrite managed storage', () => {
    const root = path.join(project, '.codegraph-wx'); fs.mkdirSync(root); const lock = new GenerationWriterLock(root); lock.acquire();
    const c = createGeneration(root, lock); const writer = DatabaseConnection.initialize(c.databasePath); writer.close();
    publishInitialGenerationSync(root, c, { lock, validate: () => true }); cleanupGenerationCandidate(root, c);
    const before = fs.readFileSync(c.databasePath); vi.stubEnv('CODEGRAPH_FORCE_WASM', '1');
    expect(() => DatabaseConnection.open(c.databasePath)).toThrow(/node:sqlite/);
    expect(() => DatabaseConnection.initialize(c.databasePath)).toThrow(/node:sqlite/);
    expect(fs.readFileSync(c.databasePath).equals(before)).toBe(true); lock.release();
  });

  it.each(['open', 'openReadOnly'] as const)('protects direct public DatabaseConnection.%s readers until SQLite closes', async method => {
    const root = path.join(project, '.codegraph-wx'); fs.mkdirSync(root); const lock = new GenerationWriterLock(root); lock.acquire();
    const candidates: GenerationCandidate[] = [];
    const make = () => { const c = createGeneration(root, lock); candidates.push(c); const db = DatabaseConnection.initialize(c.databasePath); db.close(); return c; };
    try {
      const initial = make(); publishInitialGenerationSync(root, initial, { lock, validate: () => true }); cleanupGenerationCandidate(root, initial);
      // No CodeGraph facade and no explicit lease: this is the exported SDK API.
      const reader = DatabaseConnection[method](getDatabasePath(project)); retained.push(reader);
      const next = make(); await publishGeneration(root, next, { lock, expectedPreviousId: initial.id, success: true, complete: true, validate: () => true, sourceUnchanged: () => true }); cleanupGenerationCandidate(root, next);
      await collectRetiredGenerations(root); expect(fs.existsSync(initial.databasePath)).toBe(true);
      expect(reader.getDb().prepare('SELECT COUNT(*) AS count FROM nodes').get()).toMatchObject({ count: 0 });
      reader.close(); await collectRetiredGenerations(root); expect(fs.existsSync(initial.directory)).toBe(false);
      expect(() => DatabaseConnection.open(initial.databasePath)).toThrow(/not found/); expect(fs.existsSync(initial.databasePath)).toBe(false);
    } finally { for (const db of retained.splice(0)) if (db.isOpen()) db.close(); for (const c of candidates) cleanupGenerationCandidate(root, c); await collectRetiredGenerations(root); lock.release(); }
  });
});
