import { parentPort, workerData } from 'worker_threads';
import { scanRawSourceSnapshot } from './raw-source-evidence';
import type { RawEvidenceWorkerData, RawEvidenceWorkerMessage } from './raw-source-types';

if (!parentPort) throw new Error('raw-source-worker must run inside a worker thread');
const port = parentPort;
const { task, control: shared } = workerData as RawEvidenceWorkerData;
const control = new Int32Array(shared);
const controller = new AbortController();
const send = (message: RawEvidenceWorkerMessage) => port.postMessage(message);
const cancelIfRequested = () => {
  if (Atomics.load(control, 0) === 1) controller.abort();
};
port.on('message', (message: { type?: string }) => {
  if (message.type === 'cancel') controller.abort();
});
port.once('close', () => controller.abort());
const poll = setInterval(cancelIfRequested, 20);
poll.unref();
cancelIfRequested();

process.once('exit', () => {
  const pid = Atomics.exchange(control, 1, 0);
  if (pid > 0) {
    try { process.kill(pid); } catch { /* already exited */ }
  }
});

void scanRawSourceSnapshot(task, controller.signal, (progress) => {
  if (progress.event === 'start' && progress.pid) Atomics.store(control, 1, progress.pid);
  cancelIfRequested();
  if (progress.event === 'end') Atomics.store(control, 1, 0);
  send({ type: 'progress', progress });
}).then(
  (report) => send({ type: 'result', report }),
  (error) => send({ type: 'error', message: error instanceof Error ? error.message : String(error) }),
).finally(() => {
  clearInterval(poll);
  controller.abort();
  port.close();
});
