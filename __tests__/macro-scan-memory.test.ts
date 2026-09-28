import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

describe('macro context source retention', () => {
  it.each(['ts', 'fallback'])('releases processed source text on the %s path', mode => {
    const child = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=256',
      path.resolve('__tests__/fixtures/macro-scan-memory.cjs'), mode], {
      encoding: 'utf8', windowsHide: true, timeout: 30_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout);
    expect(result.names).toBe(128);
    expect(result.bodyless).toBe(64);
    expect(result.definitions).toBe(128);
    expect(result.metrics).toMatchObject({ mode: mode === 'ts' ? 'ts' : 'fallback',
      reason: mode === 'ts' ? 'disabled' : 'binary-missing', readErrors: 0, readFiles: 64 });
    // Allow generous runtime/GC overhead but fail if 64 MiB of source is pinned.
    expect(result.retainedBytes).toBeLessThan(16 * 1024 * 1024);
  }, 35_000);
});
