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
  /** Maximum unfinished map operations; also the default total lookahead. */
  maxPending: number;
  /** Total unconsumed entries, including unfinished and completed results. */
  maxBuffered?: number;
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
  const maxBuffered = options.maxBuffered ?? options.maxPending;
  if (!Number.isSafeInteger(maxBuffered) || maxBuffered < options.maxPending) {
    throw new Error('Buffered pipeline limit must be at least the pending limit');
  }
  const refillWhileWaiting = maxBuffered > options.maxPending;
  const iterator = inputs[Symbol.asyncIterator]();
  const pending: Array<{ bytes: number; promise: Promise<Outcome<O>>; settled: boolean }> = [];
  let held: IteratorResult<WeightedInput<I>> | undefined;
  let exhausted = false;
  let estimatedBytes = 0;
  let closed = false;
  let running = 0;
  let changed: (() => void) | undefined;
  const recordPeak = () => {
    if (!options.metrics) return;
    options.metrics.peakPending = Math.max(options.metrics.peakPending, pending.length);
    options.metrics.peakEstimatedBytes = Math.max(options.metrics.peakEstimatedBytes, estimatedBytes);
  };

  try {
    while (!options.signal?.aborted) {
      let admitted = 0;
      while (!exhausted && pending.length < maxBuffered && running < options.maxPending &&
          !options.signal?.aborted) {
        // Once the ordered head is ready, give the writer a turn after at most
        // one refill. A fast producer must not delay it behind a large lookahead.
        if (refillWhileWaiting && admitted > 0 && pending[0]?.settled) break;
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
        const entry = { bytes, promise: undefined as unknown as Promise<Outcome<O>>, settled: false };
        estimatedBytes += bytes;
        pending.push(entry);
        running++;
        admitted++;
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
          } finally {
            running--;
            entry.settled = true;
            changed?.();
          }
        });
      }

      if (options.signal?.aborted || pending.length === 0) return;
      const head = pending[0]!;
      if (refillWhileWaiting && !head.settled) {
        // Any completion can free an execution slot while an earlier file is
        // still parsing. Completed results keep their byte reservation and are
        // consumed strictly in order; the writer's reservation stays charged.
        try {
          const wake = new Promise<void>(resolve => { changed = resolve; });
          if (await interruptible(wake, options.signal) === ABORTED) return;
        } finally { changed = undefined; }
        continue;
      }
      const result = await interruptible(head.promise, options.signal);
      if (result === ABORTED || options.signal?.aborted) return;
      if (!result.ok) throw result.error;
      yield result.value;
      // Release this reservation only after ordered consumption finishes, so
      // a blocked writer retains the charge for both source and graph data.
      pending.shift();
      estimatedBytes -= head.bytes;
    }
  } finally {
    closed = true;
    changed = undefined;
    pending.length = 0;
    // Do not wait for blocked parsers here. The caller owns and tears down the
    // worker pool; late outcomes are observed above and cannot reach a writer.
    await iterator.return?.();
  }
}
