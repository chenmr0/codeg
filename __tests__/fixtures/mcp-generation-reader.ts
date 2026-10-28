/** Separate real MCP/SQLite reader process for generation lifecycle tests. */
import * as readline from 'readline';
import CodeGraph from '../../src/index';
import { ToolHandler } from '../../src/mcp/tools';
import { MCPEngine } from '../../src/mcp/engine';

const graph = CodeGraph.openSync(process.argv[process.argv.length - 1]!);
const handler = new ToolHandler(graph);
const engine = new MCPEngine({ watch: false });
(engine as any).cg = graph;
(engine as any).toolHandler = handler;
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const original = (handler as any).handleSearch.bind(handler);
let resume: (() => void) | undefined;
(handler as any).handleSearch = async (args: Record<string, unknown>) => {
  const reader = (handler as any).getCodeGraph();
  if (args.pause) {
    send({ event: 'admitted', file: reader.getDatabaseFilePath() });
    await new Promise<void>(resolve => { resume = resolve; });
  }
  return original(args);
};
readline.createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line);
  if (command.action === 'release') { resume?.(); return; }
  if (command.action === 'stop') { engine.stop(); send({ event: 'stopped' }); return; }
  if (command.action === 'exit') { engine.stop(); process.exit(0); }
  void handler.execute('search', command.args).then(result => send({ event: command.id, result }));
});
send({ event: 'ready' });
