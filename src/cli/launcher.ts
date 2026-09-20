import * as path from 'path';

/** Bind integrations to this package instead of a codegraph shim on PATH. */
export function getCodeGraphCliCommand(): { command: string; args: string[] } {
  return {
    command: process.execPath,
    // Both src/cli and dist/cli sit two levels below the package root.
    args: [path.resolve(__dirname, '..', '..', 'dist', 'bin', 'codegraph.js')],
  };
}
