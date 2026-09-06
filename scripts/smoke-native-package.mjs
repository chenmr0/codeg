#!/usr/bin/env node
// Install a local tgz in an isolated prefix, then run with compiler paths removed.
// --installed <package-dir> tests an existing installation without installing anything.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-native-npm-smoke-'));
const env = { ...process.env };
env.PATH = [path.dirname(process.execPath), ...(process.platform === 'win32'
  ? [path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32'), process.env.SystemRoot ?? 'C:/Windows']
  : ['/usr/bin', '/bin'])].join(path.delimiter);
for (const key of ['CODEGRAPH_RUST_SCAN', 'CODEGRAPH_RUST_SCAN_PATH', 'CODEGRAPH_DIR', 'CODEGRAPH_HYBRID_SCAN',
  'CODEGRAPH_RUST_MACROS', 'CODEGRAPH_RUST_MACROS_PATH', 'CODEGRAPH_RUST_MACROS_WORKERS', 'CODEGRAPH_RUST_MACROS_TIMEOUT_MS',
  'CODEGRAPH_PACK_ALLOW_INCOMPLETE', 'CODEGRAPH_CARGO', 'CODEGRAPH_RUSTC', 'CARGO_HOME', 'RUSTUP_HOME']) delete env[key];
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: work, env, encoding: 'utf8', windowsHide: true,
    timeout: 120000, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? ''}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  return result.stdout ?? '';
};
try {
  for (const tool of ['cargo', 'rustc']) {
    const found = spawnSync(tool, ['--version'], { env, encoding: 'utf8', windowsHide: true });
    assert.equal(found.error?.code, 'ENOENT', `Smoke PATH must not contain ${tool}`);
  }
  let installed;
  if (process.argv[2] === '--installed' && process.argv[3]) installed = path.resolve(process.argv[3]);
  else {
    if (!process.argv[2]) throw new Error('Usage: smoke-native-package.mjs <archive.tgz> | --installed <package-dir>');
    const archive = path.resolve(process.argv[2]);
    if (!fs.statSync(archive).isFile()) throw new Error('Local npm archive required');
    const npmCli = process.env.npm_execpath;
    if (!npmCli || !fs.existsSync(npmCli)) throw new Error('Run through npm run smoke:native-package so npm CLI is explicit');
    const prefix = path.join(work, 'install');
    console.log(run(process.execPath, [npmCli, 'install', '--prefix', prefix, '--no-audit', '--no-fund', archive]));
    installed = path.join(prefix, 'node_modules/@sdd/codegraph-wx');
  }
  const project = path.join(work, 'project'); fs.mkdirSync(project);
  const program = `
    const fs=require('fs'),path=require('path'),assert=require('assert/strict');
    const installed=process.argv[1],project=process.argv[2];
    const CodeGraph=require(path.join(installed,'dist/index.js')).default;
    fs.mkdirSync(path.join(project,'src'));
    fs.writeFileSync(path.join(project,'.codegraphignore'),'/*\\n!/src/\\n');
    fs.writeFileSync(path.join(project,'src/a.c'),'int original_value;\\n');
    (async()=>{const cg=CodeGraph.initSync(project);try{
      await cg.indexAll();
      const lines=[],log=console.log;console.log=(...a)=>lines.push(a.join(' '));
      try {
        const noop=await cg.sync({verbose:true});assert.equal(noop.filesModified,0);
        fs.writeFileSync(path.join(project,'src/a.c'),'int changed_value;\\n');
        fs.writeFileSync(path.join(project,'src/b.c'),'int added_value;\\n');
        const changed=await cg.sync({verbose:true});assert.equal(changed.filesModified,1);assert.equal(changed.filesAdded,1);
        assert.equal(cg.getNodesByName('changed_value').length,1);assert.equal(cg.getNodesByName('added_value').length,1);
        fs.unlinkSync(path.join(project,'src/b.c'));
        const removed=await cg.sync({verbose:true});assert.equal(removed.filesRemoved,1);
        assert.equal(cg.getNodesByName('added_value').length,0);
        const scans=lines.filter(x=>x.includes('scan-detail'));
        assert.equal(scans.length,3);for(const line of scans)assert.match(line,/nativeStatus=used/);
      }finally{console.log=log;}
    }finally{cg.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
  `;
  console.log(run(process.execPath, ['--liftoff-only', '-e', program, installed, project]));
  const cli = path.join(installed, 'dist/bin/codegraph.js');
  const output = run(process.execPath, ['--liftoff-only', cli, 'sync', project, '-v']);
  assert.match(output, /nativeStatus=used/); assert.match(output, /Already up to date/);
  console.log('[rust-scan] Installed npm package PASS: no Rust/Cargo, no enable switch, add/modify/remove/no-op and CLI verified.');
  if (process.argv.includes('--macros')) {
    const macroProgram = `
      const fs=require('fs'),path=require('path'),assert=require('assert/strict');
      const installed=process.argv[1],project=process.argv[2];
      const {buildMacroContext}=require(path.join(installed,'dist/extraction/macro-scan.js'));
      fs.writeFileSync(path.join(project,'src/defs.h'),'#define DECL(name) int name;\\n#define EMPTY /*中文*/\\n');
      (async()=>{
        process.env.CODEGRAPH_RUST_MACROS='0';const baseline=await buildMacroContext(project,['src/defs.h']);
        for(const mode of ['1','verify']) {
          process.env.CODEGRAPH_RUST_MACROS=mode;const actual=await buildMacroContext(project,['src/defs.h']);
          assert.equal(actual.metrics.mode,mode==='1'?'rust':'verify');
          assert.deepEqual(actual.definitions,baseline.definitions);assert.deepEqual([...actual.names],['DECL','EMPTY']);
          assert.deepEqual([...actual.bodyless],['EMPTY']);
        }
      })().catch(e=>{console.error(e);process.exitCode=1;});
    `;
    console.log(run(process.execPath, ['-e', macroProgram, installed, project]));
    console.log('[rust-macros] Installed opt-in prototype PASS: no Rust/Cargo, native and verify modes match TS.');
  }
} finally {
  assert.ok(path.basename(work).startsWith('cg-native-npm-smoke-'));
  assert.equal(path.dirname(fs.realpathSync(work)), fs.realpathSync(os.tmpdir()));
  fs.rmSync(work, { recursive: true, force: true });
}
