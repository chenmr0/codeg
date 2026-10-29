// Test-only IPC barriers around real public SDK / actual stdio MCP operations.
// Never inject a synchronous child wait while holding the lifecycle gate.
const fs = require('node:fs');
const path = require('node:path');
const [moduleRoot, root, role] = process.argv.slice(2);
const { CodeGraph } = require(path.join(moduleRoot, 'dist'));
const store = require(path.join(moduleRoot, 'dist/sync/generation-store'));
const directory = require(path.join(moduleRoot, 'dist/directory'));
const lifecycle = require(path.join(moduleRoot, 'dist/sync/generation-lifecycle'));
const { ContextBuilder } = require(path.join(moduleRoot, 'dist/context'));
const data = path.join(root, '.codegraph-wx');
let graph, server, contextBarrier, manifestBarrier;
const send = message => process.send?.(message);
const names = queries => ({ old: queries.getNodesByName('generation_B').map(n => n.name),
  fresh: queries.getNodesByName('generation_C').map(n => n.name) });
for (const method of ['getCode', 'buildContext']) {
  const original = ContextBuilder.prototype[method];
  ContextBuilder.prototype[method] = async function (...args) {
    if (contextBarrier?.method === method) {
      const barrier = contextBarrier; contextBarrier = undefined;
      send({ event: 'operation-pinned', method, before: names(this.queries) });
      await new Promise(resolve => { barrier.resume = resolve; global.activeBarrier = barrier; });
      send({ event: 'operation-resumed', method, after: names(this.queries) });
    }
    return original.apply(this, args);
  };
}
const originalRead = fs.readFileSync;
fs.readFileSync = function (file, ...args) {
  const value = originalRead.call(this, file, ...args);
  const stack = manifestBarrier ? new Error().stack : '';
  if (manifestBarrier && String(file) === path.join(data, 'CURRENT') &&
      stack.includes('resolveGeneration') && /withReadView|readView|getCodeGraph|isInitialized|validateDirectory|createDirectory/.test(stack)) {
    const release = manifestBarrier; manifestBarrier = undefined;
    send({ event: 'manifest-read-under-test' });
    // Parent receives IPC, probes the gate in another process, then creates this
    // release marker. The publisher probe is bounded (25ms), so no wait cycle.
    const deadline = Date.now() + 5000, sleep = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(release)) {
      if (Date.now() > deadline) throw Error('Independent manifest barrier timed out');
      Atomics.wait(sleep, 0, 0, 5);
    }
  }
  return value;
};

process.on('message', async message => {
  const reply = (value, error) => send({ reply: message.id, value, error });
  try {
    switch (message.action) {
      case 'arm-context': contextBarrier = { method: message.method }; reply(true); return;
      case 'resume-context': global.activeBarrier?.resume(); global.activeBarrier = undefined; reply(true); return;
      case 'arm-manifest': manifestBarrier = message.release; reply(true); return;
      case 'cold-probe': {
        const method = message.method;
        if (method === 'open' || method === 'openSync') {
          graph = method === 'open' ? await CodeGraph.open(root) : CodeGraph.openSync(root);
          reply(graph.searchNodes('generation_').map(row => row.node.name));
        } else if (method === 'createDirectory') {
          try { directory.createDirectory(root); reply(false); }
          catch (error) { if (!error.message.startsWith('CodeGraph already initialized')) throw error; reply(true); }
        } else reply(directory[method](root));
        return;
      }
      case 'arm-after-preflight': {
        const original = directory.isInitialized;
        directory.isInitialized = (...args) => {
          const result = original(...args);
          directory.isInitialized = original;
          send({ event: 'preflight-complete' });
          const deadline = Date.now() + 10000, sleep = new Int32Array(new SharedArrayBuffer(4));
          while (!fs.existsSync(message.release)) {
            if (Date.now() > deadline) throw Error('Preflight release timed out');
            Atomics.wait(sleep, 0, 0, 5);
          }
          return result;
        };
        reply(true); return;
      }
      case 'query': reply(graph.searchNodes(message.query).map(row => ({ id: row.node.id, name: row.node.name }))); return;
      case 'get-code': reply(await graph.getCode(message.nodeId)); return;
      case 'build-context': reply(await graph.buildContext('generation_B', { includeCode: false })); return;
      case 'close-facade': graph.close(); reply(true); return;
      case 'probe-gate': {
        const start = performance.now();
        try { lifecycle.withLifecycleGate(data, () => {}); reply({ acquired: true, elapsed: performance.now() - start }); }
        catch (error) { reply({ acquired: false, elapsed: performance.now() - start, error: String(error) }); }
        return;
      }
      case 'publish-own':
      case 'publish': {
        fs.writeFileSync(path.join(root, 'main.c'), 'int generation_C(void) { return 2; }\n');
        fs.writeFileSync(path.join(root, '.gitignore'), '# independently published C\n');
        const own = message.action === 'publish-own';
        const writer = own ? graph : await CodeGraph.open(root);
        let result;
        try { result = await writer.sync(); } finally { if (!own) writer.close(); }
        await store.drainGenerationCollections();
        reply({ result, current: store.resolveGeneration(data) }); return;
      }
      case 'stop': graph?.close(); await store.drainGenerationCollections(); reply(true); process.disconnect(); return;
      default: throw Error(`Unknown IPC command ${message.action}`);
    }
  } catch (error) { reply(undefined, { message: error.message, code: error.code, stack: error.stack }); }
});

(async () => {
  if (role === 'sdk') graph = CodeGraph.openSync(root);
  if (role === 'mcp') {
    const { MCPServer } = require(path.join(moduleRoot, 'dist/mcp'));
    server = new MCPServer(root); await server.start();
  }
  send({ event: 'ready', role, pid: process.pid });
})().catch(error => { console.error(error); process.exitCode = 1; process.disconnect(); });
