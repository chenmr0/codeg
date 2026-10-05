import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { isGrammarLoaded } from '../src/extraction/grammars';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('sync loads only grammars relevant to the changed files', () => {
  it('does not initialize C/C++ append-delta grammars for Python or TypeScript-only edits', async () => {
    // Run in a fresh test module with no eager loadAllGrammars call. This is a
    // real loaded-state check, not a mocked grammar loader or time threshold.
    expect(isGrammarLoaded('c')).toBe(false);
    expect(isGrammarLoaded('cpp')).toBe(false);

    for (const fixture of [
      { name: 'standalone.py', before: 'def simple():\n    return 1\n', after: 'def simple():\n    return 2\n' },
      { name: 'standalone.ts', before: 'export function simple() { return 1; }\n', after: 'export function simple() { return 2; }\n' },
    ]) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-language-'));
      temporaryRoots.push(root);
      const sourcePath = path.join(root, fixture.name);
      fs.writeFileSync(sourcePath, fixture.before);
      const cg = CodeGraph.initSync(root);
      try {
        const indexed = await cg.indexAll();
        expect(indexed.complete).toBe(true);
        expect(indexed.errors).toEqual([]);
        expect(isGrammarLoaded('c')).toBe(false);
        expect(isGrammarLoaded('cpp')).toBe(false);

        // A complete non-scoped sync with one modified file otherwise meets
        // the append-delta initialization gate. It must not eagerly load the
        // two C-family grammars before discovering this file is ineligible.
        fs.writeFileSync(sourcePath, fixture.after);
        const synced = await cg.sync();
        expect(synced.filesModified).toBe(1);
        expect(synced.filesErrored).toBe(0);
        expect(cg.getNodesByName('simple')).toHaveLength(1);
        expect(isGrammarLoaded('c'), `${fixture.name} must not load C`).toBe(false);
        expect(isGrammarLoaded('cpp'), `${fixture.name} must not load C++`).toBe(false);
      } finally {
        cg.close();
      }
    }
  });
});
