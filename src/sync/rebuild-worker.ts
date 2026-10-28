/** Isolated builder. It can write only an unpublished candidate and never CURRENT. */
import { CodeGraph } from '../index';
import { writeFileSync } from 'fs';
import * as path from 'path';

async function main(): Promise<void> {
  const [root, databasePath] = process.argv.slice(2);
  if (!root || !databasePath || !process.send) throw new Error('Rebuild worker requires an IPC parent');
  // If the parent disappears, its root lock remains as a fail-closed barrier.
  const parentDisconnected = (): void => process.exit(1);
  process.on('disconnect', parentDisconnected);
  const graph = await CodeGraph.createShadow(root, databasePath);
  let result;
  try {
    result = await graph.indexAll({ onProgress: progress => {
      if (process.connected) process.send?.({ type: 'progress', progress });
    } });
  } finally { graph.close(); }
  writeFileSync(path.join(path.dirname(databasePath), 'build-result.json'), JSON.stringify(result));
  await new Promise<void>((resolve, reject) => {
    process.send?.({ type: 'result', result }, error => error ? reject(error) : resolve());
  });
  process.removeListener('disconnect', parentDisconnected);
  process.disconnect();
}
void main().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
  if (process.connected) process.disconnect();
});
