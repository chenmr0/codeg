/** CAC migration helpers, adapted from the wx installer's managed reset logic. */
import type { AgentTarget, WriteResult } from './targets/types';
import {
  atomicWriteFileSync, configFileExists, readConfigFile, removeConfigFile,
  recordCleanup, withConfigTransaction,
} from './config-transaction';
import { INSTRUCTION_MARKERS, resetManagedSections } from './managed-sections';
import { CODEGRAPH_INSTRUCTIONS_BLOCK } from './instructions-template';
import { jsonDeepEqual } from './targets/shared';
import { getCodeGraphCliCommand } from '../cli/launcher';

export { atomicWriteFileSync, configFileExists, readConfigFile, removeConfigFile } from './config-transaction';

/** CAC starts this installation even when another package replaces the CLI shim. */
export function getCodeAgentMcpServerConfig(): { type: string; command: string; args: string[] } {
  const cli = getCodeGraphCliCommand();
  return { type: 'stdio', command: cli.command, args: [...cli.args, 'serve', '--mcp'] };
}

export function assertObject(value: unknown, label: string): asserts value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}: expected a configuration object.`);
  }
}

export function readJsonFile(file: string): Record<string, any> {
  if (!configFileExists(file)) return {};
  const content = readConfigFile(file);
  let value: unknown;
  try {
    value = JSON.parse(content.replace(/^\uFEFF/, ''));
  } catch (error) {
    // Keep CAC's existing malformed-JSON recovery, but stage its backup with
    // all other writes so a later validation error leaves every file intact.
    console.warn(`  Warning: Could not parse ${file}: ${String(error)}`);
    atomicWriteFileSync(file + '.backup', content);
    return {};
  }
  assertObject(value, file);
  return value;
}

export function writeJsonFile(file: string, value: Record<string, any>): void {
  atomicWriteFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export function resetMcpEntry(config: Record<string, any>, entry?: unknown): boolean {
  if (config.mcpServers !== undefined) assertObject(config.mcpServers, 'mcpServers');
  const servers = config.mcpServers ?? {};
  const hasLegacy = Object.hasOwn(servers, 'codegraph_wx');
  const hasCurrent = Object.hasOwn(servers, 'codegraph');
  if (entry === undefined && !hasLegacy && !hasCurrent) return false;
  if (entry !== undefined && !hasLegacy && jsonDeepEqual(servers.codegraph, entry)) return false;
  delete servers.codegraph_wx;
  if (entry === undefined) delete servers.codegraph;
  else servers.codegraph = entry;
  if (Object.keys(servers).length) config.mcpServers = servers;
  else delete config.mcpServers;
  return true;
}

export function isManagedPermission(value: unknown): boolean {
  return typeof value === 'string' && /^mcp__codegraph(?:_wx)?__/.test(value);
}

export function upsertInstructionsEntry(file: string): WriteResult['files'][number] {
  const existed = configFileExists(file);
  const content = readConfigFile(file);
  const reset = resetManagedSections(content, INSTRUCTION_MARKERS, CODEGRAPH_INSTRUCTIONS_BLOCK, file);
  if (reset.content === content) return { path: file, action: 'unchanged' };
  atomicWriteFileSync(file, reset.content);
  return { path: file, action: existed ? 'updated' : 'created' };
}

export function removeInstructionsEntry(file: string): WriteResult['files'][number] {
  if (!configFileExists(file)) return { path: file, action: 'not-found' };
  const reset = resetManagedSections(readConfigFile(file), INSTRUCTION_MARKERS, '', file);
  if (!reset.count) return { path: file, action: 'not-found' };
  if (reset.content.trim()) atomicWriteFileSync(file, reset.content);
  else removeConfigFile(file);
  return { path: file, action: 'removed' };
}

/** A fixed legacy filename is retired only inside this installation's scope. */
export function removeLegacyFile(file: string): WriteResult['files'][number] {
  if (!configFileExists(file)) return { path: file, action: 'not-found' };
  removeConfigFile(file);
  recordCleanup(`Removed legacy CodeGraph reminder: ${file}`);
  return { path: file, action: 'removed' };
}

export function transactionalTarget(target: AgentTarget): AgentTarget {
  const install = target.install.bind(target);
  const uninstall = target.uninstall.bind(target);
  target.install = (loc, options) => withConfigTransaction(`codeagent install ${loc}`, () => {
    const result = install(loc, options);
    result.files = result.files.filter(file => file.action !== 'not-found' && file.action !== 'kept');
    return result;
  });
  target.uninstall = loc => withConfigTransaction(`codeagent uninstall ${loc}`, () => uninstall(loc));
  return target;
}
