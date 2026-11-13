/** Filesystem identity tests; Windows native behavior has a separate case below. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { getDaemonSocketPath } from '../src/mcp/daemon-paths';
const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(),'cg-pipe-')); });
afterEach(() => { Object.defineProperty(process, 'platform', descriptor); fs.rmSync(dir,{recursive:true,force:true}); });
it('uses one Windows pipe for aliases of the same existing data directory', () => {
  const root=path.join(dir,'MixedCase'),alias=path.join(dir,'ALIAS');
  fs.mkdirSync(path.join(root,'.codegraph-wx'),{recursive:true});fs.symlinkSync(root,alias,'junction');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  expect(getDaemonSocketPath(root)).toBe(getDaemonSocketPath(alias));
});
it('does not merge distinct Unicode Windows directory identities', () => {
  const a=path.join(dir,'K'),b=path.join(dir,'K');
  [a,b].forEach(p=>fs.mkdirSync(path.join(p,'.codegraph-wx'),{recursive:true}));
  Object.defineProperty(process,'platform',{value:'win32',configurable:true});
  expect(getDaemonSocketPath(a)).not.toBe(getDaemonSocketPath(b));
});
it.skipIf(process.platform !== 'win32')('uses one native Windows pipe for ASCII case variants', () => {
  const root=path.join(dir,'MixedCase');fs.mkdirSync(path.join(root,'.codegraph-wx'),{recursive:true});
  expect(getDaemonSocketPath(root)).toBe(getDaemonSocketPath(root.toUpperCase()));
});
it('does not merge case-distinct POSIX project paths', () => {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  expect(getDaemonSocketPath('/work/MixedCase')).not.toBe(getDaemonSocketPath('/work/MIXEDCASE'));
});
