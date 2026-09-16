/**
 * CodeAgent 3.0 target.
 *
 * CodeAgent 3.0 is a Claude Code fork (`(cc)` in the prompt label), so its
 * config layout mirrors Claude Code's exactly — only the directory and
 * file names change. Writes:
 *
 *   - MCP server entry to `~/.cac.json` (global = user scope, loads in
 *     every project) or `./.mcp.json` (local = project scope). Same
 *     `mcpServers.codegraph_wx` shape as Claude Code. CodeAgent reads its
 *     user-scope MCP servers from `~/.cac.json` (BRAND_CAC.GLOBAL_CONFIG_FILE)
 *     and project-scope from `./.mcp.json` (getProjectMcpFilePathCac →
 *     git root + '.mcp.json').
 *   - Permissions to `~/.cac/settings.json` (global) or
 *     `./.cac/settings.json` (local), gated on `autoAllow`. Same
 *     `mcp__codegraph_wx__*` allowlist format Claude Code uses.
 *   - Instructions to `~/.cac/AGENTS.md` (global) or `./AGENTS.md`
 *     (local — CodeAgent reads the project-root AGENTS.md directly, not
 *     under `.cac/`, matching its getMemoryPath('Project') / ('User')
 *     resolution).
 *   - A native-tool reminder extension to `~/.cac/extensions/` (global) or
 *     `./.cac/extensions/` (local), registered in the matching
 *     `extensions.json`. It appends a short, contextual CodeGraph hint to
 *     the next request after a grep/read touches indexed source.
 *
 * Installation resets reserved new/old names and markers, including
 * legacy command hooks copied from older Claude-compatible settings.
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
  atomicWriteFileSync,
  reconcilePermissions,
  isManagedPermission,
  getMcpServerConfig,
  jsonDeepEqual,
  readJsonFile,
  removeMarkedSection,
  upsertInstructionsEntry,
  writeJsonFile,
} from './shared';
import { removeConfigFile, transactionalTarget, resetMcpEntry, readConfigFile, removeManagedFile, assertObject } from './shared';
import { cleanupLegacyHooks } from './claude';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../instructions-template';
import {
  CODEAGENT_REMINDER_EXTENSION_FILENAME,
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
    const alreadyConfigured = !!config.mcpServers?.codegraph_wx;
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

    // Reset managed allows even when auto-allow is disabled.
    files.push(writePermissionsEntry(loc, opts.autoAllow));
    const hookCleanup = cleanupLegacyHooks(loc, settingsJsonPath(loc));
    if (hookCleanup.action === 'removed') files.push(hookCleanup);

    // 3. AGENTS.md — the short marker-fenced CodeGraph block (#704).
    // The MCP initialize instructions reach only the main agent;
    // AGENTS.md is what Task-tool subagents (and non-MCP harnesses)
    // actually see, so the block carries the codegraph pointers there.
    // Upsert self-heals a stale pre-#529 long block.
    files.push(upsertInstructionsEntry(instructionsPath(loc)));

    // 4. Native-tool reminder extension — write the file first, then
    // register it, so the registration never points at a missing file.
    files.push(removeManagedFile(path.join(configDir(loc), 'extensions', 'codegraph-reminder.ts')));
    files.push(writeReminderExtension(loc));
    files.push(upsertExtensionRegistration(loc));

    return { files };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    // 1. MCP server entry
    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    if (resetMcpEntry(config, undefined)) {
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
    files.push(removeInstructionsEntry(loc));

    // 4. Reminder extension — drop the registration first, then the file.
    files.push(removeExtensionRegistration(loc));
    files.push(removeReminderExtension(loc));
    files.push(removeManagedFile(path.join(configDir(loc), 'extensions', 'codegraph-reminder.ts')));
    const hookCleanup = cleanupLegacyHooks(loc, settingsJsonPath(loc));
    if (hookCleanup.action === 'removed') files.push(hookCleanup);

    return { files };
  }

  printConfig(loc: Location): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify({ mcpServers: { codegraph_wx: getMcpServerConfig() } }, null, 2);
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
  const before = existing.mcpServers?.codegraph_wx;
  const after = getMcpServerConfig();

  if (!resetMcpEntry(existing, after)) {
    // Already exactly what we'd write — preserve byte-identical file.
    return { path: file, action: 'unchanged' };
  }
  const action: 'created' | 'updated' = before ? 'updated' : (fs.existsSync(file) ? 'updated' : 'created');
  writeJsonFile(file, existing);
  return { path: file, action };
}

export function writePermissionsEntry(loc: Location, autoAllow = true): WriteResult['files'][number] {
  return reconcilePermissions(settingsJsonPath(loc), autoAllow);
}

/**
 * Uninstall removes all new/old managed blocks and preserves outside text.
 */
function removeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  const action = removeMarkedSection(file, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
  return { path: file, action };
}

function writeReminderExtension(loc: Location): WriteResult['files'][number] {
  const file = reminderExtensionPath(loc);
  const existed = fs.existsSync(file);
  if (existed && readConfigFile(file) === CODEAGENT_REMINDER_EXTENSION_SOURCE) {
    return { path: file, action: 'unchanged' };
  }
  atomicWriteFileSync(file, CODEAGENT_REMINDER_EXTENSION_SOURCE);
  return { path: file, action: existed ? 'updated' : 'created' };
}

function removeReminderExtension(loc: Location): WriteResult['files'][number] {
  return removeManagedFile(reminderExtensionPath(loc));
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
 * Only the two managed files in the expected directory belong to us.
 * Another directory can contain a user extension with the same basename.
 */
function isOurExtensionEntry(entry: unknown, loc: Location): boolean {
  const s = entrySpecifierOf(entry);
  if (!s) return false;
  if (!path.isAbsolute(s) && !/^\.\.?[/\\]/.test(s)) return false;
  const base = loc === 'global' ? configDir(loc) : process.cwd();
  const normalize = (value: string): string => {
    const resolved = path.resolve(base, value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return [reminderExtensionPath(loc), path.join(configDir(loc), 'extensions', 'codegraph-reminder.ts')]
    .some(file => normalize(file) === normalize(s));
}

function extensionEntries(config: Record<string, any>, file: string): unknown[] {
  assertObject(config, file);
  if (config.extensions !== undefined && !Array.isArray(config.extensions)) {
    throw new Error(`${file}: extensions must be an array.`);
  }
  return config.extensions ?? [];
}

function upsertExtensionRegistration(loc: Location): WriteResult['files'][number] {
  const file = extensionsJsonPath(loc);
  const existed = fs.existsSync(file);
  const config = readJsonFile(file);
  const specifier = extensionEntrySpecifier(loc);
  const entries = extensionEntries(config, file);
  const next = [...entries.filter(e => !isOurExtensionEntry(e, loc)), specifier];
  if (jsonDeepEqual(entries, next)) {
    return { path: file, action: 'unchanged' };
  }
  config.extensions = next;
  writeJsonFile(file, config);
  return { path: file, action: existed ? 'updated' : 'created' };
}

function removeExtensionRegistration(loc: Location): WriteResult['files'][number] {
  const file = extensionsJsonPath(loc);
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };
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
