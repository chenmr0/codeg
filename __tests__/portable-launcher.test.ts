import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getPortableCodeGraphCommand } from '../src/cli/launcher';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg portable launcher ')); roots.push(root);
  const createVersion = (version: string) => {
    const bundle = path.join(root, 'versions', version);
    fs.mkdirSync(path.join(bundle, 'lib/dist/bin'), { recursive: true });
    fs.mkdirSync(path.join(bundle, 'bin'));
    fs.writeFileSync(path.join(bundle, 'node'), 'fixture, never executed');
    fs.writeFileSync(path.join(bundle, 'bin/codegraph'), 'fixture, never executed');
    fs.writeFileSync(path.join(bundle, 'lib/dist/bin/codegraph.js'), '// fixture');
    fs.writeFileSync(path.join(bundle, 'portable-manifest.json'), JSON.stringify({ schema: 1, target: 'linux-x64-glibc217' }));
    return { bundle, execPath: path.join(bundle, 'node'), cliPath: path.join(bundle, 'lib/dist/bin/codegraph.js') };
  };
  const first = createVersion('first');
  const current = path.join(root, 'current'); fs.symlinkSync(first.bundle, current);
  return { root, first, current, createVersion };
}
describe('portable integration launcher', () => {
  it('uses the absolute stable launcher even without a shell PATH', () => {
    const { first, current } = fixture();
    expect(getPortableCodeGraphCommand(first)).toEqual({ command: path.join(current, 'bin/codegraph'), args: [] });
  });
  it('keeps generated integration command unchanged across an atomic version switch', () => {
    const { first, current, createVersion } = fixture();
    const before = getPortableCodeGraphCommand(first);
    const next = createVersion('second');
    fs.unlinkSync(current); fs.symlinkSync(next.bundle, current);
    expect(getPortableCodeGraphCommand(next)).toEqual(before);
    expect(fs.realpathSync(before!.command)).toBe(path.join(next.bundle, 'bin/codegraph'));
  });
  it('does not redirect an explicitly launched old version to a different package', () => {
    const { first, current, createVersion } = fixture();
    const next = createVersion('second'); fs.unlinkSync(current); fs.symlinkSync(next.bundle, current);
    expect(getPortableCodeGraphCommand(first)?.command).toBe(path.join(first.bundle, 'bin/codegraph'));
  });
  it('rejects a matching manifest beside an unrelated runtime/CLI', () => {
    const { root, first } = fixture();
    const unrelated = path.join(root, 'other.js'); fs.writeFileSync(unrelated, '// not this package');
    expect(getPortableCodeGraphCommand({ execPath: first.execPath, cliPath: unrelated })).toBeNull();
  });
  it('does not treat ordinary npm/source installs as portable', () => {
    const { first } = fixture(); fs.unlinkSync(path.join(first.bundle, 'portable-manifest.json'));
    expect(getPortableCodeGraphCommand(first)).toBeNull();
  });
  it('rejects corrupt or unexpected portable manifests', () => {
    const { first } = fixture();
    for (const contents of ['{broken', '{"schema":2,"target":"linux-x64-glibc217"}', '{"schema":1,"target":"other"}']) {
      fs.writeFileSync(path.join(first.bundle, 'portable-manifest.json'), contents);
      expect(getPortableCodeGraphCommand(first)).toBeNull();
    }
  });
});
