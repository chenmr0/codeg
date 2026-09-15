#!/usr/bin/env node
/** Directly time CodeGraph's bundled rg, without MCP or a scan deadline.
 * node benchmark-bundled-ripgrep.mjs --project /repo
 *   [--codegraph-entry /path/to/codegraph] [--query SYMBOL] [--glob '*.cpp']
 * Repeat --query/--glob as needed. Default scope is common C/C++ extensions;
 * it is not an assertion about the index's exact file coverage.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const defaultQueries = ['TIFM_X2itfSonNeedProbeMsg', 'TIFM_X2itfIsMixedAddr', 'TIFM_X2itfSonFillProbeXnTnlCfgInfo'];
const defaultGlobs = ['*.c', '*.h', '*.cc', '*.hh', '*.cpp', '*.hpp', '*.cxx', '*.hxx', '*.inl', '*.ipp', '*.inc', '*.C', '*.H'];

async function main() {
  const options = { queries: [], globs: [] };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help') {
      console.log('Usage: node benchmark-bundled-ripgrep.mjs --project ROOT [--codegraph-entry CLI_FILE] [--query SYMBOL ...] [--glob GLOB ...] [--out DIR]');
      return;
    }
    if (!['--project', '--codegraph-entry', '--query', '--glob', '--out'].includes(flag)) throw new Error(`Unknown argument: ${flag}`);
    const value = args[++i];
    if (!value?.trim() || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (flag === '--query') options.queries.push(value);
    else if (flag === '--glob') options.globs.push(value);
    else options[flag.slice(2)] = value;
  }
  if (!options.project) throw new Error('--project is required');
  const project = fs.realpathSync(options.project);
  if (!fs.statSync(project).isDirectory()) throw new Error('--project must be a directory');
  const anchor = options['codegraph-entry']
    ? fs.realpathSync(options['codegraph-entry'])
    : fileURLToPath(import.meta.url);
  const requireFromCodeGraph = createRequire(anchor);
  const rgModule = await import(pathToFileURL(requireFromCodeGraph.resolve('@vscode/ripgrep')).href);
  const executable = rgModule.rgPath ?? rgModule.default?.rgPath;
  if (!executable) throw new Error('The installed @vscode/ripgrep did not export rgPath');
  const queries = options.queries.length ? options.queries : defaultQueries;
  const globs = options.globs.length ? options.globs : defaultGlobs;
  const out = options.out ? path.resolve(options.out) : fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-rg-bench-'));
  fs.mkdirSync(out, { recursive: true });
  for (const name of ['results.json', 'files.bin', 'search.jsonl', 'inventory.stderr.log', 'search.stderr.log']) {
    if (fs.existsSync(path.join(out, name))) throw new Error(`Refusing to overwrite ${path.join(out, name)}; choose a new --out directory`);
  }
  const metadata = {
    project, anchor, executable, node: process.version,
    version: execFileSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true }).trim(),
    queries, globs, timeout: null,
    scope: 'C/C++ globs (or explicit --glob values), with normal rg ignore rules and --hidden; no index filtering or Node supplement.',
    ripgrepConfigPath: process.env.RIPGREP_CONFIG_PATH ?? null,
  };
  const results = [];
  const common = ['--hidden', '--no-messages', ...globs.flatMap(glob => ['--glob', glob])];
  console.log(JSON.stringify({ metadata, out }, null, 2));

  async function run(stage, argv) {
    const stdout = path.join(out, stage === 'inventory' ? 'files.bin' : 'search.jsonl');
    const stderr = path.join(out, `${stage}.stderr.log`);
    const stdoutFd = fs.openSync(stdout, 'wx');
    let stderrFd;
    const start = performance.now();
    console.log(`Starting ${stage}; no timeout. Output: ${stdout}`);
    let exit;
    try {
      stderrFd = fs.openSync(stderr, 'wx');
      exit = await new Promise((resolve, reject) => {
        const child = spawn(executable, argv, { cwd: project, windowsHide: true, stdio: ['ignore', stdoutFd, stderrFd] });
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
    } finally {
      fs.closeSync(stdoutFd);
      if (stderrFd !== undefined) fs.closeSync(stderrFd);
    }
    const result = { stage, ms: performance.now() - start, ...exit, args: argv, stdout, stderr };
    results.push(result);
    console.log(JSON.stringify(result));
    // rg 1 means a completed search with no matches, not a timeout or error.
    if (exit.signal || (exit.code !== 0 && exit.code !== 1)) throw new Error(`${stage} failed; inspect ${stderr}`);
    return result;
  }

  try {
    const inventory = await run('inventory', ['--files', '--null', ...common, '--', '.']);
    inventory.listedFiles = fs.readFileSync(inventory.stdout).reduce((count, byte) => count + Number(byte === 0), 0);
    const search = await run('search', [
      '--json', '--stats', '--fixed-strings', '--case-sensitive', '--text', ...common,
      ...queries.flatMap(query => ['--regexp', query]), '--', '.',
    ]);
    // Only read the tail: a query can produce arbitrarily many matching lines.
    const fd = fs.openSync(search.stdout, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const tail = Buffer.alloc(Math.min(size, 65536));
      fs.readSync(fd, tail, 0, tail.length, size - tail.length);
      for (const line of tail.toString('utf8').trim().split('\n').reverse()) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'summary') { search.summary = event.data; break; }
        } catch { /* tail may begin in the middle of a line */ }
      }
    } finally { fs.closeSync(fd); }
    console.log(JSON.stringify({ listedFiles: inventory.listedFiles, summary: search.summary }, null, 2));
    if (!search.summary) throw new Error('rg did not emit a final summary; do not treat this run as a proven complete scan');
  } finally {
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ metadata, results }, null, 2));
    console.log(`Saved ${path.join(out, 'results.json')}`);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
