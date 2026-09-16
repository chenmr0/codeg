/**
 * opencode target.
 *
 *   - MCP server entry to `~/.config/opencode/opencode.jsonc` (global,
 *     XDG-style on every platform) or
 *     `./opencode.jsonc` (local). Falls back to `opencode.json` when a
 *     `.json` file already exists; defaults new installs to `.jsonc`
 *     because that's what opencode itself creates on first run.
 *   - A native-tool reminder plugin in the auto-discovered OpenCode plugin
 *     directory. It appends a short, contextual CodeGraph hint after a
 *     grep/read touches indexed source.
 *   - Instructions to `~/.config/opencode/AGENTS.md` (global) or
 *     `./AGENTS.md` (local). opencode reads AGENTS.md for agent
 *     instructions — same convention Codex CLI uses.
 *   - No permissions concept.
 *
 * Config shape uses opencode's wrapper:
 *   {
 *     "$schema": "https://opencode.ai/config.json",
 *     "mcp": { "codegraph_wx": { "type": "local", "command": [...], "enabled": true } }
 *   }
 *
 * The shape differs from Claude/Cursor — opencode uses `mcp.<name>`
 * (not `mcpServers`), takes `command` as a string array combining
 * binary + args, and includes an explicit `enabled` flag.
 *
 * Reads + writes go through `jsonc-parser` so any `//` and `/* *\/`
 * comments the user has added to their `.jsonc` survive idempotent
 * re-runs.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getWxCliCommand } from '../../cli/launcher';
import { recordCleanup } from '../config-transaction';
import { parse as parseJsonc, parseTree, findNodeAtLocation, modify, applyEdits } from 'jsonc-parser';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  atomicWriteFileSync,
  jsonDeepEqual,
  removeMarkedSection,
  upsertInstructionsEntry,
} from './shared';
import { transactionalTarget, readConfigFile, removeManagedFile, hasManagedMcp } from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../instructions-template';
import {
  OPENCODE_REMINDER_PLUGIN_FILENAME,
  OPENCODE_REMINDER_PLUGIN_SOURCE,
} from '../opencode-reminder-plugin';

function globalConfigDir(): string {
  // OpenCode uses XDG_CONFIG_HOME (or ~/.config) on Windows too. In
  // particular, `opencode debug paths` reports ~/.config/opencode rather
  // than %APPDATA%/opencode on current Windows releases.
  const xdg = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim().length > 0
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), '.config');
  return path.join(xdg, 'opencode');
}

function configBaseDir(loc: Location): string {
  return loc === 'global' ? globalConfigDir() : process.cwd();
}

// Pick existing .jsonc, then .json, default to .jsonc for new files.
// opencode auto-creates .jsonc on first run, so that's the dominant
// real-world case and the sensible default for greenfield installs.
function configPath(loc: Location): string {
  const dir = configBaseDir(loc);
  const jsonc = path.join(dir, 'opencode.jsonc');
  const json = path.join(dir, 'opencode.json');
  if (fs.existsSync(jsonc)) return jsonc;
  if (fs.existsSync(json)) return json;
  return jsonc;
}

function instructionsPath(loc: Location): string {
  return path.join(configBaseDir(loc), 'AGENTS.md');
}

function reminderPluginPath(loc: Location): string {
  const pluginDir = loc === 'global'
    ? path.join(globalConfigDir(), 'plugins')
    : path.join(process.cwd(), '.opencode', 'plugins');
  return path.join(pluginDir, OPENCODE_REMINDER_PLUGIN_FILENAME);
}

function readConfigText(file: string): string {
  if (!fs.existsSync(file)) return '';
  return readConfigFile(file);
}

function parseConfig(text: string): Record<string, any> {
  if (!text.trim()) return {};
  const errors: any[] = [];
  const source = text.replace(/^\uFEFF/, '');
  const result = parseJsonc(source, errors, { allowTrailingComma: true });
  if (errors.length || result == null || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Invalid OpenCode JSONC configuration; repair it and retry.');
  }
  const wrappers = parseTree(source)?.children?.filter(entry => entry.children?.[0]?.value === 'mcp') ?? [];
  if (wrappers.length > 1) throw new Error('Duplicate OpenCode mcp sections; combine them and retry.');
  return result as Record<string, any>;
}

function getOpencodeServerEntry(): { type: string; command: string[]; enabled: boolean } {
  const cli = getWxCliCommand();
  return {
    type: 'local',
    command: [cli.command, ...cli.args, 'serve', '--mcp'],
    enabled: true,
  };
}

const FORMATTING = { tabSize: 2, insertSpaces: true, eol: '\n' };

class OpencodeTarget implements AgentTarget {
  readonly id = 'opencode' as const;
  // Displayed as "CodeAgent 2.0 (opencode)" — the user runs a
  // CodeAgent-branded opencode (the 2.0 line, opencode-based) alongside
  // the Claude-Code-forked CodeAgent 3.0. The `(opencode)` suffix keeps
  // the underlying agent identifiable in the prompt.
  readonly displayName = 'CodeAgent 2.0 (opencode)';
  readonly docsUrl = 'https://opencode.ai/docs/config';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = configPath(loc);
    const config = parseConfig(readConfigText(file));
    const alreadyConfigured = !!config.mcp?.codegraph_wx;
    const installed = loc === 'global'
      ? fs.existsSync(globalConfigDir())
      : fs.existsSync(file);
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(writeMcpEntry(loc));
    files.push(removeManagedFile(path.join(path.dirname(reminderPluginPath(loc)), 'codegraph-reminder.js')));
    files.push(writeReminderPlugin(loc));

    // AGENTS.md — the short marker-fenced CodeGraph block (#704). The
    // MCP initialize instructions reach only the main agent; AGENTS.md is
    // what Task-tool subagents (and non-MCP harnesses) actually see, so
    // the block carries the codegraph pointers there. Upsert self-heals
    // a stale pre-#529 long block.
    files.push(upsertInstructionsEntry(instructionsPath(loc)));

    return { files };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];
    const file = configPath(loc);

    if (!fs.existsSync(file)) {
      files.push({ path: file, action: 'not-found' });
    } else {
      const text = readConfigText(file);
      const config = parseConfig(text);
      if (!hasManagedMcp(config, 'mcp')) {
        files.push({ path: file, action: 'not-found' });
      } else {
        // Drop our key surgically. Leaves siblings + comments untouched.
        let updated = text;
        for (const name of ['codegraph', 'codegraph_wx']) {
          while (Object.hasOwn(parseConfig(updated).mcp ?? {}, name)) {
            updated = applyEdits(updated, modify(updated, ['mcp', name], undefined, { formattingOptions: FORMATTING }));
          }
        }

        // If `mcp` is now an empty object, drop the wrapper too.
        const afterParsed = parseConfig(updated);
        if (afterParsed.mcp && typeof afterParsed.mcp === 'object' &&
            Object.keys(afterParsed.mcp).length === 0) {
          const edits = modify(updated, ['mcp'], undefined, { formattingOptions: FORMATTING });
          updated = applyEdits(updated, edits);
        }

        atomicWriteFileSync(file, updated);
        files.push({ path: file, action: 'removed' });
      }
    }

    files.push(removeInstructionsEntry(loc));
    files.push(removeReminderPlugin(loc));
    files.push(removeManagedFile(path.join(path.dirname(reminderPluginPath(loc)), 'codegraph-reminder.js')));

    return { files };
  }

  printConfig(loc: Location): string {
    const target = configPath(loc);
    const snippet = JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      mcp: { codegraph_wx: getOpencodeServerEntry() },
    }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [configPath(loc), reminderPluginPath(loc), instructionsPath(loc)];
  }
}

function writeReminderPlugin(loc: Location): WriteResult['files'][number] {
  const file = reminderPluginPath(loc);
  const existed = fs.existsSync(file);
  if (existed && readConfigFile(file) === OPENCODE_REMINDER_PLUGIN_SOURCE) {
    return { path: file, action: 'unchanged' };
  }
  atomicWriteFileSync(file, OPENCODE_REMINDER_PLUGIN_SOURCE);
  return { path: file, action: existed ? 'updated' : 'created' };
}

function removeReminderPlugin(loc: Location): WriteResult['files'][number] {
  return removeManagedFile(reminderPluginPath(loc));
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = configPath(loc);
  const existed = fs.existsSync(file);
  let text = readConfigText(file);

  // Seed a minimal opencode config when the file is brand-new so
  // the result is a complete, schema-tagged file (not just a bare
  // `{ "mcp": {...} }`).
  if (!text.trim()) {
    text = '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  }

  const config = parseConfig(text);
  hasManagedMcp(config, 'mcp'); // Validate the wrapper before making any edits.
  const before = config.mcp?.codegraph_wx;
  const after = getOpencodeServerEntry();

  const tree = parseTree(text);
  const entries = tree ? findNodeAtLocation(tree, ['mcp'])?.children ?? [] : [];
  const wxCount = entries.filter(entry => entry.children?.[0]?.value === 'codegraph_wx').length;
  if (!Object.hasOwn(config.mcp ?? {}, 'codegraph') && wxCount === 1 && jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }

  // Add $schema if the user's existing file is missing it.
  if (!config.$schema) {
    const schemaEdits = modify(text, ['$schema'], 'https://opencode.ai/config.json', {
      formattingOptions: FORMATTING,
    });
    text = applyEdits(text, schemaEdits);
  }

  // Surgical edit — preserves comments, formatting, and order of
  // every key we don't touch.
  for (const name of ['codegraph', 'codegraph_wx']) {
    while (Object.hasOwn(parseConfig(text).mcp ?? {}, name)) {
      text = applyEdits(text, modify(text, ['mcp', name], undefined, { formattingOptions: FORMATTING }));
      recordCleanup(`Removed managed OpenCode MCP entry: ${name}.`);
    }
  }
  const edits = modify(text, ['mcp', 'codegraph_wx'], after, {
    formattingOptions: FORMATTING,
  });
  const updated = applyEdits(text, edits);
  atomicWriteFileSync(file, updated);

  return { path: file, action: existed ? 'updated' : 'created' };
}

/**
 * Strip the marker-delimited CodeGraph block from AGENTS.md if a prior
 * install wrote one. Used by both install (self-heal on upgrade) and
 * uninstall — see issue #529.
 */
function removeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  const action = removeMarkedSection(file, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
  return { path: file, action };
}

export const opencodeTarget: AgentTarget = transactionalTarget(new OpencodeTarget());
