/**
 * Bounded lookahead with parallel work and strictly ordered consumption.
 * Reservations remain charged while the consumer awaits its write/backpressure.
 * Completed results can increase their reservation; already running work may
 * exceed the estimate, but no new work is admitted until space is available.
 */
export interface WeightedInput<T> {
  value: T;
  estimatedBytes: number;
}

export interface OrderedPipelineMetrics {
  peakPending: number;
  peakEstimatedBytes: number;
}

interface OrderedPipelineOptions<T> {
  maxPending: number;
  maxEstimatedBytes: number;
  estimateResultBytes: (value: T) => number;
  signal?: AbortSignal;
  metrics?: OrderedPipelineMetrics;
}

const ABORTED = Symbol('aborted');

async function interruptible<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | typeof ABORTED> {
  if (!signal) return promise;
  if (signal.aborted) return ABORTED;
  let onAbort!: () => void;
  const abort = new Promise<typeof ABORTED>((resolve) => {
    onAbort = () => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, abort]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

function validBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid pipeline byte estimate');
  return Math.max(1, value);
}

export async function* orderedParallelMap<I, O>(
  inputs: AsyncIterable<WeightedInput<I>>,
  map: (input: I) => Promise<O>,
  options: OrderedPipelineOptions<O>,
): AsyncGenerator<O> {
  if (!Number.isSafeInteger(options.maxPending) || options.maxPending < 1 ||
      !Number.isSafeInteger(options.maxEstimatedBytes) || options.maxEstimatedBytes < 1) {
    throw new Error('Pipeline limits must be positive safe integers');
  }
  const iterator = inputs[Symbol.asyncIterator]();
  const pending: Array<{ bytes: number; promise: Promise<Outcome<O>> }> = [];
  let held: IteratorResult<WeightedInput<I>> | undefined;
  let exhausted = false;
  let estimatedBytes = 0;
  let closed = false;
  const recordPeak = () => {
    if (!options.metrics) return;
    options.metrics.peakPending = Math.max(options.metrics.peakPending, pending.length);
    options.metrics.peakEstimatedBytes = Math.max(options.metrics.peakEstimatedBytes, estimatedBytes);
  };

  try {
    while (!options.signal?.aborted) {
      while (!exhausted && pending.length < options.maxPending && !options.signal?.aborted) {
        if (!held) {
          const next = await interruptible(iterator.next(), options.signal);
          if (next === ABORTED) return;
          held = next;
        }
        if (held.done) { exhausted = true; break; }
        const bytes = validBytes(held.value.estimatedBytes);
        // One oversized file is allowed when empty: never skip valid source or
        // deadlock a file whose reservation exceeds the normal buffer budget.
        if (pending.length > 0 && estimatedBytes + bytes > options.maxEstimatedBytes) break;
        const input = held.value.value;
        held = undefined;
        const entry = { bytes, promise: undefined as unknown as Promise<Outcome<O>> };
        estimatedBytes += bytes;
        pending.push(entry);
        recordPeak();
        entry.promise = Promise.resolve().then(async (): Promise<Outcome<O>> => {
          try {
            if (closed || options.signal?.aborted) return { ok: false, error: ABORTED };
            const value = await map(input);
            if (!closed) {
              const resultBytes = validBytes(options.estimateResultBytes(value));
              estimatedBytes += resultBytes - entry.bytes;
              entry.bytes = resultBytes;
              recordPeak();
            }
            return { ok: true, value };
          } catch (error) {
            // Observe every rejection immediately, even when an earlier file
            // is slow or the consumer stops before reaching this result.
            return { ok: false, error };
          }
        });
      }

      if (options.signal?.aborted || pending.length === 0) return;
      const head = pending[0]!;
      const result = await interruptible(head.promise, options.signal);
      if (result === ABORTED || options.signal?.aborted) return;
      if (!result.ok) throw result.error;
      yield result.value;
      // Refill only after consumption finishes, preserving the single writer
      // and bounding both unfinished parses and completed-but-unwritten data.
      pending.shift();
      estimatedBytes -= head.bytes;
    }
  } finally {
    closed = true;
    pending.length = 0;
    // Do not wait for blocked parsers here. The caller owns and tears down the
    // worker pool; late outcomes are observed above and cannot reach a writer.
    await iterator.return?.();
  }
}
