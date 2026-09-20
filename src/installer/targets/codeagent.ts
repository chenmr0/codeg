/**
 * CodeAgent 3.0 target.
 *
 * CodeAgent 3.0 is a Claude Code fork (`(cc)` in the prompt label), so its
 * config layout mirrors Claude Code's exactly — only the directory and
 * file names change. Writes:
 *
 *   - MCP server entry to `~/.cac.json` (global = user scope, loads in
 *     every project) or `./.mcp.json` (local = project scope). Same
 *     `mcpServers.codegraph` shape as Claude Code, with absolute Node/CLI paths
 *     bound to this package instead of the shared CLI shim. CodeAgent reads its
 *     user-scope MCP servers from `~/.cac.json` (BRAND_CAC.GLOBAL_CONFIG_FILE)
 *     and project-scope from `./.mcp.json` (getProjectMcpFilePathCac →
 *     git root + '.mcp.json').
 *   - Permissions to `~/.cac/settings.json` (global) or
 *     `./.cac/settings.json` (local), gated on `autoAllow`. Same
 *     `mcp__codegraph__*` allowlist format Claude Code uses.
 *   - Instructions to `~/.cac/AGENTS.md` (global) or `./AGENTS.md`
 *     (local — CodeAgent reads the project-root AGENTS.md directly, not
 *     under `.cac/`, matching its getMemoryPath('Project') / ('User')
 *     resolution).
 *   - A native-tool reminder extension to `~/.cac/extensions/` (global) or
 *     `./.cac/extensions/` (local), registered in the matching
 *     `extensions.json`. It appends a short, contextual CodeGraph hint to
 *     the next request after a grep/read touches indexed source.
 *
 * Older wx installs used codegraph_wx keys, CODEGRAPH_WX markers and a
 * codegraph-wx-reminder.ts extension. Install consolidates these into the
 * current names within the selected scope, with backup and rollback.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  getCodeGraphPermissions,
  jsonDeepEqual,
} from './shared';
import {
  assertObject, atomicWriteFileSync, configFileExists, isManagedPermission,
  readConfigFile, readJsonFile, removeConfigFile, removeInstructionsEntry,
  removeLegacyFile, resetMcpEntry, transactionalTarget, upsertInstructionsEntry,
  writeJsonFile, getCodeAgentMcpServerConfig as getMcpServerConfig,
} from '../codeagent-config';
import {
  CODEAGENT_REMINDER_EXTENSION_FILENAME,
  CODEAGENT_REMINDER_EXTENSION_MARKER,
  CODEAGENT_REMINDER_EXTENSION_SOURCE,
} from '../codeagent-reminder-extension';

function configDir(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.cac')
    : path.join(process.cwd(), '.cac');
}
function mcpJsonPath(loc: Location): string {
  // global → ~/.cac.json (user scope: visible in every project).
  // local  → ./.mcp.json (project scope: the file CodeAgent reads for
  // project-level MCP, resolved from the git root / cwd).
  return loc === 'global'
    ? path.join(os.homedir(), '.cac.json')
    : path.join(process.cwd(), '.mcp.json');
}
function settingsJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'settings.json');
}
function instructionsPath(loc: Location): string {
  // Global AGENTS.md lives under ~/.cac/; project-local AGENTS.md lives
  // at the project root (NOT under .cac/), matching CodeAgent's
  // hierarchical instructions loader (getMemoryPath).
  return loc === 'global'
    ? path.join(configDir('global'), 'AGENTS.md')
    : path.join(process.cwd(), 'AGENTS.md');
}
function reminderExtensionPath(loc: Location): string {
  // CodeAgent auto-loads extensions from ~/.cac/extensions/ (user) and
  // <project>/.cac/extensions/ (project), registered via extensions.json.
  return path.join(configDir(loc), 'extensions', CODEAGENT_REMINDER_EXTENSION_FILENAME);
}
function legacyReminderExtensionPath(loc: Location): string {
  return path.join(configDir(loc), 'extensions', 'codegraph-wx-reminder.ts');
}
function extensionsJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'extensions.json');
}
function extensionEntrySpecifier(loc: Location): string {
  // User-level entries resolve "./" against ~/.cac (resolveEntryBaseDir);
  // project-level entries resolve against the project root
  // (resolveLocalSpecifier), so the local entry must carry the .cac/ prefix.
  return loc === 'global'
    ? './extensions/' + CODEAGENT_REMINDER_EXTENSION_FILENAME
    : './.cac/extensions/' + CODEAGENT_REMINDER_EXTENSION_FILENAME;
}

class CodeAgentTarget implements AgentTarget {
  readonly id = 'codeagent' as const;
  readonly displayName = 'CodeAgent 3.0 (cc)';
  readonly docsUrl = 'https://docs.codeagent.example.com';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    const alreadyConfigured = !!(config.mcpServers?.codegraph || config.mcpServers?.codegraph_wx);
    // Infer "installed" from the existence of either the config dir
    // (global) or the project MCP marker file (local). Cheap and avoids
    // shelling out to `codeagentcli --version`.
    const installed = loc === 'global'
      ? fs.existsSync(configDir(loc)) || fs.existsSync(mcpPath)
      : fs.existsSync(mcpPath) || fs.existsSync(configDir(loc));
    return { installed, alreadyConfigured, configPath: mcpPath };
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];

    // 1. MCP server entry
    files.push(writeMcpEntry(loc));

    // Retire wx permissions even without granting new automatic permissions.
    files.push(writePermissionsEntry(loc, opts.autoAllow));

    // 3. AGENTS.md — the short marker-fenced CodeGraph block (#704).
    // The MCP initialize instructions reach only the main agent;
    // AGENTS.md is what Task-tool subagents (and non-MCP harnesses)
    // actually see, so the block carries the codegraph pointers there.
    // Upsert self-heals a stale pre-#529 long block.
    files.push(upsertInstructionsEntry(instructionsPath(loc)));

    // 4. Native-tool reminder extension — write the file first, then
    // register it, so the registration never points at a missing file.
    files.push(writeReminderExtension(loc));
    files.push(upsertExtensionRegistration(loc));
    files.push(removeLegacyFile(legacyReminderExtensionPath(loc)));

    return { files };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    // 1. MCP server entry
    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    if (resetMcpEntry(config)) {
      writeJsonFile(mcpPath, config);
      files.push({ path: mcpPath, action: 'removed' });
    } else {
      files.push({ path: mcpPath, action: 'not-found' });
    }

    // 2. Permissions
    const settingsPath = settingsJsonPath(loc);
    const settings = readJsonFile(settingsPath);
    if (Array.isArray(settings.permissions?.allow)) {
      const before = settings.permissions.allow.length;
      settings.permissions.allow = settings.permissions.allow.filter(
        (p: unknown) => !isManagedPermission(p),
      );
      if (settings.permissions.allow.length !== before) {
        if (settings.permissions.allow.length === 0) {
          delete settings.permissions.allow;
        }
        if (Object.keys(settings.permissions).length === 0) {
          delete settings.permissions;
        }
        writeJsonFile(settingsPath, settings);
        files.push({ path: settingsPath, action: 'removed' });
      } else {
        files.push({ path: settingsPath, action: 'not-found' });
      }
    } else {
      files.push({ path: settingsPath, action: 'not-found' });
    }

    // 3. Instructions — strip the legacy CodeGraph block if present.
    files.push(removeInstructionsEntry(instructionsPath(loc)));

    // 4. Reminder extension — drop the registration first, then the file.
    files.push(removeExtensionRegistration(loc));
    files.push(removeReminderExtension(loc));
    files.push(removeLegacyFile(legacyReminderExtensionPath(loc)));

    return { files };
  }

  printConfig(loc: Location): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify({ mcpServers: { codegraph: getMcpServerConfig() } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    // mcpJsonPath must stay first: contract tests seed a sibling MCP server
    // into the first path matching /\.jsonc?$/, and extensionsJsonPath also
    // matches .json — appending the new paths keeps that seeding on the MCP
    // config.
    return [
      mcpJsonPath(loc),
      settingsJsonPath(loc),
      instructionsPath(loc),
      reminderExtensionPath(loc),
      extensionsJsonPath(loc),
    ];
  }
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpJsonPath(loc);
  const existing = readJsonFile(file);
  const existed = configFileExists(file);
  const after = getMcpServerConfig();

  if (!resetMcpEntry(existing, after)) {
    // Already exactly what we'd write — preserve byte-identical file.
    return { path: file, action: 'unchanged' };
  }
  writeJsonFile(file, existing);
  return { path: file, action: existed ? 'updated' : 'created' };
}

export function writePermissionsEntry(loc: Location, autoAllow = true): WriteResult['files'][number] {
  const file = settingsJsonPath(loc);
  const settings = readJsonFile(file);
  const existed = configFileExists(file);
  const before = JSON.stringify(settings);
  if (settings.permissions !== undefined) assertObject(settings.permissions, `${file}: permissions`);
  const permissions = settings.permissions ?? {};
  if (permissions.allow !== undefined && !Array.isArray(permissions.allow)) {
    throw new Error(`${file}: permissions.allow must be an array.`);
  }
  const allow: unknown[] = permissions.allow ?? [];
  const next = allow.filter(
    (perm: unknown) => typeof perm !== 'string' ||
      (!perm.startsWith('mcp__codegraph_wx__') && (!autoAllow ||
        (perm !== 'mcp__codegraph__explore' && !perm.startsWith('mcp__codegraph__codegraph_')))),
  );
  for (const perm of autoAllow ? getCodeGraphPermissions() : []) {
    if (!next.includes(perm)) next.push(perm);
  }
  if (next.length) permissions.allow = next;
  else delete permissions.allow;
  if (Object.keys(permissions).length) settings.permissions = permissions;
  else delete settings.permissions;
  if (before === JSON.stringify(settings)) {
    return { path: file, action: existed ? 'unchanged' : 'not-found' };
  }
  writeJsonFile(file, settings);
  return { path: file, action: existed ? 'updated' : 'created' };
}

function writeReminderExtension(loc: Location): WriteResult['files'][number] {
  const file = reminderExtensionPath(loc);
  const existed = configFileExists(file);
  if (existed && readConfigFile(file) === CODEAGENT_REMINDER_EXTENSION_SOURCE) {
    return { path: file, action: 'unchanged' };
  }
  atomicWriteFileSync(file, CODEAGENT_REMINDER_EXTENSION_SOURCE);
  return { path: file, action: existed ? 'updated' : 'created' };
}

function removeReminderExtension(loc: Location): WriteResult['files'][number] {
  const file = reminderExtensionPath(loc);
  if (!configFileExists(file)) return { path: file, action: 'not-found' };

  // The filename is namespaced, but still avoid deleting a user replacement
  // that no longer carries our ownership marker.
  let content = '';
  try { content = readConfigFile(file); } catch { return { path: file, action: 'kept' }; }
  if (!content.includes(CODEAGENT_REMINDER_EXTENSION_MARKER)) {
    return { path: file, action: 'kept' };
  }
  try {
    removeConfigFile(file);
    return { path: file, action: 'removed' };
  } catch {
    return { path: file, action: 'kept' };
  }
}

/**
 * Extract the specifier from an extensions.json entry. Entries may be a
 * plain string, a [specifier, options] tuple, or a { path, options? }
 * object (CodeAgent's ExtensionsConfigSchema).
 */
function entrySpecifierOf(entry: unknown): string | null {
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry) && typeof entry[0] === 'string') return entry[0];
  if (entry && typeof entry === 'object' && typeof (entry as any).path === 'string') {
    return (entry as any).path;
  }
  return null;
}

/**
 * Match only the managed files in this scope's extension directory. Preserve
 * unrelated extensions even when another directory uses the same basename.
 */
function isOurExtensionEntry(entry: unknown, loc: Location, legacyOnly = false): boolean {
  const s = entrySpecifierOf(entry);
  if (!s) return false;
  if (!path.isAbsolute(s) && !/^\.\.?[/\\]/.test(s)) return false;
  const base = loc === 'global' ? configDir(loc) : process.cwd();
  const normalize = (value: string): string => {
    const resolved = path.resolve(base, value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const files = legacyOnly ? [legacyReminderExtensionPath(loc)]
    : [reminderExtensionPath(loc), legacyReminderExtensionPath(loc)];
  return files.some(file => normalize(file) === normalize(s));
}

function extensionEntries(config: Record<string, any>, file: string): unknown[] {
  if (config.extensions !== undefined && !Array.isArray(config.extensions)) {
    throw new Error(`${file}: extensions must be an array.`);
  }
  return config.extensions ?? [];
}

function upsertExtensionRegistration(loc: Location): WriteResult['files'][number] {
  const file = extensionsJsonPath(loc);
  const existed = configFileExists(file);
  const config = readJsonFile(file);
  const specifier = extensionEntrySpecifier(loc);
  const entries = extensionEntries(config, file);
  const managed = entries.filter(e => isOurExtensionEntry(e, loc));
  if (managed.length === 1 && !isOurExtensionEntry(managed[0], loc, true)) {
    // Keep a valid single current registration, including its object options.
    return { path: file, action: 'unchanged' };
  }
  config.extensions = [...entries.filter(e => !isOurExtensionEntry(e, loc)), specifier];
  if (jsonDeepEqual(entries, config.extensions)) return { path: file, action: 'unchanged' };
  writeJsonFile(file, config);
  return { path: file, action: existed ? 'updated' : 'created' };
}

function removeExtensionRegistration(loc: Location): WriteResult['files'][number] {
  const file = extensionsJsonPath(loc);
  if (!configFileExists(file)) return { path: file, action: 'not-found' };
  const config = readJsonFile(file);
  const entries = extensionEntries(config, file);
  const kept = entries.filter((e) => !isOurExtensionEntry(e, loc));
  if (kept.length === entries.length) return { path: file, action: 'not-found' };
  if (kept.length === 0 && Object.keys(config).every((k) => k === 'extensions')) {
    // The file only carried our entry — remove it entirely.
    removeConfigFile(file);
    return { path: file, action: 'removed' };
  }
  config.extensions = kept;
  writeJsonFile(file, config);
  return { path: file, action: 'removed' };
}

export const codeagentTarget: AgentTarget = transactionalTarget(new CodeAgentTarget());
