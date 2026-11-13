import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { validatePathWithinRoot } from '../src/utils';
import { validatePathWithinRoot as explorePath } from '../src/upstream-explore/utils';
import CodeGraph from '../src/index';

let base: string, root: string, allowed: string, other: string;
const previous = process.env.CODEGRAPH_ALLOWED_SOURCE_ROOTS;
beforeEach(() => {
  delete process.env.CODEGRAPH_ALLOWED_SOURCE_ROOTS;
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-source-roots-')));
  root = path.join(base, 'project'); allowed = path.join(base, 'shared'); other = path.join(base, 'shared-other');
  for (const dir of [root, allowed, other]) fs.mkdirSync(dir);
  for (const dir of [root, allowed, other]) fs.writeFileSync(path.join(dir, 'a.c'), 'int channel_value(void) { return 1; }\n');
  fs.symlinkSync(allowed, path.join(root, 'linked'), 'junction');
});
afterEach(() => {
  if (previous === undefined) delete process.env.CODEGRAPH_ALLOWED_SOURCE_ROOTS;
  else process.env.CODEGRAPH_ALLOWED_SOURCE_ROOTS = previous;
  fs.rmSync(base, { recursive: true, force: true });
});

for (const [name, validate] of [['native', validatePathWithinRoot], ['explore', explorePath]] as const) {
  describe(`${name} explicit source roots`, () => {
    it('preserves default denial and ordinary reads', () => {
      expect(validate(root, 'linked/a.c')).toBeNull();
      expect(validate(root, 'a.c')).toBe(path.join(root, 'a.c'));
    });
    it('allows declared roots only through an in-project alias', () => {
      process.env.CODEGRAPH_ALLOWED_SOURCE_ROOTS = allowed;
      expect(validate(root, 'linked/a.c')).toBe(path.join(allowed, 'a.c'));
      expect(validate(root, '../shared/a.c')).toBeNull();
      expect(validate(root, path.join(allowed, 'a.c'))).toBeNull();
    });
    it('rejects prefix collisions and nested symlink escapes', () => {
      process.env.CODEGRAPH_ALLOWED_SOURCE_ROOTS = allowed;
      fs.symlinkSync(other, path.join(allowed, 'nested'), 'junction');
      fs.symlinkSync(other, path.join(root, 'other'), 'junction');
      expect(validate(root, 'linked/nested/a.c')).toBeNull();
      expect(validate(root, 'other/a.c')).toBeNull();
    });
    it('rechecks a retargeted link without cached grants', () => {
      process.env.CODEGRAPH_ALLOWED_SOURCE_ROOTS = allowed;
      expect(validate(root, 'linked/a.c')).not.toBeNull();
      fs.unlinkSync(path.join(root, 'linked'));
      fs.symlinkSync(other, path.join(root, 'linked'), 'junction');
      expect(validate(root, 'linked/a.c')).toBeNull();
    });
    it('does not authorize relative, broad or alias allowlist entries', () => {
      for (const configured of ['../shared', path.parse(base).root, path.join(root, 'linked')]) {
        process.env.CODEGRAPH_ALLOWED_SOURCE_ROOTS = configured;
        expect(validate(root, 'linked/a.c')).toBeNull();
      }
    });
    it('rejects replacement of an authorized directory by a symlink', () => {
      process.env.CODEGRAPH_ALLOWED_SOURCE_ROOTS = allowed;
      fs.renameSync(allowed, allowed + '-original');
      fs.symlinkSync(other, allowed, 'junction');
      expect(validate(root, 'linked/a.c')).toBeNull();
    });
    it('keeps in-root symlink reads working with opt-in enabled', () => {
      process.env.CODEGRAPH_ALLOWED_SOURCE_ROOTS = allowed;
      fs.mkdirSync(path.join(root, 'inside'));
      fs.writeFileSync(path.join(root, 'inside/a.c'), 'int internal;');
      fs.symlinkSync(path.join(root, 'inside'), path.join(root, 'alias'), 'junction');
      expect(validate(root, 'alias/a.c')).toBe(path.join(root, 'inside/a.c'));
    });
    it('supports multiple explicit roots', () => {
      process.env.CODEGRAPH_ALLOWED_SOURCE_ROOTS = [other, allowed].join(path.delimiter);
      expect(validate(root, 'linked/a.c')).not.toBeNull();
    });
  });
}

it('indexes, reads and incrementally syncs an authorized external C source', async () => {
  process.env.CODEGRAPH_ALLOWED_SOURCE_ROOTS = allowed;
  const cg = CodeGraph.initSync(root);
  try {
    await cg.indexAll();
    const node = cg.getNodesByKind('function').find(n => n.filePath === 'linked/a.c');
    expect(node).toBeDefined();
    expect(await cg.getCode(node!.id)).toContain('return 1');
    fs.writeFileSync(path.join(allowed, 'a.c'), 'int updated_channel(void) { return 22; }\n');
    await cg.sync();
    const updated = cg.getNodesByKind('function').find(n => n.name === 'updated_channel');
    expect(updated?.filePath).toBe('linked/a.c');
    expect(await cg.getCode(updated!.id)).toContain('return 22');
    delete process.env.CODEGRAPH_ALLOWED_SOURCE_ROOTS;
    expect(await cg.getCode(updated!.id)).toBeNull();
  } finally { cg.close(); }
}, 60000);
