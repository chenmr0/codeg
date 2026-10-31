// Unit regression with real Node streams/timers, not a Windows/OS socket claim.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Duplex } = require('node:stream');
const { Daemon } = require('../../dist/mcp/daemon');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function acceptedSocket() { return new Duplex({read() {}, write(_chunk, _encoding, callback) { callback(); }}); }
for (const clients of [1, 2]) test(`idle 200ms cannot reap ${clients} accepted but unfinished client hello(s)`, async () => {
  const daemon = new Daemon(process.cwd(), {idleTimeoutMs:200, maxIdleMs:0});
  const stopped = [];
  daemon.stop = async reason => { stopped.push(reason); };
  const sockets = [];
  try {
    daemon.armIdleTimer();
    for (let i=0;i<clients;i++) { const socket=acceptedSocket(); sockets.push(socket); daemon.handleConnection(socket); }
    // Client hello deadline is still 3s. A slow accepted client owns the daemon
    // during negotiation; extending the idle/handshake budgets is not the fix.
    await sleep(350);
    assert.deepEqual(stopped, [], 'accepted connection was mistaken for zero clients');
    assert.equal(daemon.getClientCount(), 0);
    for (const socket of sockets) socket.destroy();
    await sleep(350);
    assert.deepEqual(stopped, ['idle timeout'], 'closed handshake must release lifetime ownership');
    assert.equal(daemon.getClientCount(), 0, 'closed handshake must not create a phantom session');
  } finally {
    for (const socket of sockets) socket.destroy();
    daemon.disarmIdleTimer();
    await sleep(0);
  }
});
test('completed hello transfers lifetime to session until its actual stream closes', async () => {
  const daemon = new Daemon(process.cwd(), {idleTimeoutMs:200, maxIdleMs:0});
  const stopped = [], socket = acceptedSocket();
  daemon.stop = async reason => { stopped.push(reason); };
  try {
    daemon.armIdleTimer(); daemon.handleConnection(socket);
    socket.push(JSON.stringify({codegraph_client:1,pid:process.pid,hostPid:process.ppid})+'\n');
    await sleep(350);
    assert.equal(daemon.getClientCount(),1);assert.deepEqual(stopped,[]);
    socket.destroy();await sleep(350);
    assert.equal(daemon.getClientCount(),0);assert.deepEqual(stopped,['idle timeout']);
  } finally { socket.destroy();daemon.disarmIdleTimer();await sleep(0); }
});
