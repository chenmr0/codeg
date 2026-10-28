import * as fs from 'node:fs';

/** Explicit offline maintenance only. PID absence is not proof across namespaces.
 * The caller must have stopped every writer and rebuild child before invoking.
 */
export function removeOfflineLock(lockPath: string, offlineConfirmed: boolean,
  probe: (pid: number) => void = pid => { process.kill(pid, 0); }): boolean {
  let before: fs.Stats;
  try { before = fs.lstatSync(lockPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  if (!offlineConfirmed) throw new Error('Stop all CodeGraph writers and rebuild children, then use unlock --offline. PID absence alone does not establish safety.');
  if (!before.isFile() || before.size > 4096) throw new Error('Refusing to remove an unexpected lock file');
  const contents = fs.readFileSync(lockPath, 'utf8');
  const first = contents.split(/\r?\n/)[0]!;
  if (/^[1-9]\d*$/.test(first)) {
    const pid = Number(first);
    if (!Number.isSafeInteger(pid)) throw new Error('Invalid lock owner PID');
    try { probe(pid); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('Cannot verify lock owner state; refusing unlock');
      // The explicit offline assertion, not this result, authorizes maintenance.
      const after = fs.lstatSync(lockPath);
      if (!after.isFile() || before.ino !== after.ino || before.dev !== after.dev ||
          before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
          fs.readFileSync(lockPath, 'utf8') !== contents) throw new Error('Lock changed while checking; refusing unlock');
      fs.unlinkSync(lockPath);
      return true;
    }
    throw new Error(`Lock owner PID ${pid} is still running; refusing unlock`);
  }
  // A partial/corrupt lock needs manual investigation, never a blind unlink.
  throw new Error('Lock owner is missing or malformed; investigate offline before removing it manually');
}
