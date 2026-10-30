import { createIpcChannel } from './ipc.mjs';
const {send,close:closeIpc}=createIpcChannel();
import { beginOperation, publish, now } from './protocol.mjs';
import { buildGraph, validateGraph, sourceSnapshot, cheapSourceFence, expectedIndex } from './graph-adapter.mjs';
const [root] = process.argv.slice(2);
let op, consumed=false;
try {
  op = beginOperation(root);
  const before = sourceSnapshot(root), indexSnapshot=await expectedIndex(root), started = now();
  await buildGraph(root, op.record.candidate);
  const buildMs = now() - started;
  consumed=true;
  const result = await publish(op, {
    buildMs,
    validate: file => validateGraph(root, file,indexSnapshot),
    validateSource() { if (sourceSnapshot(root).digest !== before.digest) throw new Error('Source changed while candidate was built'); },
    finalSourceFence() { cheapSourceFence(root, before); },
    hook(phase) { send({ type:'phase', phase }); },
  });
  await send({ type:'result', result });
} catch (e) {
  // publish owns safe cleanup even when the builder failed before sealing.
  if (op && !consumed) { consumed=true; const result = await publish(op, {validate(){throw e;}}); await send({type:'result',result}); }
  else await send({type:'error',error:e.stack});
  process.exitCode=1;
} finally { await closeIpc(); }
