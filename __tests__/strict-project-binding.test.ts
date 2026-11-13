import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import { bindStrictProject, isStrictProjectBindingCurrent } from '../src/mcp/strict-project-binding';
vi.mock('fs', () => ({ realpathSync: vi.fn(), statSync: vi.fn() }));
afterEach(() => vi.resetAllMocks());
it.each([0n, undefined])('fails closed when filesystem identity is unavailable (%s)', ino => {
  vi.mocked(fs.realpathSync).mockReturnValue('/project');
  vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true, dev: 1n, ino } as any);
  expect(bindStrictProject('/project')).toBeNull();
});
it('rejects replaced directories but accepts unchanged root identity', () => {
  vi.mocked(fs.realpathSync).mockReturnValue('/project');
  const stat = vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true, dev: 1n, ino: 2n } as any);
  const binding = bindStrictProject('/alias')!;
  expect(binding.root).toBe('/project');
  expect(isStrictProjectBindingCurrent(binding)).toBe(true);
  stat.mockReturnValue({ isDirectory: () => true, dev: 1n, ino: 3n } as any);
  expect(isStrictProjectBindingCurrent(binding)).toBe(false);
});
