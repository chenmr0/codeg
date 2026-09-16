/**
 * Installer Tests
 *
 * Tests for installer config-writer fixes:
 * - readJsonFile error handling
 *
 * (The CLAUDE.md instructions block is no longer written — see issue
 * #529. The marker-based install/uninstall self-heal is covered in
 * `installer-targets.test.ts`.)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// We test the exported functions from config-writer
import {
  writeMcpConfig,
} from '../src/installer/config-writer';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-installer-test-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('Installer Config Writer', () => {
  let origCwd: string;
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    origCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    cleanupTempDir(tempDir);
  });

  describe('readJsonFile error handling', () => {
    it('should return empty object for non-existent file', () => {
      // writeMcpConfig reads .mcp.json - if it doesn't exist, it should create it
      writeMcpConfig('local');

      const mcpJson = path.join(tempDir, '.mcp.json');
      expect(fs.existsSync(mcpJson)).toBe(true);

      const content = JSON.parse(fs.readFileSync(mcpJson, 'utf-8'));
      expect(content.mcpServers).toBeDefined();
      expect(content.mcpServers.codegraph_wx).toBeDefined();
    });

    it('rejects corrupted JSON and preserves the original file', () => {
      const mcpJson = path.join(tempDir, '.mcp.json');
      const original = '{ this is not valid json !!!';
      fs.writeFileSync(mcpJson, original);
      expect(() => writeMcpConfig('local')).toThrow(/invalid JSON/);
      expect(fs.readFileSync(mcpJson, 'utf8')).toBe(original);
      expect(fs.existsSync(mcpJson + '.backup')).toBe(false);
    });

    it('should preserve existing valid config when adding codegraph', () => {
      const mcpJson = path.join(tempDir, '.mcp.json');
      fs.writeFileSync(mcpJson, JSON.stringify({
        mcpServers: { other: { command: 'other-tool' } },
        customField: 'preserved',
      }, null, 2));

      writeMcpConfig('local');

      const content = JSON.parse(fs.readFileSync(mcpJson, 'utf-8'));
      expect(content.mcpServers.codegraph_wx).toBeDefined();
      expect(content.mcpServers.other).toBeDefined();
      expect(content.customField).toBe('preserved');
    });
  });
});
