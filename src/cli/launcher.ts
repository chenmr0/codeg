import * as fs from 'fs';
import * as path from 'path';

interface CliLocation { execPath: string; cliPath: string }
const currentLocation = (): CliLocation => ({
  execPath: process.execPath,
  cliPath: path.resolve(__dirname, '..', '..', 'dist', 'bin', 'codegraph.js'),
});

/** Detect our payload from disk, not an arbitrary environment command override. */
export function getPortableCodeGraphCommand(location: CliLocation = currentLocation()): { command: string; args: string[] } | null {
  try {
    const bundle = path.dirname(fs.realpathSync(location.execPath));
    const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'portable-manifest.json'), 'utf8')) as { schema?: number; target?: string };
    if (manifest.schema !== 1 || manifest.target !== 'linux-x64-glibc217') return null;
    if (fs.realpathSync(location.cliPath) !== fs.realpathSync(path.join(bundle, 'lib/dist/bin/codegraph.js'))) return null;
    const stable = path.resolve(bundle, '..', '..', 'current');
    // The installer owns current. Persist that stable path so an atomic version
    // switch also upgrades CodeAgent, without relying on the user's shell PATH.
    if (path.basename(path.dirname(bundle)) === 'versions'
      && fs.existsSync(stable)
      && fs.realpathSync(stable) === bundle
      && fs.statSync(path.join(stable, 'bin/codegraph')).isFile()) {
      return { command: path.join(stable, 'bin/codegraph'), args: [] };
    }
    return { command: path.join(bundle, 'bin/codegraph'), args: [] };
  } catch { return null; }
}

/** Bind integrations to this package instead of a codegraph shim on PATH. */
export function getCodeGraphCliCommand(): { command: string; args: string[] } {
  return getPortableCodeGraphCommand() ?? {
    command: process.execPath,
    args: [currentLocation().cliPath],
  };
}
