import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { resolveDaemonRoot } from '../src/mcp/index';
import { parseClientHelloLine } from '../src/mcp/daemon';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-service-boundary-')); roots.push(outer);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: outer, stdio: 'pipe' });
  git('init', '-q'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture');
  const inner = path.join(outer, 'inner'); git('worktree', 'add', '-qb', 'inner', inner);
  fs.mkdirSync(path.join(outer, '.codegraph-wx')); fs.writeFileSync(path.join(outer, '.codegraph-wx/codegraph.db'), '');
  fs.mkdirSync(path.join(outer, 'src')); fs.mkdirSync(path.join(inner, 'src'));
  return { outer: fs.realpathSync(outer), inner: fs.realpathSync(inner) };
}
// The bounded option is deliberately restricted to explicit service operations;
// automatic/legacy daemon discovery keeps its old contract.
describe('explicit service project boundaries', () => {
  it('does not climb above an uninitialized nested Git worktree', () => {
    const { inner } = fixture();
    expect(resolveDaemonRoot(inner, { respectGitBoundary: true })).toBeNull();
    expect(resolveDaemonRoot(path.join(inner, 'src'), { respectGitBoundary: true })).toBeNull();
  });
  it('still resolves ordinary subdirectories and initialized inner roots', () => {
    const { outer, inner } = fixture();
    expect(resolveDaemonRoot(path.join(outer, 'src'), { respectGitBoundary: true })).toBe(outer);
    fs.mkdirSync(path.join(inner, '.codegraph-wx')); fs.writeFileSync(path.join(inner, '.codegraph-wx/codegraph.db'), '');
    expect(resolveDaemonRoot(path.join(inner, 'src'), { respectGitBoundary: true })).toBe(inner);
  });
  it('preserves the worktree boundary when reached through a directory alias', () => {
    const { outer, inner } = fixture();
    const alias = path.join(outer, 'alias'); fs.symlinkSync(inner, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(resolveDaemonRoot(alias, { respectGitBoundary: true })).toBeNull();
  });
  it('carries strict project intent per client rather than deriving it from daemon lifetime', () => {
    expect(parseClientHelloLine(JSON.stringify({ codegraph_client: 1, pid: 123, hostPid: 456, sharedRequired: true }))).toEqual({ pid: 123, hostPid: 456, sharedRequired: true });
    expect(parseClientHelloLine(JSON.stringify({ codegraph_client: 1, pid: 123, hostPid: 456 }))).toEqual({ pid: 123, hostPid: 456 });
    expect(parseClientHelloLine(JSON.stringify({ codegraph_client: 1, pid: 123, sharedRequired: 'true' }))).toEqual({ pid: 123, hostPid: null });
  });
});
