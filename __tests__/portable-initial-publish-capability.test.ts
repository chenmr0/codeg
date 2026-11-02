import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { getCodeGraphDir } from '../src/directory';
import { DatabaseConnection } from '../src/db';
import { PortableCoordinator, type PortableCandidate, type PortableLease } from '../src/sync/portable/protocol';
const { DatabaseSync } = require('node:sqlite');

const roots: string[] = [], graphs: CodeGraph[] = [], leases: PortableLease[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const graph of graphs.splice(0)) { await graph.whenIdle(); graph.close(); await graph.whenIdle(); }
  for (const lease of leases.splice(0).reverse()) lease.release();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function root() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-initial-capability-')); roots.push(root);
  fs.writeFileSync(path.join(root, 'main.c'), 'int private_build(void) { return 1; }\n');
  return root;
}
function observeQuickChecks(): string[] {
  const files: string[] = [], prepare = DatabaseSync.prototype.prepare;
  vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function(this: any, sql: string) {
    if (/^\s*PRAGMA\s+quick_check\b/i.test(sql)) {
      files.push(prepare.call(this, 'PRAGMA database_list').all().find((row: any) => row.name === 'main').file);
    }
    return prepare.call(this, sql);
  });
  return files;
}
async function baseline() {
  const directory = root(), graph = CodeGraph.initSync(directory);
  graph.close(); await graph.whenIdle();
  const coordinator = new PortableCoordinator(getCodeGraphDir(directory));
  leases.push(coordinator.acquireWriter());
  return { directory, coordinator };
}
async function freshBaseline() {
  const directory = root(), coordinator = new PortableCoordinator(getCodeGraphDir(directory));
  const writer = coordinator.acquireWriter(); leases.push(writer);
  coordinator.recover();
  const staging = coordinator.reserveInitialActive();
  const db = DatabaseConnection.initialize(staging);
  try { db.close(); } finally { await db.whenIdle(); }
  coordinator.installInitialActive();
  return { directory, coordinator, writer };
}
async function build(directory: string, candidate: PortableCandidate) {
  const graph = await CodeGraph.createPortableCandidate(directory, candidate.path);
  try { expect((await graph.indexAll()).success).toBe(true); }
  finally { graph.close(); await graph.whenIdle(); }
}

it('real initial SDK publication omits the candidate full quick_check only', async () => {
  const directory = root(), checked = observeQuickChecks();
  const graph = await CodeGraph.init(directory, { index: true }); graphs.push(graph);
  expect(checked.filter(file => path.basename(file) === 'candidate.db')).toEqual([]);
  expect(graph.searchNodes('private_build').length).toBeGreaterThan(0);
  const verify = new DatabaseSync(path.join(getCodeGraphDir(directory), 'codegraph.db'), { readOnly: true });
  try { expect(verify.prepare('PRAGMA quick_check').get().quick_check).toBe('ok'); }
  finally { verify.close(); }
}, 30000);

it('ordinary coordinator publication still performs the candidate integrity scan', async () => {
  const { directory, coordinator } = await baseline();
  const candidate = coordinator.beginCandidate(); await build(directory, candidate);
  const checked = observeQuickChecks();
  await coordinator.publish(candidate);
  expect(checked).toContain(candidate.path);
}, 30000);

it('existing schema-only active storage cannot acquire a fresh-initialization capability', async () => {
  const { coordinator } = await baseline();
  const before = fs.readFileSync(coordinator.active);
  expect(() => coordinator.reserveInitialActive()).toThrow();
  expect(() => coordinator.beginInitialCandidate()).toThrow(/initial|fresh|capability/i);
  expect(fs.readFileSync(coordinator.active).equals(before)).toBe(true);
  const ordinary = coordinator.beginCandidate();
  await expect(coordinator.publishInitialCandidate(ordinary)).rejects.toThrow(/capability/);
}, 30000);

it('requires writer ownership to create the fresh active file', () => {
  const directory = root(), coordinator = new PortableCoordinator(getCodeGraphDir(directory));
  expect(() => coordinator.reserveInitialActive()).toThrow(/writer/i);
  expect(fs.existsSync(coordinator.active)).toBe(false);
});

it('revokes unused fresh-baseline eligibility when its writer lease is released', async () => {
  const { coordinator, writer } = await freshBaseline();
  writer.release(); leases.push(coordinator.acquireWriter());
  expect(() => coordinator.beginInitialCandidate()).toThrow(/initial|fresh|capability/i);
  expect(() => coordinator.reserveInitialActive()).toThrow();
});

it('revokes an issued initial candidate capability across writer leases', async () => {
  const { directory, coordinator, writer } = await freshBaseline();
  const candidate = coordinator.beginInitialCandidate(); await build(directory, candidate);
  writer.release(); leases.push(coordinator.acquireWriter());
  await expect(coordinator.publishInitialCandidate(candidate)).rejects.toThrow(/capability/);
}, 30000);

it('accepts only the original one-use initial candidate in its fresh writer lifecycle', async () => {
  const { directory, coordinator } = await freshBaseline();
  const candidate = coordinator.beginInitialCandidate(); await build(directory, candidate);
  await expect(coordinator.publishInitialCandidate({ ...candidate })).rejects.toThrow(/capability/);
  const foreign = new PortableCoordinator(getCodeGraphDir(directory));
  await expect(foreign.publishInitialCandidate(candidate)).rejects.toThrow(/capability/);
  // Rejected lookalikes must not consume the real instance's one-use identity.
  await coordinator.publishInitialCandidate(candidate);
  await expect(coordinator.publishInitialCandidate(candidate)).rejects.toThrow(/capability/);
}, 30000);


it('keeps initial schema construction private until the reserved staging file is installed', async () => {
  const directory = root(), coordinator = new PortableCoordinator(getCodeGraphDir(directory));
  leases.push(coordinator.acquireWriter()); coordinator.recover();
  const staging = coordinator.reserveInitialActive();
  expect(staging).not.toBe(coordinator.active);
  expect(fs.existsSync(staging)).toBe(false);
  expect(fs.existsSync(coordinator.active)).toBe(false);
  const db = DatabaseConnection.initialize(staging);
  expect(fs.existsSync(coordinator.active)).toBe(false);
  try { db.close(); } finally { await db.whenIdle(); }
  coordinator.installInitialActive();
  expect(fs.existsSync(staging)).toBe(false);
  expect(fs.existsSync(coordinator.active)).toBe(true);
  const candidate = coordinator.beginInitialCandidate();
  expect(candidate.baselineRevision).toBe(0);
});

it.each(['markMutation', 'recover', 'beginCandidate'] as const)(
  '%s permanently revokes unused initial eligibility within the same writer lease', async operation => {
    const { coordinator } = await freshBaseline();
    coordinator[operation]();
    expect(() => coordinator.beginInitialCandidate()).toThrow(/initial|fresh|capability/i);
    expect(() => coordinator.reserveInitialActive()).toThrow();
  },
);

it.each(['markMutation', 'recover', 'beginCandidate'] as const)(
  '%s permanently revokes an issued token within the same writer lease', async operation => {
    const { directory, coordinator } = await freshBaseline();
    const candidate = coordinator.beginInitialCandidate(); await build(directory, candidate);
    // A conflicting mutation/candidate request fails against the pending
    // journal, but must still revoke the initialization-only shortcut.
    if (operation === 'recover') coordinator.recover();
    else expect(() => coordinator[operation]()).toThrow();
    await expect(coordinator.publishInitialCandidate(candidate)).rejects.toThrow(/capability/);
    expect(() => coordinator.beginInitialCandidate()).toThrow(/initial|fresh|capability/i);
  },
  30000,
);
