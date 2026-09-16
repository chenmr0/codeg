/** Shared installer operations; managed names and markers are reset on install. */
import type { AgentTarget, WriteResult } from './types';
import * as fs from 'fs';
import { getWxCliCommand } from '../../cli/launcher';
import { atomicWriteFileSync, configFileExists, readConfigFile, removeConfigFile, recordCleanup, withConfigTransaction } from '../config-transaction';
import { INSTRUCTION_MARKERS, MarkerPair, resetManagedSections } from '../managed-sections';
import { CODEGRAPH_INSTRUCTIONS_BLOCK, CODEGRAPH_SECTION_END, CODEGRAPH_SECTION_START } from '../instructions-template';
export { atomicWriteFileSync, readConfigFile, removeConfigFile, configFileExists } from '../config-transaction';

export function getMcpServerConfig(): { type: string; command: string; args: string[] } {
  const cli = getWxCliCommand();
  return { type: 'stdio', command: cli.command, args: [...cli.args, 'serve', '--mcp'] };
}
export function getCodeGraphPermissions(): string[] {
  return ['explore', 'search', 'node', 'context', 'text_search', 'callers', 'callees', 'impact', 'files', 'status']
    .map(tool => `mcp__codegraph_wx__${tool}`);
}
export function assertObject(value: unknown, label: string): asserts value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected a configuration object.`);
}
export function readJsonFile(filePath: string): Record<string, any> {
  if (!configFileExists(filePath)) return {};
  try {
    const value: unknown = JSON.parse(readConfigFile(filePath).replace(/^\uFEFF/, ''));
    assertObject(value, filePath);
    return value;
  } catch (error) {
    throw new Error(`${filePath}: invalid JSON configuration; repair it and retry. ${String(error)}`);
  }
}
export function writeJsonFile(filePath: string, data: Record<string, any>): void {
  atomicWriteFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}
export function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => jsonDeepEqual(v, b[i]));
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).sort();
  const bk = Object.keys(bo).sort();
  return ak.length === bk.length && ak.every((k, i) => k === bk[i] && jsonDeepEqual(ao[k], bo[k]));
}
export function hasManagedMcp(config: Record<string, any>, key = 'mcpServers'): boolean {
  if (config[key] === undefined) return false;
  assertObject(config[key], key);
  return Object.hasOwn(config[key], 'codegraph') || Object.hasOwn(config[key], 'codegraph_wx');
}
export function resetMcpEntry(config: Record<string, any>, entry: unknown, key = 'mcpServers'): boolean {
  const managed = hasManagedMcp(config, key);
  if (entry !== undefined && !Object.hasOwn(config[key] ?? {}, 'codegraph') && jsonDeepEqual(config[key]?.codegraph_wx, entry)) return false;
  if (entry === undefined && !managed) return false;
  const servers = config[key] ?? {};
  const count = ['codegraph', 'codegraph_wx'].filter(name => Object.hasOwn(servers, name)).length;
  delete servers.codegraph;
  delete servers.codegraph_wx;
  if (entry !== undefined) servers.codegraph_wx = entry;
  if (Object.keys(servers).length) config[key] = servers;
  else delete config[key];
  if (count) recordCleanup(`Reset ${count} managed MCP entries in ${key}.`);
  return true;
}
export function isManagedPermission(value: unknown): boolean {
  return typeof value === 'string' && /^mcp__codegraph(?:_wx)?__/.test(value);
}
export function reconcilePermissions(file: string, autoAllow: boolean): WriteResult['files'][number] {
  const existed = configFileExists(file);
  const settings = readJsonFile(file);
  const before = JSON.stringify(settings);
  if (settings.permissions !== undefined) assertObject(settings.permissions, `${file}: permissions`);
  const permissions = settings.permissions ?? {};
  if (permissions.allow !== undefined && !Array.isArray(permissions.allow)) throw new Error(`${file}: permissions.allow must be an array.`);
  const allow: unknown[] = permissions.allow ?? [];
  const kept = allow.filter(value => !isManagedPermission(value));
  const next = [...kept, ...(autoAllow ? getCodeGraphPermissions() : [])];
  if (next.length) permissions.allow = next;
  else delete permissions.allow;
  if (Object.keys(permissions).length) settings.permissions = permissions;
  else delete settings.permissions;
  if (before === JSON.stringify(settings)) return { path: file, action: existed ? 'unchanged' : 'not-found' };
  if (allow.length !== kept.length) recordCleanup(`Reset ${allow.length - kept.length} managed permission rules.`);
  writeJsonFile(file, settings);
  return { path: file, action: existed ? 'updated' : 'created' };
}
export function transactionalTarget(target: AgentTarget): AgentTarget {
  const install = target.install.bind(target);
  const uninstall = target.uninstall.bind(target);
  const detect = target.detect.bind(target);
  target.detect = loc => {
    try { return detect(loc); } catch {
      const paths = target.describePaths(loc);
      // Detection must not prevent the user from selecting a broken config.
      // Install will surface the precise parse error without writing anything.
      return { installed: paths.some(file => fs.existsSync(file)), alreadyConfigured: false, configPath: paths[0] };
    }
  };
  target.install = (loc, options) => withConfigTransaction(`${target.id} install ${loc}`, () => {
    const result = install(loc, options);
    result.files = result.files.filter(file => file.action !== 'not-found' && file.action !== 'kept');
    const unique = new Map<string, WriteResult['files'][number]>();
    for (const file of result.files) {
      const previous = unique.get(file.path);
      if (!previous || previous.action === 'unchanged') unique.set(file.path, file);
    }
    result.files = [...unique.values()];
    return result;
  });
  target.uninstall = loc => withConfigTransaction(`${target.id} uninstall ${loc}`, () => uninstall(loc));
  return target;
}
export function removeManagedFile(file: string): WriteResult['files'][number] {
  if (!configFileExists(file)) return { path: file, action: 'not-found' };
  removeConfigFile(file);
  recordCleanup(`Removed managed file: ${file}`);
  return { path: file, action: 'removed' };
}
function markerPairs(start: string, end: string): readonly MarkerPair[] {
  return INSTRUCTION_MARKERS.some(pair => pair[0] === start) ? INSTRUCTION_MARKERS : [[start, end]];
}
export function replaceOrAppendMarkedSection(filePath: string, body: string, startMarker: string, endMarker: string): 'created' | 'updated' | 'appended' | 'unchanged' {
  const existed = configFileExists(filePath);
  const content = readConfigFile(filePath);
  const reset = resetManagedSections(content, markerPairs(startMarker, endMarker), body, filePath);
  if (reset.content === content) return 'unchanged';
  atomicWriteFileSync(filePath, reset.content);
  if (reset.count) recordCleanup(`Replaced ${reset.count} managed instruction blocks in ${filePath}.`);
  return !existed ? 'created' : reset.count ? 'updated' : 'appended';
}
export function upsertInstructionsEntry(file: string): WriteResult['files'][number] {
  const action = replaceOrAppendMarkedSection(file, CODEGRAPH_INSTRUCTIONS_BLOCK, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
  return { path: file, action: action === 'appended' ? 'updated' : action };
}
export function removeMarkedSection(filePath: string, startMarker: string, endMarker: string): 'removed' | 'not-found' | 'kept' {
  if (!configFileExists(filePath)) return 'kept';
  const reset = resetManagedSections(readConfigFile(filePath), markerPairs(startMarker, endMarker), '', filePath);
  if (!reset.count) return 'not-found';
  if (!reset.content.trim()) removeConfigFile(filePath);
  else atomicWriteFileSync(filePath, reset.content);
  recordCleanup(`Removed ${reset.count} managed instruction blocks in ${filePath}.`);
  return 'removed';
}
