import * as path from 'path';

/** Bind generated integrations to this package, independent of the shared CLI shim. */
export function getWxCliCommand(): { command: string; args: string[] } {
  return {
    command: process.execPath,
    // src/cli and dist/cli both sit two levels below the package root.
    args: [path.resolve(__dirname, '..', '..', 'dist', 'bin', 'codegraph.js')],
  };
}
