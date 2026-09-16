/**
 * Claude Code target. Writes:
 *
 *   - MCP server entry to `~/.claude.json` (global = user scope, loads
 *     in every project) or `./.mcp.json` (local = project scope, the
 *     file Claude Code actually reads for a single project). See the
 *     scope table at https://code.claude.com/docs/en/mcp.
 *   - Permissions to `~/.claude/settings.json` (global) or
 *     `./.claude/settings.json` (local), gated on `autoAllow`.
 *   - Instructions to `~/.claude/CLAUDE.md` (global) or
 *     `./.claude/CLAUDE.md` (local).
 *
 * Earlier versions wrote the local MCP entry to `./.claude.json` — a
 * file Claude Code never reads — so the server silently never loaded
 * until the user manually renamed it to `.mcp.json` (issue #207). We
 * now write `./.mcp.json` and migrate any stale `./.claude.json` entry
 * out of the way on install and uninstall.
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
  reconcilePermissions,
  isManagedPermission,
  getMcpServerConfig,
  readJsonFile,
  removeMarkedSection,
  upsertInstructionsEntry,
  writeJsonFile,
} from './shared';
import { removeConfigFile, transactionalTarget, resetMcpEntry } from './shared';
import { recordCleanup } from '../config-transaction';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../instructions-template';

function configDir(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.claude')
    : path.join(process.cwd(), '.claude');
}
function mcpJsonPath(loc: Location): string {
  // global → ~/.claude.json (user scope: visible in every project).
  // local  → ./.mcp.json (project scope: the ONLY project-level MCP
  // file Claude Code reads — NOT ./.claude.json, which it ignores).
  return loc === 'global'
    ? path.join(os.homedir(), '.claude.json')
    : path.join(process.cwd(), '.mcp.json');
}
/**
 * Where pre-#207 installers wrote the local MCP entry. Claude Code
 * never reads a project-level `./.claude.json`, so we migrate the
 * codegraph entry out of it on install and strip it on uninstall.
 * Only the project-local path is legacy — global `~/.claude.json` is
 * the correct user-scope location and is left untouched.
 */
function legacyLocalMcpPath(): string {
  return path.join(process.cwd(), '.claude.json');
}
function settingsJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'settings.json');
}
function instructionsPath(loc: Location): string {
  return path.join(configDir(loc), 'CLAUDE.md');
}

class ClaudeCodeTarget implements AgentTarget {
  readonly id = 'claude' as const;
  readonly displayName = 'Claude Code';
  readonly docsUrl = 'https://docs.claude.com/en/docs/claude-code';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    const alreadyConfigured = !!config.mcpServers?.codegraph_wx;
    // For "installed" we infer from the existence of either the dir
    // (global) or the project marker file (local). Cheap and avoids
    // shelling out to `claude --version`.
    const installed = loc === 'global'
      ? fs.existsSync(configDir(loc)) || fs.existsSync(mcpPath)
      : fs.existsSync(mcpPath) || fs.existsSync(configDir(loc));
    return { installed, alreadyConfigured, configPath: mcpPath };
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];

    // 1. MCP server entry
    files.push(writeMcpEntry(loc));

    // 1b. Migrate away any stale ./.claude.json left by a pre-#207
    // local install, so the project isn't left with two competing
    // (one dead) MCP configs.
    if (loc === 'local') {
      const migrated = cleanupLegacyLocalMcp();
      if (migrated) files.push(migrated);
    }

    // Reset managed allows even when auto-allow is disabled.
    files.push(writePermissionsEntry(loc, opts.autoAllow));

    // 2b. Strip stale auto-sync hooks left by a pre-0.8 install. Those
    // versions wrote `codegraph mark-dirty` / `sync-if-dirty` hooks to
    // settings.json; both subcommands are gone from the CLI, so the
    // Stop hook now fails every turn with "unknown command
    // 'sync-if-dirty'". Cleaning up on install makes an upgrade
    // self-healing. Only surfaced when something was actually removed.
    const hookCleanup = cleanupLegacyHooks(loc);
    if (hookCleanup.action === 'removed') files.push(hookCleanup);

    // 3. CLAUDE.md instructions — the short marker-fenced CodeGraph
    // block (#704). The MCP initialize instructions reach only the main
    // agent; CLAUDE.md is what Task-tool subagents (and non-MCP
    // harnesses) actually see, so the block carries the codegraph
    // pointers there. Upsert self-heals a stale pre-#529 long block.
    files.push(upsertInstructionsEntry(instructionsPath(loc)));

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

    // 1b. Also strip the codegraph entry from a legacy ./.claude.json
    // so uninstall fully reverses a pre-#207 local install.
    if (loc === 'local') {
      const migrated = cleanupLegacyLocalMcp();
      if (migrated) files.push(migrated);
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

    // 2b. Strip any stale auto-sync hooks a pre-0.8 install left in
    // settings.json. The hook-cleanup step was lost when the installer
    // moved to the per-target architecture; restoring it here means
    // uninstall — and the npm `preuninstall` hook that drives it — fully
    // reverses a legacy install.
    const hookCleanup = cleanupLegacyHooks(loc);
    if (hookCleanup.action === 'removed') files.push(hookCleanup);

    // 3. Instructions — strip the legacy CodeGraph block if present.
    files.push(removeInstructionsEntry(loc));

    return { files };
  }

  printConfig(loc: Location): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify({ mcpServers: { codegraph_wx: getMcpServerConfig() } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpJsonPath(loc), settingsJsonPath(loc), instructionsPath(loc)];
  }
}

/**
 * Per-file write helpers, exported so the legacy `config-writer.ts`
 * shim can call only the named operation (writeMcpConfig writes ONLY
 * the MCP entry, etc.) instead of `claudeTarget.install()` which
 * writes all three files. Without this split the shims silently
 * cause side effects callers don't expect.
 */
export function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpJsonPath(loc);
  const existing = readJsonFile(file);
  const before = existing.mcpServers?.codegraph_wx;
  const after = getMcpServerConfig();

  if (!resetMcpEntry(existing, after)) {
    // Already exactly what we'd write — preserve byte-identical file.
    return { path: file, action: 'unchanged' };
  }
  // 'created' here means: the file itself did not exist before this
  // write. A pre-existing MCP JSON file (`~/.claude.json` globally,
  // `./.mcp.json` locally) containing other MCP servers (no
  // `codegraph` key) is 'updated', not 'created' — we're adding an
  // entry to a file that was already there. Codex uses a different
  // idiom (empty-content => 'created') because its config.toml is
  // ours alone to manage.
  const action: 'created' | 'updated' = before ? 'updated' : (fs.existsSync(file) ? 'updated' : 'created');
  writeJsonFile(file, existing);
  return { path: file, action };
}

/**
 * Strip the codegraph entry from a legacy project-local
 * `./.claude.json` (written by pre-#207 installers, which Claude Code
 * never read). Surgical: only our `codegraph` key is removed; sibling
 * MCP servers and any unrelated keys are preserved, and the file is
 * deleted only when removal leaves it completely empty. Returns the
 * file action for reporting, or `null` when there's nothing to migrate.
 */
function cleanupLegacyLocalMcp(): WriteResult['files'][number] | null {
  const file = legacyLocalMcpPath();
  if (!fs.existsSync(file)) return null;
  const config = readJsonFile(file);
  if (!resetMcpEntry(config, undefined)) return null;
  if (Object.keys(config).length === 0) {
    removeConfigFile(file);
  } else {
    writeJsonFile(file, config);
  }
  return { path: file, action: 'removed' };
}

/** Recognize legacy installer commands, without matching unrelated script text. */
function isLegacyCodegraphHookCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  return /^\s*(?:codegraph(?:-wx)?(?:\.cmd)?|npx(?:\.cmd)?\s+(?:-y\s+|--yes\s+)?(?:@sdd\/codegraph-wx|@colbymchenry\/codegraph)(?:@[^\s]+)?)\s+(?:mark-dirty|sync-if-dirty)(?=\s|$)/.test(command);
}

/**
 * Remove stale codegraph auto-sync hooks from Claude `settings.json`.
 *
 * Surgical at the individual-command level: only entries matching
 * `isLegacyCodegraphHookCommand` are dropped, so a sibling hook sharing
 * a matcher group (or the Stop event) with ours survives. We prune a
 * matcher group only once its `hooks` array is empty, an event only
 * once it has no groups left, and `hooks` itself only once every event
 * is gone — and none of that runs unless we actually removed a
 * codegraph command, so a settings.json with no legacy hooks is left
 * byte-for-byte untouched and reported `unchanged`.
 *
 * Exported so it can be unit-tested directly and reused by both
 * `install` (an upgrade self-heals) and `uninstall`.
 */
export function cleanupLegacyHooks(loc: Location, file = settingsJsonPath(loc)): WriteResult['files'][number] {
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };

  const settings = readJsonFile(file);
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    return { path: file, action: 'unchanged' };
  }

  // Pass 1: drop the legacy command(s) from inside every matcher group.
  let removedCount = 0;
  const emptiedGroups = new Set<unknown>();
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) continue;
      const before = group.hooks.length;
      group.hooks = group.hooks.filter(
        (h: any) => !isLegacyCodegraphHookCommand(h?.command),
      );
      removedCount += before - group.hooks.length;
      if (before > 0 && group.hooks.length === 0) emptiedGroups.add(group);
    }
  }

  if (!removedCount) return { path: file, action: 'unchanged' };

  // Pass 2: prune empty matcher groups, then events with no groups
  // left, then an empty top-level `hooks`. Guarded by the removal count so
  // we never restructure a settings.json that had no codegraph hooks.
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    hooks[event] = groups.filter(
      (g: any) => !emptiedGroups.has(g),
    );
    if (hooks[event].length === 0) delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;

  writeJsonFile(file, settings);
  recordCleanup(`Removed ${removedCount} legacy CodeGraph hook commands from ${file}.`);
  return { path: file, action: 'removed' };
}

export function writePermissionsEntry(loc: Location, autoAllow = true): WriteResult['files'][number] {
  return reconcilePermissions(settingsJsonPath(loc), autoAllow);
}

/**
 * Uninstall removes all new/old managed blocks and preserves outside text.
 */
export function removeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  const action = removeMarkedSection(file, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
  return { path: file, action };
}

export const claudeTarget: AgentTarget = transactionalTarget(new ClaudeCodeTarget());
