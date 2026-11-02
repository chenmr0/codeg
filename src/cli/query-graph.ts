import type CodeGraph from '../index';
import { PortableBusyError } from '../sync/portable/protocol';
import { isInitialized } from '../directory';

/** A live publisher is evidence of an existing project, not an absent index.
 * Actual query admission below waits for its publication fence. */
export function isQueryProject(projectPath: string): boolean {
  try { return isInitialized(projectPath); }
  catch (error) {
    if (error instanceof PortableBusyError) return true;
    throw error;
  }
}

/** Admit the entire CLI query to one database generation, not each individual
 * method call. Only admission is retried: never replay output or a write. */
export async function openQueryGraph(
  Graph: typeof CodeGraph,
  projectPath: string,
): Promise<CodeGraph> {
  const deadline = performance.now() + 2000;
  while (true) {
    let owner: CodeGraph | undefined;
    try {
      owner = await Graph.open(projectPath, { readOnly: true });
      if (!owner.isPortableStorage()) return owner;
      const pin = owner.acquirePortableRead();
      const facade = owner;
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try { pin.release(); } finally { facade.close(); }
      };
      return new Proxy(pin.graph, {
        get(target, key) {
          if (key === 'close' || key === 'destroy') return close;
          if (key === 'whenIdle') return () => facade.whenIdle();
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    } catch (error) {
      if (owner) { owner.close(); await owner.whenIdle(); }
      if (!(error instanceof PortableBusyError) || performance.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}
