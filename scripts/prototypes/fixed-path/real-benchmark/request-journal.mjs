/** Append-only diagnostic evidence; not a database durability/recovery mechanism. */
import { open } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

export async function createRequestJournal(file, { intervalMs = 250, batchRows = 32, maxPendingBytes = 4 * 1024 * 1024 } = {}) {
  // Never truncate evidence from an earlier attempt.
  const handle = await open(file, 'wx');
  let pending = [], pendingBytes = 0, outstandingBytes = 0, tail = Promise.resolve(), failure, closed = false;
  const metrics = { records: 0, writtenRecords: 0, bytes: 0, batches: 0, enqueueMs: 0, maxEnqueueMs: 0, writeMs: 0, maxWriteMs: 0, maxOutstandingBytes: 0, intervalMs, batchRows, maxPendingBytes };
  function flush() {
    if (!pending.length || failure) return tail;
    const lines = pending, bytes = pendingBytes;
    pending = []; pendingBytes = 0;
    // Concatenation and asynchronous writes happen outside the measured query.
    tail = tail.then(async () => {
      if (failure) return;
      const start = performance.now();
      try {
        await handle.appendFile(lines.join(''));
        metrics.writtenRecords += lines.length; metrics.bytes += bytes; metrics.batches++;
      } catch (error) { failure = error; }
      finally {
        const elapsed = performance.now() - start;
        metrics.writeMs += elapsed; metrics.maxWriteMs = Math.max(metrics.maxWriteMs, elapsed);
        outstandingBytes -= bytes;
      }
    });
    return tail;
  }
  const timer = setInterval(flush, intervalMs); timer.unref();
  return {
    append(record) {
      const start = performance.now();
      try {
        if (closed) throw new Error('Request journal is closed');
        if (failure) throw failure;
        const line = JSON.stringify(record) + '\n', bytes = Buffer.byteLength(line);
        if (outstandingBytes + bytes > maxPendingBytes) throw new Error('Request journal backlog exceeded; refusing silent evidence loss');
        pending.push(line); pendingBytes += bytes; outstandingBytes += bytes;
        metrics.records++; metrics.maxOutstandingBytes = Math.max(metrics.maxOutstandingBytes, outstandingBytes);
        if (pending.length >= batchRows) void flush();
      } finally {
        const elapsed = performance.now() - start;
        metrics.enqueueMs += elapsed; metrics.maxEnqueueMs = Math.max(metrics.maxEnqueueMs, elapsed);
      }
    },
    async flush() { await flush(); if (failure) throw failure; },
    async close() {
      if (closed) return { ...metrics };
      closed = true; clearInterval(timer);
      try { await flush(); if (failure) throw failure; }
      finally { await handle.close(); }
      return { ...metrics };
    },
  };
}
