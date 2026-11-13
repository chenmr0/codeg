import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { projectPathIdentity, sameProjectPath } from '../src/mcp/project-identity';
import { validatePathWithinRoot } from '../src/utils';
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-identity-')); });
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.unstubAllEnvs(); vi.restoreAllMocks(); fs.rmSync(dir,{recursive:true,force:true}); });
it('does not conflate distinct K and Kelvin directories under Windows identity policy', () => {
  const k = path.join(dir,'K'), kelvin = path.join(dir,'K'); fs.mkdirSync(k); fs.mkdirSync(kelvin);
  Object.defineProperty(process,'platform',{value:'win32',configurable:true});
  expect(projectPathIdentity(k)).not.toBe(projectPathIdentity(kelvin));
  expect(sameProjectPath(k,kelvin)).toBe(false);
});
it('recognizes a filesystem alias without Unicode case folding', () => {
  const target = path.join(dir,'MixedCase'), alias = path.join(dir,'ALIAS');fs.mkdirSync(target);fs.symlinkSync(target,alias,'junction');
  Object.defineProperty(process,'platform',{value:'win32',configurable:true});
  expect(projectPathIdentity(target)).toBe(projectPathIdentity(alias));
  expect(sameProjectPath(target,alias)).toBe(true);
});
it('rejects an authorized K tree escaping through a nested link to Kelvin', () => {
  const project=path.join(dir,'project'),k=path.join(dir,'K'),kelvin=path.join(dir,'K');
  [project,k,kelvin].forEach(p=>fs.mkdirSync(p));fs.writeFileSync(path.join(kelvin,'private.c'),'int private_fn() { return 1; }');
  fs.symlinkSync(k,path.join(project,'linked'),'junction');fs.symlinkSync(kelvin,path.join(k,'escape'),'junction');
  vi.stubEnv('CODEGRAPH_ALLOWED_SOURCE_ROOTS',k);
  Object.defineProperty(process,'platform',{value:'win32',configurable:true});
  expect(validatePathWithinRoot(project,'linked/escape/private.c')).toBeNull();
});
it('fails closed for missing project identities rather than folding their spelling', () => {
  Object.defineProperty(process,'platform',{value:'win32',configurable:true});
  expect(sameProjectPath(path.join(dir,'Missing'),path.join(dir,'MISSING'))).toBe(false);
  expect(projectPathIdentity(path.join(dir,'K'))).not.toBe(projectPathIdentity(path.join(dir,'K')));
});
it.skipIf(process.platform !== 'win32')('native Windows: ASCII casing aliases share identity while K and Kelvin remain distinct', () => {
  const a=path.join(dir,'K'),b=path.join(dir,'K');fs.mkdirSync(a);fs.mkdirSync(b);
  expect(sameProjectPath(a,a.toUpperCase())).toBe(true);
  expect(sameProjectPath(a,b)).toBe(false);
  expect(projectPathIdentity(a)).not.toBe(projectPathIdentity(b));
});

it('rejects equality when the filesystem provides no usable file ID', () => {
  Object.defineProperty(process,'platform',{value:'win32',configurable:true});
  vi.spyOn(fs,'statSync').mockReturnValue({dev: 1n, ino: 0n} as any);
  expect(sameProjectPath(dir,dir)).toBe(false);
});
it('rejects equality on inaccessible filesystem identities', () => {
  Object.defineProperty(process,'platform',{value:'win32',configurable:true});
  vi.spyOn(fs,'statSync').mockImplementation(() => { throw Object.assign(new Error('denied'), {code:'EACCES'}); });
  expect(sameProjectPath(dir,dir)).toBe(false);
});
