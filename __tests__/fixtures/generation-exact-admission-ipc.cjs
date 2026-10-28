// Test-only barrier AFTER CURRENT admission and BEFORE the exact reader opens.
// The publisher is a separate, asynchronously controlled process, never spawnSync.
const fs = require('node:fs');
const path = require('node:path');
const [moduleRoot, root, role] = process.argv.slice(2);
const { CodeGraph } = require(path.join(moduleRoot, 'dist'));
const original = CodeGraph.openReadOnlyAtLease;
let paused = false;
CodeGraph.openReadOnlyAtLease = function (projectRoot, dataDirectory, admission) {
  const target = role === 'sdk' || (role === 'mcp' && new Error().stack.includes('getCodeGraph'));
  let examined = false;
  if (!paused && target && fs.existsSync(path.join(root, '.arm-exact-admission'))) {
    paused = true; examined = true;
    process.send?.({ event: 'admitted-before-open', generation: admission.id, databasePath: admission.databasePath });
    const sleep = new Int32Array(new SharedArrayBuffer(4)), deadline = Date.now() + 10000;
    while (!fs.existsSync(path.join(root, '.release-exact-admission'))) {
      if (Date.now() > deadline) throw Error('Independent exact-admission barrier timed out');
      Atomics.wait(sleep, 0, 0, 5);
    }
  }
  const graph = original.call(this, projectRoot, dataDirectory, admission);
  if (examined) process.send?.({ event: 'exact-reader-opened', databasePath: graph.getDatabaseFilePath(),
    old: graph.getNodesByName('generation_B').map(node => node.name),
    fresh: graph.getNodesByName('generation_C').map(node => node.name) });
  return graph;
};
require('./generation-admission-ipc.cjs');
