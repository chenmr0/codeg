import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
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
    const missingId = vi.spyOn(require('fs'), 'statSync').mockReturnValue({ ino: 0n, dev: 0n } as any);
    try { expect(bindStrictProject(root)).toBeNull(); } finally { missingId.mockRestore(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
