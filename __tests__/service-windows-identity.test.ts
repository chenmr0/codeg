/** Windows branch exercised on Linux; not a replacement for native Windows CI. */
import { afterEach, expect, it, vi } from 'vitest';
import { getDaemonSocketPath } from '../src/mcp/daemon-paths';
const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => { Object.defineProperty(process, 'platform', descriptor); vi.restoreAllMocks(); });
it('uses one Windows pipe for case variants of the same project', () => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  expect(getDaemonSocketPath('C:\\work\\MixedCase')).toBe(getDaemonSocketPath('c:\\WORK\\MIXEDCASE'));
});
it('does not merge case-distinct POSIX project paths', () => {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  expect(getDaemonSocketPath('/work/MixedCase')).not.toBe(getDaemonSocketPath('/work/MIXEDCASE'));
});
