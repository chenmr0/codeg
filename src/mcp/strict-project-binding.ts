/** Per-session directory identity. Index generations may change; the root may not. */
import * as fs from 'fs';
export interface StrictProjectBinding { root: string; dev: bigint; ino: bigint }
export function bindStrictProject(root: string): StrictProjectBinding | null {
  try {
    const canonical = fs.realpathSync(root);
    const stat = fs.statSync(canonical, { bigint: true });
    return stat.isDirectory() && stat.ino > 0n && stat.dev >= 0n ? { root: canonical, dev: stat.dev, ino: stat.ino } : null;
  } catch { return null; }
}
export function isStrictProjectBindingCurrent(binding: StrictProjectBinding): boolean {
  try {
    const stat = fs.statSync(binding.root, { bigint: true });
    return stat.isDirectory() && stat.dev === binding.dev && stat.ino === binding.ino;
  } catch { return false; }
}
