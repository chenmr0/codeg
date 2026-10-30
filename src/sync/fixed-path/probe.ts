import * as fs from 'node:fs';
import * as path from 'node:path';
import { inspectFixedPathLayout, recoverFixedPathMigration } from '../fixed-path-layout';
import { recoverFixedPathInitialization } from '../fixed-path-initialization';
import { Participant } from './protocol';

export function isFixedPathLayout(dataDirectory: string): boolean {
  if (fs.existsSync(dataDirectory)) {
    if (!fs.lstatSync(dataDirectory).isDirectory()) throw new Error('Data directory must be a real directory');
    dataDirectory = fs.realpathSync(dataDirectory);
  }
  recoverFixedPathInitialization(dataDirectory);
  recoverFixedPathMigration(dataDirectory);
  return inspectFixedPathLayout(dataDirectory) === 'fixed';
}
/** A probe never returns an unprotected path. The actual open must acquire its
 * own fresh admission; publication may occur between probe and open. */
export function probeFixedPath(dataDirectory: string): void {
  const participant = new Participant({ project: path.dirname(dataDirectory), dataDirectory },
    () => ({ close(): void {} }));
  try { participant.requestSync(() => undefined); }
  finally { participant.close(); }
}
