import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

const roots: string[] = [];
const graphs: CodeGraph[] = [];
afterEach(() => {
  for (const graph of graphs.splice(0)) graph.destroy();
  for (const root of roots.splice(0)) fs.rmSync(root, {recursive:true, force:true});
});
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-semantic-redeclarations-'));
  roots.push(root);
  return root;
}
function write(root: string, phase: number) {
  const type = phase ? 'V' : 'U';
  const files: Record<string, string> = {
    'alias.cpp': 'enum class Mode { ON };\nnamespace actual { using ON = int; }\n'
      + 'namespace local { namespace Mode = actual;\nint api_alias(Mode::ON);\n}\n'
      + 'int caller_alias() { return local::api_alias(1); }\n',
    'using.cpp': 'enum class Mode { ON };\nnamespace actual { struct Mode { using ON = int; }; }\n'
      + 'namespace local { using actual::Mode;\nint api_using(Mode::ON);\n}\n'
      + 'int caller_using() { return local::api_using(1); }\n',
    'macros.cpp': '#define MAKE() '
      + `template<class T> int alpha(T); template<class ${type}> int alpha(${type}) { return ${phase}; } `
      + `template<class T = int> int defaults(T); template<class ${type}> int defaults(${type}) { return 1; } `
      + 'int array_param(int a[3]); int array_param(int *a) { return 1; } '
      + 'int function_param(int cb(double)); int function_param(int (*cb)(double)) { return 1; } '
      + `template<class T> struct Box { static int member(T); }; template<class ${type}> int Box<${type}>::member(${type}) { return 1; } `
      + 'int overload(int); int overload(int x) { return x; } int overload(double) { return 2; }\nMAKE()\n'
      + 'int caller_alpha() { return alpha(1); }\n',
  };
  for (const [file, source] of Object.entries(files)) fs.writeFileSync(path.join(root, file), source + `// phase ${phase}\n`);
  return Object.keys(files);
}
function snapshot(graph: CodeGraph) {
  const db = (graph as any).db.db;
  return {
    nodes: db.prepare('SELECT id,kind,name,qualified_name,file_path,signature,is_declaration,is_static FROM nodes ORDER BY id').all(),
    edges: db.prepare('SELECT source,target,kind,line,col,provenance FROM edges ORDER BY source,target,kind,line,col,provenance').all(),
  };
}

it('preserves callable kinds and equivalent macro definitions through index, MCP and changed-file sync', async () => {
  const root = project();
  const paths = write(root, 0);
  const graph = CodeGraph.initSync(root); graphs.push(graph);
  const indexed = await graph.indexAll();
  expect(indexed.complete).toBe(true);
  expect(indexed.errors).toEqual([]);
  const handler = new ToolHandler(graph);
  const verify = async () => {
    for (const name of ['api_alias', 'api_using']) {
      expect(graph.getNodesByName(name)).toEqual([
        expect.objectContaining({kind:'function',isDeclaration:true}),
      ]);
      expect(graph.searchNodes(name, {kinds:['function']})).toHaveLength(1);
      const output = JSON.stringify(await handler.execute('node', {symbol:name}));
      expect(output).toContain(`${name} (function)`);
      expect(output).not.toContain('(variable)');
    }
    for (const name of ['alpha', 'defaults', 'array_param', 'function_param', 'member']) {
      const nodes = graph.getNodesByName(name);
      expect(nodes).toHaveLength(1);
      expect(nodes[0]?.isDeclaration).toBe(false);
      const output = JSON.stringify(await handler.execute('node', {symbol:name, includeCode:true}));
      expect(output).not.toContain('definitions named');
      expect(output).not.toContain('No indexed definition');
    }
    expect(graph.getNodesByName('member')[0]?.isStatic).toBe(true);
    expect(graph.getNodesByName('overload')).toHaveLength(2);
    const db = (graph as any).db.db;
    const calls = db.prepare("SELECT s.name caller,t.name callee,t.kind FROM edges e JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target WHERE e.kind='calls' ORDER BY s.name").all();
    expect(calls).toEqual([
      {caller:'caller_alias',callee:'api_alias',kind:'function'},
      {caller:'caller_alpha',callee:'alpha',kind:'function'},
      {caller:'caller_using',callee:'api_using',kind:'function'},
    ]);
  };
  await verify();
  expect((await graph.sync()).filesModified).toBe(0);
  for (const phase of [1, 0]) {
    write(root, phase);
    const synced = await graph.sync({paths});
    expect(synced.filesErrored).toBe(0);
    await verify();
    const freshRoot = project(); write(freshRoot, phase);
    const fresh = CodeGraph.initSync(freshRoot); graphs.push(fresh);
    await fresh.indexAll();
    expect(snapshot(graph)).toEqual(snapshot(fresh));
  }
}, 30_000);
