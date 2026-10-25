import { vi } from 'vitest';
import * as generated from '../../src/upstream-explore/extraction/generated-detection';

/** Perturb the generated-file input without changing fixture graph/source.
 * Upstream persists it; native derives it from verified source. */
const flags = new Map<string, boolean>();
let restoreDetector: (() => void) | undefined;

export function setGeneratedFixtureFlag(cg: unknown, file: string, value: number): void {
  if (process.env.CODEGRAPH_UPSTREAM_ORACLE) {
    const graph = cg as { db: { getDatabase?: () => any; db?: any } };
    const db = graph.db.getDatabase?.() ?? graph.db.db;
    db.prepare('UPDATE files SET generated = ? WHERE path = ?').run(value, file);
    return;
  }
  if (!restoreDetector) {
    const original = generated.detectGeneratedFile;
    const spy = vi.spyOn(generated, 'detectGeneratedFile').mockImplementation((filePath, content) =>
      flags.get(filePath) ?? original(filePath, content));
    restoreDetector = () => spy.mockRestore();
  }
  flags.set(file, value !== 0);
}

export function restoreGeneratedFixtureFlags(): void {
  restoreDetector?.();
  restoreDetector = undefined;
  flags.clear();
}
