/**
 * Bounded concurrent task scheduler whose results are consumed in input order.
 *
 * Tasks may finish in any order, but a result is yielded only when every lower
 * sequence has already been yielded. Weight remains reserved until the
 * consumer requests the next result, so queued and completed work share one
 * hard budget. A task heavier than the budget is allowed only while the window
 * is otherwise empty.
 */

export interface OrderedWindowTask<T> {
  weight: number;
  run: () => Promise<T>;
}

export interface OrderedWindowState {
  runningTasks: number;
  completedTasks: number;
  retainedTasks: number;
  retainedWeight: number;
  /** Caller-defined weight of completed results retained for ordered yield. */
  retainedResultWeight: number;
  nextLaunchSequence: number;
  nextYieldSequence: number;
}

export interface OrderedWindowOptions<T> {
  maxTasks: number;
  maxWeight: number;
  /** Optional completed-result weight used for diagnostics and future budgets. */
  getResultWeight?: (value: T) => number;
  /**
   * Stops admitting new tasks while completed results retained for ordered
   * yield meet this limit. Already-running tasks may still complete, so the
   * physical peak can exceed the limit by at most the existing task window.
   */
  maxResultWeight?: number;
  onStateChange?: (state: OrderedWindowState) => void;
}

type TaskOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

interface WindowEntry<T> {
  weight: number;
  resultWeight: number;
  completed: boolean;
  outcome: Promise<TaskOutcome<T>>;
}

function normalizePositiveInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

function normalizeWeight(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export async function* runOrderedTaskWindow<T>(
  tasks: readonly OrderedWindowTask<T>[],
  options: OrderedWindowOptions<T>,
): AsyncGenerator<{ sequence: number; value: T }, void, void> {
  const maxTasks = normalizePositiveInteger(options.maxTasks);
  const maxWeight = normalizePositiveInteger(options.maxWeight);
  const maxResultWeight = options.maxResultWeight === undefined
    ? Number.POSITIVE_INFINITY
    : normalizePositiveInteger(options.maxResultWeight);
  const entries = new Map<number, WindowEntry<T>>();
  let retainedWeight = 0;
  let retainedResultWeight = 0;
  let nextLaunchSequence = 0;
  let nextYieldSequence = 0;

  const emitState = (): void => {
    if (!options.onStateChange) return;
    let completedTasks = 0;
    for (const entry of entries.values()) {
      if (entry.completed) completedTasks++;
    }
    try {
      options.onStateChange({
        runningTasks: entries.size - completedTasks,
        completedTasks,
        retainedTasks: entries.size,
        retainedWeight,
        retainedResultWeight,
        nextLaunchSequence,
        nextYieldSequence,
      });
    } catch {
      // Diagnostic observers must not affect scheduling.
    }
  };

  const launch = (sequence: number): void => {
    const task = tasks[sequence]!;
    const weight = normalizeWeight(task.weight);
    let entry!: WindowEntry<T>;
    entry = {
      weight,
      resultWeight: 0,
      completed: false,
      outcome: Promise.resolve()
        .then(task.run)
        .then((value): TaskOutcome<T> => {
          const resultWeight = normalizeWeight(
            options.getResultWeight?.(value) ?? 0,
          );
          entry.resultWeight = resultWeight;
          retainedResultWeight += resultWeight;
          return { ok: true, value };
        })
        .catch((error): TaskOutcome<T> => ({ ok: false, error }))
        .finally(() => {
          entry.completed = true;
          emitState();
        }),
    };
    entries.set(sequence, entry);
    retainedWeight += weight;
    nextLaunchSequence++;
    emitState();
  };

  const fill = (): void => {
    while (
      nextLaunchSequence < tasks.length &&
      entries.size < maxTasks
    ) {
      const nextWeight = normalizeWeight(
        tasks[nextLaunchSequence]!.weight,
      );
      if (
        entries.size > 0 &&
        retainedWeight + nextWeight > maxWeight
      ) {
        break;
      }
      if (retainedResultWeight >= maxResultWeight) break;
      launch(nextLaunchSequence);
    }
  };

 fill();
  try {
    while (nextYieldSequence < tasks.length) {
      const sequence = nextYieldSequence;
      const entry = entries.get(sequence);
      if (!entry) {
        throw new Error(
          `Ordered task window could not launch sequence ${sequence}`,
        );
      }
      const outcome = await entry.outcome;
      if (!outcome.ok) throw outcome.error;

      yield { sequence, value: outcome.value };

      entries.delete(sequence);
      retainedWeight = Math.max(0, retainedWeight - entry.weight);
      retainedResultWeight = Math.max(
        0,
        retainedResultWeight - entry.resultWeight,
      );
      nextYieldSequence++;
      fill();
      emitState();
    }
  } finally {
    // Consumers may stop on cancellation or an upstream store error while
    // completed tasks are buffered behind an earlier sequence. The tasks
    // themselves are not cancellable, but dropping the retained entries lets
    // their results be reclaimed as soon as those promises settle.
    entries.clear();
    retainedWeight = 0;
    retainedResultWeight = 0;
    emitState();
 }
}
