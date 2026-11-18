import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PortableCoordinator, withPortableGateReader } from '../src/sync/portable/protocol';

const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
let root: string;
let coordinator: PortableCoordinator;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cg-request-gate-'));
  coordinator = new PortableCoordinator(root);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function observeStateReads() {
  const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare');
  return () => prepare.mock.contexts.filter((_, index) =>
    prepare.mock.calls[index]?.[0] === 'SELECT mode,revision,journal FROM state WHERE id=1');
}

it('reuses one handle per request and observes revisions committed by a concurrent writer', async () => {
  const writer = new PortableCoordinator(root);
  const reads = observeStateReads();
  let releaseFirst!: () => void;
  const barrier = new Promise<void>(resolve => { releaseFirst = resolve; });
  const first = withPortableGateReader(async () => {
    expect(coordinator.snapshot().revision).toBe(0);
    await barrier;
    expect(coordinator.snapshot().revision).toBe(1);
  });
  try {
    await withPortableGateReader(async () => {
      expect(coordinator.snapshot().revision).toBe(0);
      const lease = writer.acquireWriter();
      try { writer.markMutation(); } finally { lease.release(); }
      expect(coordinator.snapshot().revision).toBe(1);
    });
    const [outer, inner, writerRead, afterWrite] = reads();
    expect(inner === outer).toBe(false);
    expect(writerRead === inner && afterWrite === inner).toBe(true);
    expect(() => inner!.prepare('SELECT 1')).toThrow();
    expect(outer!.prepare('SELECT 1').get()).toBeTruthy();
  } finally { releaseFirst(); await first; }
  expect(reads().at(-1) === reads()[0]).toBe(true);
  expect(() => reads()[0]!.prepare('SELECT 1')).toThrow();
});

it('closes on errors and lets detached work read after the originating request ends', async () => {
  const reads = observeStateReads();
  let resume!: () => void;
  const barrier = new Promise<void>(resolve => { resume = resolve; });
  let detached!: Promise<unknown>;
  await expect(withPortableGateReader(async () => {
    coordinator.snapshot();
    detached = barrier.then(() => coordinator.snapshot());
    throw new Error('cancelled');
  })).rejects.toThrow('cancelled');
  expect(() => reads()[0]!.prepare('SELECT 1')).toThrow();
  resume();
  await expect(detached).resolves.toEqual({ mode: 'idle', revision: 0 });
  expect(reads()[1] === reads()[0]).toBe(false);
  expect(() => reads()[1]!.prepare('SELECT 1')).toThrow();
});

it('keeps different projects isolated within one request and ordinary reads short-lived', async () => {
  const other = new PortableCoordinator(join(root, 'other'));
  const lease = other.acquireWriter();
  try { other.markMutation(); } finally { lease.release(); }
  const reads = observeStateReads();
  await withPortableGateReader(async () => {
    expect(coordinator.snapshot().revision).toBe(0);
    expect(other.snapshot().revision).toBe(1);
    expect(coordinator.snapshot().revision).toBe(0);
    const [first, second, third] = reads();
    expect(third === first).toBe(true);
    expect(second === first).toBe(false);
    expect(() => second!.prepare('SELECT 1')).toThrow();
  });
  coordinator.snapshot();
  expect(reads()[3] === reads()[0]).toBe(false);
  expect(() => reads()[3]!.prepare('SELECT 1')).toThrow();
});
