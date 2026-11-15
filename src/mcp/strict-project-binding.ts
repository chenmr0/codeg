import * as fs from 'fs';
import { getCodeGraphDir } from '../directory';
import { existingPathIdentity } from '../path-identity';

/** Bind stable directories. Publication may replace the database inside them. */
export interface StrictProjectBinding {
  root: string;
  rootId: string;
  dataDir: string;
  dataId: string;
}

export function bindStrictProject(root: string): StrictProjectBinding | null {
  try {
    const canonical = fs.realpathSync(root);
    const dataDir = getCodeGraphDir(canonical);
    if (!fs.lstatSync(dataDir).isDirectory()) return null;
    const rootId = existingPathIdentity(canonical);
    const dataId = existingPathIdentity(dataDir);
    return rootId && dataId ? { root: canonical, rootId, dataDir, dataId } : null;
  } catch { return null; }
}

export function isStrictProjectBindingCurrent(binding: StrictProjectBinding): boolean {
  return existingPathIdentity(binding.root) === binding.rootId &&
    existingPathIdentity(binding.dataDir) === binding.dataId &&
    getCodeGraphDir(binding.root) === binding.dataDir;
}
