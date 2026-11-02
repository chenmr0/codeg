/** Query-layer oracle harness, NOT the production portable facade.
 * These upstream tests mutate SQLite statistics/transactions and spy on private
 * QueryBuilder methods. Own a writable test-only handle, expose the vendored
 * QueryBuilder, and use upstream's index shape for its explicit plan assertions.
 * Native single-column layouts are checked separately by the 1,944 differential
 * assertions in explore-upstream-20261102-db.test.ts.
 */
import NativeCodeGraph from '../../src/index';
import { QueryBuilder } from '../../src/upstream-explore/db/queries';
import { createExploreGraphApi } from '../../src/mcp/upstream-explore-graph';
import * as path from 'node:path';

function view(root: string): any {
  const cg = NativeCodeGraph.openPortableRaw(root, path.join(root, '.codegraph-wx', 'codegraph.db'), false);
  const db = cg.getExploreQueryConnection();
  if (!(db.prepare('PRAGMA table_info(files)').all() as Array<{name:string}>).some(c => c.name === 'generated')) {
    db.exec('ALTER TABLE files ADD COLUMN generated INTEGER NOT NULL DEFAULT 0');
  }
  db.exec('DROP INDEX IF EXISTS idx_nodes_kind; CREATE INDEX idx_nodes_kind ON nodes(kind, file_path, start_line, id)');
  // Rebuilding an index drops its statistics; restore the small-fixture plan.
  db.exec('ANALYZE');
  const queries = new QueryBuilder(db);
  const graph = createExploreGraphApi(root, queries, () => queries.rebuildTemporaryNameSegmentVocab());
  return new Proxy(cg, {
    get(target, key) {
      if (key === 'queries') return queries;
      if (key === 'db') return { getDb: () => db };
      if (key in graph) return (graph as any)[key];
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
const CodeGraph = {
  async init(root: string, options?: any) {
    const cg = await NativeCodeGraph.init(root, options);
    cg.close();
    return view(root);
  },
  async open(root: string) { return view(root); },
};
type CodeGraph = any;
export default CodeGraph;
