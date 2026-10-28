import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  acquireCurrentGenerationLease, cleanupGenerationCandidate, collectRetiredGenerations, createGeneration,
  GenerationCandidate, GenerationWriterLock, publishGeneration, publishInitialGeneration,
  publishInitialGenerationSync, resolveGeneration,
} from '../src/sync/generation-store';

let root: string, lock: GenerationWriterLock, candidates: GenerationCandidate[];
function candidate() {
  const c = createGeneration(root, lock); candidates.push(c);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(c.databasePath);
  db.exec('CREATE TABLE initial_schema (value TEXT); INSERT INTO initial_schema VALUES (\'ready\')'); db.close();
  return c;
}
function validate(c: GenerationCandidate) {
  const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(c.databasePath, { readOnly: true });
  try { return db.prepare('PRAGMA quick_check').get().quick_check === 'ok' && db.prepare('SELECT value FROM initial_schema').get().value === 'ready'; }
  finally { db.close(); }
}
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-initial-store-')); lock = new GenerationWriterLock(root); lock.acquire(); candidates = []; });
afterEach(async () => { vi.restoreAllMocks(); for (const c of candidates) cleanupGenerationCandidate(root, c); await collectRetiredGenerations(root); lock.release(); fs.rmSync(root, { recursive: true, force: true }); });

describe('new native initial storage generation', () => {
  it('publishes schema-ready storage without claiming source completeness or creating a flat DB', () => {
    const c = candidate(); publishInitialGenerationSync(root, c, { lock, validate: () => validate(c) });
    expect(resolveGeneration(root).id).toBe(c.id);
    const current = JSON.parse(fs.readFileSync(path.join(root, 'CURRENT'), 'utf8'));
    expect(current).toMatchObject({ complete: false, storageReady: true, purpose: 'initial-storage' });
    expect(fs.existsSync(path.join(root, 'codegraph.db'))).toBe(false);
  });
  it('allows the first rebuild to replace and reclaim the initial generation after its actual connection closes', async () => {
    const initial = candidate(); await publishInitialGeneration(root, initial, { lock, validate: () => validate(initial) });
    const lease = acquireCurrentGenerationLease(root); const { DatabaseSync } = require('node:sqlite'); const reader = new DatabaseSync(lease.databasePath, { readOnly: true });
    cleanupGenerationCandidate(root, initial);
    const rebuilt = candidate(); await publishGeneration(root, rebuilt, { lock, expectedPreviousId: initial.id, success: true, complete: true, validate: () => validate(rebuilt), sourceUnchanged: () => true });
    cleanupGenerationCandidate(root, rebuilt); await collectRetiredGenerations(root);
    expect(fs.existsSync(initial.databasePath)).toBe(true); expect(reader.prepare('SELECT value FROM initial_schema').get().value).toBe('ready');
    reader.close(); lease.release(); await collectRetiredGenerations(root);
    expect(fs.existsSync(initial.directory)).toBe(false); expect(resolveGeneration(root).id).toBe(rebuilt.id);
  });
  it.each(['codegraph.db', 'codegraph.db-wal', 'codegraph.db-shm', 'codegraph.db-journal', 'CURRENT'])('refuses to adopt or replace existing %s', name => {
    const c = candidate(); fs.writeFileSync(path.join(root, name), 'untouched');
    expect(() => publishInitialGenerationSync(root, c, { lock, validate: () => true })).toThrow(/empty store/);
    expect(fs.readFileSync(path.join(root, name), 'utf8')).toBe('untouched');
  });
  it('cleans a failed unpublished initializer without exposing CURRENT', async () => {
    const c = candidate(); await expect(publishInitialGeneration(root, c, { lock, validate: () => false })).rejects.toThrow(/validation/);
    cleanupGenerationCandidate(root, c); await collectRetiredGenerations(root);
    expect(fs.existsSync(c.directory)).toBe(false); expect(fs.existsSync(path.join(root, 'CURRENT'))).toBe(false); expect(fs.existsSync(path.join(root, 'codegraph.db'))).toBe(false);
  });
  it('rechecks store emptiness at the final boundary after async validation', async () => {
    const c = candidate(); await expect(publishInitialGeneration(root, c, { lock, validate: async () => { fs.writeFileSync(path.join(root, 'codegraph.db'), 'foreign'); return true; } })).rejects.toThrow(/empty store/);
    expect(fs.readFileSync(path.join(root, 'codegraph.db'), 'utf8')).toBe('foreign'); expect(fs.existsSync(path.join(root, 'CURRENT'))).toBe(false);
  });
  it('rejects READY/CURRENT readiness-kind mismatches even when generation and token match', () => {
    const c = candidate(); publishInitialGenerationSync(root, c, { lock, validate: () => validate(c) });
    const readyPath = path.join(c.directory, 'READY.json'), ready = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
    ready.complete = true; delete ready.purpose; delete ready.storageReady; fs.writeFileSync(readyPath, JSON.stringify(ready));
    expect(() => resolveGeneration(root)).toThrow(/validated generation/);
  });

  it('cancels at the final publication gate when abort arrives during the asynchronous DB flush', async () => {
    const c = candidate(), controller = new AbortController(); const open = fs.promises.open;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args); const sync = handle.sync.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementation(async () => { await sync(); controller.abort(); }); return handle;
    });
    await expect(publishInitialGeneration(root, c, { lock, signal: controller.signal, validate: () => validate(c) })).rejects.toThrow(/cancelled/);
    expect(fs.existsSync(path.join(root, 'CURRENT'))).toBe(false);
    cleanupGenerationCandidate(root, c); await collectRetiredGenerations(root); expect(fs.existsSync(c.directory)).toBe(false);
  });

  it('rejects nonempty WAL and missing explicit storageReady evidence', () => {
    const c = candidate(); fs.writeFileSync(c.databasePath + '-wal', 'pending');
    expect(() => publishInitialGenerationSync(root, c, { lock, validate: () => true })).toThrow(/WAL/);
    fs.unlinkSync(c.databasePath + '-wal'); publishInitialGenerationSync(root, c, { lock, validate: () => validate(c) });
    const file = path.join(root, 'CURRENT'), manifest = JSON.parse(fs.readFileSync(file, 'utf8')); delete manifest.storageReady; fs.writeFileSync(file, JSON.stringify(manifest));
    expect(() => resolveGeneration(root)).toThrow(/manifest/);
  });
});
