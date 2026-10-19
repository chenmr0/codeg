import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cleanEnv, assertChecksum } from './self-contained-lib.mjs';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = path.dirname(app);
const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'bundle-manifest.json')));
assert.equal(`${process.platform}-${process.arch}`, manifest.target, 'Run verification on the target OS/architecture');
assert.equal(process.version, manifest.runtime.version, 'Use the bundled Node runtime');
// This file is written only after all target checks succeed; clear stale success.
const resultFile = path.join(bundle, 'target-validation.json');
fs.rmSync(resultFile, { force: true });
for (const item of manifest.files) assertChecksum(path.join(bundle, item.file), item.sha256);
const env = cleanEnv();
env.PATH = process.platform === 'win32'
  ? [path.join(process.env.SystemRoot || 'C:/Windows', 'System32'), process.env.SystemRoot || 'C:/Windows'].join(path.delimiter)
  : '/usr/bin:/bin';
const run = (args, options = {}) => {
  const result = spawnSync(process.execPath, ['--liftoff-only', ...args], {
    cwd: app, env, stdio: 'inherit', windowsHide: true, timeout: 180000, ...options,
  });
  if (result.error || result.status !== 0) throw new Error(`Verification failed: ${args[0]}: ${result.error?.message || result.status}`);
};
run(['-e', "const {DatabaseSync}=require('node:sqlite'); const d=new DatabaseSync(':memory:'); d.exec('CREATE VIRTUAL TABLE t USING fts5(body)'); d.close();"]);
run([path.join(app, 'dist/bin/codegraph.js'), '--version']);
run(['--input-type=module', '-e', "import {rgPath} from '@vscode/ripgrep'; import {spawnSync} from 'node:child_process'; const r=spawnSync(rgPath,['--version'],{stdio:'inherit'}); if(r.error||r.status!==0)process.exit(1);"]);
// Real differential validation creates target-specific helper stamps in this copy.
run([path.join(app, 'scripts/validate-rust-scan.mjs')]);
run([path.join(app, 'scripts/validate-rust-macros.mjs')]);
run([path.join(app, 'scripts/smoke-native-package.mjs'), '--installed', app, '--macros']);
// Verify the JSON-RPC tools/list surface without starting an indexing daemon.
run(['-e', "const {getStaticTools}=require('./dist/mcp/tools.js'); const t=getStaticTools(); if(!t.some(x=>x.name==='search')||!t.every(x=>x.annotations?.readOnlyHint===true))process.exit(1);"]);
fs.writeFileSync(resultFile, JSON.stringify({ target: manifest.target, sourceCommit: manifest.sourceCommit,
  runtime: process.version, kernel: os.release(), passed: true, time: new Date().toISOString() }, null, 2) + '\n');
console.log(`Self-contained verification passed: ${manifest.target}`);
