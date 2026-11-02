import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export function captureGraph(cg: any) {
  const output = process.env.CODEGRAPH_PARITY_CAPTURE;
  if (!output) return;
  const files = cg.getFiles();
  const sources = files.map((f: any) => ({ path: f.path, content: fs.readFileSync(path.join(cg.getProjectRoot(), f.path), 'utf8') }));
  const key = hash(JSON.stringify(sources));
  const nodes = files.flatMap((f: any) => cg.getNodesInFile(f.path));
  const edges = nodes.flatMap((n: any) => cg.getOutgoingEdges(n.id));
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, key + '.json'), JSON.stringify({ key, root: cg.getProjectRoot(), files, sources, nodes, edges }));
}
export function captureResult(cg: any, args: any, result: any) {
  const output = process.env.CODEGRAPH_PARITY_CAPTURE;
  if (!output || !cg) return;
  const dir = path.join(output, 'results'); fs.mkdirSync(dir, { recursive: true });
  const diag = process.env.CODEGRAPH_EXPLORE_DEBUG;
  const diagnostics = diag && fs.existsSync(diag) && fs.statSync(diag).isFile() ? fs.readFileSync(diag, 'utf8').trim().split('\n').map(x => JSON.parse(x)).at(-1) : undefined;
  fs.writeFileSync(path.join(dir, hash(cg.getProjectRoot()+JSON.stringify(args)) + '.json'), JSON.stringify({root:cg.getProjectRoot(), args,result,diagnostics}));
}
