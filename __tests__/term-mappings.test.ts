import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
import { loadTermMappings, parseTermMappings, matchTermMappingSymbols, getTermMappingSymbolMatches, MAX_MAPPING_SEEDS } from '../src/term-mappings';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'term-mappings-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
const config = (rules: unknown[]) => parseTermMappings(JSON.stringify({ rules }));

describe('maintainer term mappings', () => {
  it('reuses synonyms and merges matching rules without duplicate seeds', () => {
    const value = config([
      { terms: ['信道配置', '信道参数'], symbols: ['getChannel', 'getRadioCfg'] },
      { terms: ['信道'], symbols: ['getChannel', 'getAutoChannel'] },
    ]);
    expect(matchTermMappingSymbols(value, '请解释信道参数如何实现')).toEqual(['getChannel', 'getRadioCfg', 'getAutoChannel']);
    expect(matchTermMappingSymbols(value, 'unrelated query')).toEqual([]);
  });
  it('matches English terms case insensitively at identifier boundaries and normalizes spaces', () => {
    const value = config([{ terms: ['radio config', 'login'], symbols: ['getChannel'] }]);
    expect(matchTermMappingSymbols(value, 'Explain RADIO   CONFIG')).toEqual(['getChannel']);
    expect(matchTermMappingSymbols(value, 'logins and prelogin')).toEqual([]);
    expect(matchTermMappingSymbols(value, 'login?')).toEqual(['getChannel']);
  });
  it('rejects malformed JSON and validates rules independently', () => {
    expect(parseTermMappings('{').errors).toEqual(['Invalid JSON.']);
    expect(parseTermMappings('[]').errors.length).toBe(1);
    const value = config([{ terms: [''], symbols: ['x'] }, { terms: ['信道'], symbols: ['getChannel'] }]);
    expect(value.errors.length).toBe(1);
    expect(matchTermMappingSymbols(value, '信道')).toEqual(['getChannel']);
  });
  it('reports duplicates and enforces resource bounds', () => {
    expect(config([{ terms: ['a', 'A'], symbols: ['x', 'x'] }]).warnings.length).toBe(1);
    expect(config(Array(1001).fill({ terms: ['t'], symbols: ['x'] })).rules).toEqual([]);
    const value = config([{ terms: ['信道'], symbols: Array.from({ length: 32 }, (_, n) => `name${n}`) }]);
    expect(matchTermMappingSymbols(value, '信道').length).toBe(MAX_MAPPING_SEEDS);
  });
  it('observes edits, invalid replacements and deletion without restart', () => {
    const file = path.join(root, 'term-mappings.json');
    expect(loadTermMappings(root).exists).toBe(false);
    fs.writeFileSync(file, JSON.stringify({ rules: [{ terms: ['信道'], symbols: ['one'] }] }));
    expect(matchTermMappingSymbols(loadTermMappings(root), '信道')).toEqual(['one']);
    fs.writeFileSync(file, JSON.stringify({ rules: [{ terms: ['信道'], symbols: ['two'] }] }));
    expect(matchTermMappingSymbols(loadTermMappings(root), '信道')).toEqual(['two']);
    fs.writeFileSync(file, '{');
    expect(loadTermMappings(root).rules).toEqual([]);
    fs.unlinkSync(file);
    expect(loadTermMappings(root).exists).toBe(false);
  });
  it('refuses oversized files, directories and symlinks quietly at runtime', () => {
    const file = path.join(root, 'term-mappings.json');
    fs.writeFileSync(file, ' '.repeat(256 * 1024 + 1));
    expect(loadTermMappings(root).errors.length).toBe(1);
    fs.unlinkSync(file); fs.mkdirSync(file);
    expect(loadTermMappings(root).errors.length).toBe(1);
    fs.rmdirSync(file);
    fs.writeFileSync(path.join(root, 'other'), '{"rules":[]}');
    fs.symlinkSync(path.join(root, 'other'), file);
    expect(loadTermMappings(root).errors.length).toBe(1);
  });
  it('uses exact case-sensitive indexed names/qualified names with untruncated counts', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE nodes(id TEXT,name TEXT,qualified_name TEXT,kind TEXT,file_path TEXT,start_line INT); CREATE INDEX names ON nodes(name); CREATE INDEX qualified ON nodes(qualified_name)');
      const insert = db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?,?)');
      for (let n = 0; n < 25; n++) insert.run(String(n), 'getChannel', `Radio${n}::getChannel`, 'method', `file${n}.h`, 1);
      insert.run('file', 'getChannel', null, 'file', 'getChannel', 1);
      insert.run('different', 'getChannelOld', null, 'function', 'old.h', 1);
      const result = getTermMappingSymbolMatches(db as any, ['getChannel', 'getchannel', 'Radio1::getChannel', 'missing'], 3);
      expect(result.get('getChannel')?.count).toBe(25);
      expect(result.get('getChannel')?.candidates.length).toBe(3);
      expect(result.get('getchannel')?.count).toBe(0);
      expect(result.get('Radio1::getChannel')?.count).toBe(1);
      expect(result.get('missing')?.count).toBe(0);
    } finally { db.close(); }
  });
});
