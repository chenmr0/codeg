/**
 * Gemini CLI target (also covers the rebranded "Antigravity CLI" —
 * Google is in the middle of unifying its CLI tools under
 * Antigravity, and the new CLI continues to read `~/.gemini/settings.json`
 * + project-local `.gemini/settings.json`). Writes:
 *
 *   - MCP server entry to `~/.gemini/settings.json` (global) or
 *     `./.gemini/settings.json` (local) under the standard
 *     `mcpServers.codegraph_wx` key. Same shape as Claude / Cursor.
 *   - Instructions to `~/.gemini/GEMINI.md` (global) or `./GEMINI.md`
 *     (local — Gemini reads the project root file directly, not
 *     under `.gemini/`).
 *
 * No permissions concept — Gemini CLI gates tool invocations through
 * the `trust` field per server, not an external allowlist. We leave
 * `trust` unset so the user controls confirmation prompts.
 *
 * The Antigravity IDE shares `~/.gemini/GEMINI.md` for instructions
 * but uses a separate MCP config file (`~/.gemini/antigravity/mcp_config.json`)
 * — see `./antigravity.ts`. Both targets writing to GEMINI.md is
 * safe: the marker-based section replacement makes the second write
 * a byte-identical no-op.
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
  getMcpServerConfig,
  readJsonFile,
  removeMarkedSection,
  upsertInstructionsEntry,
  writeJsonFile,
} from './shared';
import { transactionalTarget, resetMcpEntry } from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../instructions-template';

function configDir(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.gemini')
    : path.join(process.cwd(), '.gemini');
}
function settingsJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'settings.json');
}
function instructionsPath(loc: Location): string {
  // Global GEMINI.md lives under ~/.gemini/; project-local GEMINI.md
  // lives at the project root (NOT under .gemini/), matching how
  // Gemini CLI's hierarchical context loader searches.
  return loc === 'global'
    ? path.join(configDir('global'), 'GEMINI.md')
    : path.join(process.cwd(), 'GEMINI.md');
}

class GeminiTarget implements AgentTarget {
  readonly id = 'gemini' as const;
  readonly displayName = 'Gemini CLI';
  readonly docsUrl = 'https://geminicli.com/docs/tools/mcp-server/';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = settingsJsonPath(loc);
    const config = readJsonFile(file);
    const alreadyConfigured = !!config.mcpServers?.codegraph_wx;
    const installed = loc === 'global'
      ? fs.existsSync(configDir('global')) || fs.existsSync(file)
      : fs.existsSync(file) || fs.existsSync(configDir('local'));
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(writeMcpEntry(loc));

    // GEMINI.md — the short marker-fenced CodeGraph block (#704). The
    // MCP initialize instructions reach only the main agent; GEMINI.md is
    // what Task-tool subagents (and non-MCP harnesses) actually see, so
    // the block carries the codegraph pointers there. Upsert self-heals
    // a stale pre-#529 long block.
    files.push(upsertInstructionsEntry(instructionsPath(loc)));

    return { files };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    const file = settingsJsonPath(loc);
    const config = readJsonFile(file);
    if (resetMcpEntry(config, undefined)) {
      // If the file is now an empty `{}` we still leave it — other
      // (top-level) Gemini settings the user might add later can
      // share the file; deleting it would be surprising.
      writeJsonFile(file, config);
      files.push({ path: file, action: 'removed' });
    } else {
      files.push({ path: file, action: 'not-found' });
    }

    files.push(removeInstructionsEntry(loc));

    return { files };
  }

  printConfig(loc: Location): string {
    const target = settingsJsonPath(loc);
    const snippet = JSON.stringify({ mcpServers: { codegraph_wx: getMcpServerConfig() } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [settingsJsonPath(loc), instructionsPath(loc)];
  }
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = settingsJsonPath(loc);

  const existing = readJsonFile(file);
  const before = existing.mcpServers?.codegraph_wx;
  const after = getMcpServerConfig();

  if (!resetMcpEntry(existing, after)) {
    return { path: file, action: 'unchanged' };
  }
  const action: 'created' | 'updated' =
    before ? 'updated' : (fs.existsSync(file) ? 'updated' : 'created');
  writeJsonFile(file, existing);
  return { path: file, action };
}

/**
 * Strip the marker-delimited CodeGraph block from GEMINI.md if a prior
 * install wrote one. Used by both install (self-heal on upgrade) and
 * uninstall — see issue #529.
 */
function removeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  const action = removeMarkedSection(file, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
  return { path: file, action };
}

export const geminiTarget: AgentTarget = transactionalTarget(new GeminiTarget());
