/** Local diagnostics are disposable, never part of the portable database. */
import * as path from 'node:path';
import { appendFileSync, existsSync, lstatSync, mkdirSync, renameSync } from 'node:fs';
import type { AdaptiveDecision } from './adaptive-plan';
import type { ResolvedSyncPolicy } from './sync-policy';

export function formatAdaptiveDecision(decision: AdaptiveDecision, policy?: ResolvedSyncPolicy): string {
  return '[adaptive-sync] ' + JSON.stringify({ ...decision, policy, at: new Date().toISOString() });
}

export function appendAdaptiveLog(dataDirectory: string, message: string): void {
  try {
    // Use the already selected directory, including legacy/custom locations.
    // Leave old root logs untouched; they may contain user-retained evidence.
    const runtime = path.join(dataDirectory, '.runtime');
    mkdirSync(runtime, { recursive: true });
    const directory = lstatSync(runtime);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return;
    const log = path.join(runtime, 'adaptive-sync.log');
    if (existsSync(log)) {
      const file = lstatSync(log);
      if (!file.isFile() || file.isSymbolicLink()) return;
      if (file.size > 1024 * 1024) renameSync(log, log + '.1');
    }
    appendFileSync(log, message + '\n');
  } catch {
    // Diagnostics must neither fail a successful sync nor hide its real error.
  }
}
