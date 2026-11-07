import * as path from 'node:path';
import { createExploreGraphApi } from '../../src/mcp/upstream-explore-graph';
import { QueryBuilder } from '../../src/upstream-explore/db/queries';
import { captureGraph } from './capture';
import NativeCodeGraph from '../../src/index';
import { createUpstreamExploreGraph } from '../../src/mcp/upstream-explore-adapter';
const oracle = process.env.CODEGRAPH_UPSTREAM_ORACLE;
// Expose the adapter's official read API while keeping native init/index/close.
// Tests spy on THIS public view, just as they spy on the official CodeGraph.
// Assertions and fixtures remain upstream's.
function view(cg: NativeCodeGraph) {
  const makeGraph = () => {
  let graph;
  if (oracle) {
    const queries = new QueryBuilder((cg as any).db.getDb());
    queries.setProjectNameTokens(cg.getProjectNameTokens());
    queries.setDeprioritizedPathMatcher((cg as any).queries.getDeprioritizedPathMatcher());
    graph = createExploreGraphApi(cg.getProjectRoot(), queries);
  } else graph = createUpstreamExploreGraph(cg);
  return graph as unknown as Record<PropertyKey, unknown>;
  };
  let connection = cg.getExploreQueryConnection?.();
  let facade = makeGraph();
  return new Proxy(facade, {
    get(target, key, receiver) {
      // Lifecycle and native-only helpers must remain callable after close;
      // they do not consume an Explore query connection.
      if (!(key in facade)) {
        const value = Reflect.get(cg, key);
        return typeof value === 'function' ? value.bind(cg) : value;
      }
      const current = cg.getExploreQueryConnection?.();
      if (current !== connection) { connection = current; facade = makeGraph(); }
      // Preserve test spies assigned to the public view, while rebinding the
      // normal methods when portable publication replaces the native reader.
      if (Object.prototype.hasOwnProperty.call(target, key) && Reflect.get(target, key)?._isMockFunction) return Reflect.get(target, key);
      if (key in facade) return Reflect.get(facade, key, receiver);
      const value = Reflect.get(cg, key);
      return typeof value === 'function' ? value.bind(cg) : value;
    },
  });
}
const Base = oracle ? require(oracle).default : NativeCodeGraph;
function instrument(cg: any) {
  if (!oracle && cg.isPortableStorage()) {
    // This imported suite is a query-layer oracle: several upstream fixtures
    // directly insert nodes/edges via private QueryBuilder APIs. Own a writable
    // isolated graph here, rather than weakening production read-only readers.
    // Production CLI/MCP publication is tested separately on the real facade.
    const root = cg.getProjectRoot();
    cg.close();
    cg = NativeCodeGraph.openPortableRaw(root, path.join(root, '.codegraph-wx', 'codegraph.db'), false);
  }
  const index = cg.indexAll.bind(cg);
  cg.indexAll = async (...args: unknown[]) => {
    const result = await index(...args); captureGraph(cg); return result;
  };
  return view(cg);
}
const CodeGraph = new Proxy(Base, {
  get(target, key) {
    const value = Reflect.get(target, key);
    if (key === 'initSync' || key === 'openSync') return (...args: unknown[]) => instrument(value.apply(target, args));
    if (key === 'init' || key === 'open') return async (...args: unknown[]) => instrument(await value.apply(target, args));
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
export { CodeGraph };
export default CodeGraph;
