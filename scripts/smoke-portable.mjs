#!/usr/bin/env node
// Real archive acceptance: private runtime, installation and small C fixture.
// The driver uses Node on the test host; child PATH has NO Node/npm/compiler.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) throw new Error('Usage: node scripts/smoke-portable.mjs ARCHIVE.tar.gz');
const archive = path.resolve(process.argv[2]);
const hash = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-portable-smoke-'));
const env = { ...process.env, HOME: path.join(work, 'home'), CODEGRAPH_INSTALL_DIR: path.join(work, 'install with spaces'), CODEGRAPH_BIN_DIR: path.join(work, 'bin with spaces') };
for (const key of Object.keys(env)) if (/^(NODE_OPTIONS|NODE_PATH|npm_config_arch|CODEGRAPH_(RUST|PACK|DIR|ALL|FORCE))/.test(key)) delete env[key];
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: work, env, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command}: ${result.error?.message ?? result.status}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
try {
  fs.mkdirSync(env.HOME);
  const toolDir = path.join(work, 'tools'); fs.mkdirSync(toolDir);
  for (const tool of ['sh', 'uname', 'tar', 'sha256sum', 'mktemp', 'awk', 'grep', 'sed', 'readlink', 'mv', 'ln', 'rm', 'mkdir', 'cat', 'dirname', 'gzip', 'git']) {
    const location = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (!location) throw new Error(`Test host utility missing: ${tool}`);
    fs.symlinkSync(location, path.join(toolDir, tool));
  }
  env.PATH = toolDir;
  for (const command of ['node', 'npm', 'cargo', 'rustc', 'cc', 'gcc']) {
    assert.equal(spawnSync(command, ['--version'], { env }).error?.code, 'ENOENT', `${command} leaked into child PATH`);
  }
  console.log(run('/bin/sh', [path.join(root, 'scripts/install-portable.sh'), '--archive', archive, '--sha256', hash]));
  const cli = path.join(env.CODEGRAPH_BIN_DIR, 'codegraph');
  const installed = fs.realpathSync(path.join(env.CODEGRAPH_INSTALL_DIR, 'current'));
  const node = path.join(installed, 'node');
  const app = path.join(installed, 'lib');
  console.log('Private runtime:', run(node, ['--version']).trim());
  console.log(run(cli, ['--version']));
  const stableCommand = path.join(env.CODEGRAPH_INSTALL_DIR, 'current/bin/codegraph');
  for (const target of ['codeagent', 'claude', 'gemini', 'opencode']) {
    const config = run(cli, ['install', '--print-config', target]);
    assert.ok(config.includes(stableCommand), `${target} must use stable bundled launcher without PATH`);
  }
  const setup = run(cli, ['install', '--target', 'codeagent', '--location', 'global', '--no-permissions']);
  assert.match(setup, /Using the bundled CodeGraph runtime/);
  const agentConfig = JSON.parse(fs.readFileSync(path.join(env.HOME, '.cac.json'), 'utf8'));
  assert.equal(agentConfig.mcpServers.codegraph.command, stableCommand);
  assert.deepEqual(agentConfig.mcpServers.codegraph.args, ['serve', '--mcp']);
  console.log(run(node, ['--liftoff-only', path.join(app, 'scripts/validate-rust-scan.mjs')]));
  console.log(run(node, ['--liftoff-only', path.join(app, 'scripts/validate-rust-macros.mjs')]));
  const project = path.join(work, 'project with spaces'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'main.c'), 'int portable_target(void) { return 7; }\nint portable_caller(void) { return portable_target(); }\n');
  console.log(run(cli, ['init', project]));
  const indexed = run(node, ['--liftoff-only', '-e', `
    const assert=require('node:assert/strict'),path=require('node:path');
    const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');
    db.exec('CREATE VIRTUAL TABLE probe USING fts5(body)');db.close();
    const CodeGraph=require(path.join(process.argv[1],'dist/index.js')).default;
    const cg=CodeGraph.openSync(process.argv[2]);try {
      const target=cg.getNodesByName('portable_target')[0];
      const caller=cg.getNodesByName('portable_caller')[0];assert.ok(target&&caller);
      assert.ok(cg.getOutgoingEdges(caller.id).some(edge=>edge.kind==='calls'&&edge.target===target.id));
    }finally{cg.close();}
    console.log('SQLite FTS5, WASM parsing and indexed calls passed');
  `, app, project]);
  console.log(indexed);
  console.log(run(cli, ['sync', project]));
  fs.writeFileSync(path.join(project, 'added.c'), 'int portable_added;\n');
  console.log(run(cli, ['sync', project]));
  const rg = path.join(app, 'node_modules/@vscode/ripgrep-linux-x64/bin/rg');
  assert.match(run(rg, ['portable_added', path.join(project, 'added.c')]), /portable_added/);
  const current = fs.readlinkSync(path.join(env.CODEGRAPH_INSTALL_DIR, 'current'));
  console.log(run('/bin/sh', [path.join(root, 'scripts/install-portable.sh'), '--archive', archive, '--sha256', hash]));
  assert.equal(fs.readlinkSync(path.join(env.CODEGRAPH_INSTALL_DIR, 'current')), current);
  console.log('PASS: real archive installs/reinstalls and runs with no Node/npm/compiler in PATH.');
  console.log(`Test host ${os.platform()} ${os.arch()}, kernel ${os.release()}; this does not certify another OS.`);
} finally { fs.rmSync(work, { recursive: true, force: true }); }
