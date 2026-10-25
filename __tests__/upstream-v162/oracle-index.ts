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
  let graph;
  if (oracle) {
    const queries = new QueryBuilder((cg as any).db.getDb());
    queries.setProjectNameTokens(cg.getProjectNameTokens());
    queries.setDeprioritizedPathMatcher((cg as any).queries.getDeprioritizedPathMatcher());
    graph = createExploreGraphApi(cg.getProjectRoot(), queries);
  } else graph = createUpstreamExploreGraph(cg);
  const facade = graph as unknown as Record<PropertyKey, unknown>;
  return new Proxy(facade, {
    get(target, key, receiver) {
      if (key in target) return Reflect.get(target, key, receiver);
      const value = Reflect.get(cg, key);
      return typeof value === 'function' ? value.bind(cg) : value;
    },
  });
}
const Base = oracle ? require(oracle).default : NativeCodeGraph;
function instrument(cg: any) {
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
