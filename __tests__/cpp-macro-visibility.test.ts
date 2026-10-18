import { beforeAll, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src';
import { loadGrammarsForLanguages } from '../src/extraction/grammars';

beforeAll(() => loadGrammarsForLanguages(['cpp']));

// Reconstructed from the readable release supplement; original tar unavailable.
const source = `#define TEST_CLASS(suite, name) suite##_##name##_Test
#define TEST_IMPL(suite, name) class TEST_CLASS(suite, name) { public: void TestBody(); }; void TEST_CLASS(suite, name)::TestBody()
#define TEST(suite, name) TEST_IMPL(suite, name)
namespace rocksdb { namespace crc32c {
class CRC {};
TEST(CRC, StandardResults) {}
}}
`;

it('unrelated header addition and removal do not change legal TestBody symbols', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-macro-visibility-'));
  try {
    fs.writeFileSync(path.join(root, 'test.cpp'), source);
    const snapshots = [];
    for (const poison of [false, true, false]) {
      const header = path.join(root, 'unrelated.h');
      if (poison) fs.writeFileSync(header, '#define CRC 0x1edc6f41\n');
      else if (fs.existsSync(header)) fs.unlinkSync(header);
      fs.rmSync(path.join(root, '.codegraph-wx'), { recursive: true, force: true });
      const cg = CodeGraph.initSync(root);
      try {
        await cg.indexAll();
        snapshots.push(cg.getNodesByName('TestBody').map(n => ({ name: n.qualifiedName, declaration: !!n.isDeclaration })));
      } finally { cg.close(); }
    }
    expect(snapshots[0]).toEqual([{ name: 'rocksdb::crc32c::CRC_StandardResults_Test::TestBody', declaration: false }]);
    expect(snapshots[1]).toEqual(snapshots[0]);
    expect(snapshots[2]).toEqual(snapshots[0]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 30000);
