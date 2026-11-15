import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import * as mockedFs from 'fs';
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});
import os from 'node:os';
import path from 'node:path';
import { bindStrictProject, isStrictProjectBindingCurrent } from '../src/mcp/strict-project-binding';

it('pins the original root and data directory across sessions and index replacements', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bound-index-'));
  const data = path.join(root, '.codegraph-wx');
  try {
    fs.mkdirSync(data);
    const binding = bindStrictProject(root)!;
    expect(isStrictProjectBindingCurrent(binding)).toBe(true);
    fs.renameSync(data, data + '-old');
    fs.mkdirSync(data);
    expect(isStrictProjectBindingCurrent(binding)).toBe(false);
    const missingId = vi.spyOn(mockedFs, 'statSync').mockReturnValue({ ino: 0n, dev: 0n } as any);
    try { expect(bindStrictProject(root)).toBeNull(); } finally { missingId.mockRestore(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('keeps the directory identity recorded by each opened facade', async () => {
  const { CodeGraph } = await import('../src');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-opened-identity-'));
  try {
    const graph = CodeGraph.initSync(root);
    const original = graph.getOpenedDirectories();
    const data = graph.getDataDirectory();
    graph.close();
    await graph.whenIdle();
    fs.renameSync(data, data + '-previous');
    const replacement = CodeGraph.initSync(root);
    try {
      expect(replacement.getOpenedDirectories().rootId).toBe(original.rootId);
      expect(replacement.getOpenedDirectories().dataId).not.toBe(original.dataId);
      expect(graph.getOpenedDirectories()).toEqual(original);
    } finally { replacement.close(); await replacement.whenIdle(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
