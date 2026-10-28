import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { removeOfflineLock } from '../src/cli/offline-unlock';

const roots: string[] = [];
const fixture = (text = '12345\nowner-token\n'): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-unlock-')); roots.push(root);
  const lock = path.join(root, 'codegraph.lock'); fs.writeFileSync(lock, text); return lock;
};
const missing = (): never => { throw Object.assign(new Error('absent'), { code: 'ESRCH' }); };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
describe('explicit offline unlock', () => {
  it('requires offline confirmation even when PID is absent', () => {
    const lock = fixture(); expect(() => removeOfflineLock(lock, false, missing)).toThrow('--offline'); expect(fs.existsSync(lock)).toBe(true);
  });
  it('refuses a live owner', () => {
    const lock = fixture(); expect(() => removeOfflineLock(lock, true, () => {})).toThrow('still running'); expect(fs.existsSync(lock)).toBe(true);
  });
  it('refuses uncertain owner state', () => {
    const lock = fixture(); expect(() => removeOfflineLock(lock, true, () => { throw Object.assign(new Error(), { code: 'EPERM' }); })).toThrow('Cannot verify'); expect(fs.existsSync(lock)).toBe(true);
  });
  it('removes a dead owner only with explicit confirmation', () => {
    const lock = fixture(); expect(removeOfflineLock(lock, true, missing)).toBe(true); expect(fs.existsSync(lock)).toBe(false);
  });
  it('never removes a changed lock', () => {
    const lock = fixture(); expect(() => removeOfflineLock(lock, true, () => { fs.writeFileSync(lock, '5678\nnew\n'); missing(); })).toThrow('Lock changed'); expect(fs.readFileSync(lock, 'utf8')).toContain('new');
  });
  it('rejects malformed owners', () => {
    const lock = fixture(''); expect(() => removeOfflineLock(lock, true, missing)).toThrow('malformed'); expect(fs.existsSync(lock)).toBe(true);
  });
  it('is a no-op for an absent lock', () => {
    const lock = fixture(); fs.unlinkSync(lock); expect(removeOfflineLock(lock, false)).toBe(false);
  });
  it('rejects symlinks without touching the target', () => {
    const lock = fixture(); const link = lock + '-link'; fs.symlinkSync(lock, link); expect(() => removeOfflineLock(link, true, missing)).toThrow('unexpected'); expect(fs.existsSync(lock)).toBe(true);
  });
});
