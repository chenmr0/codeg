#!/usr/bin/env node
// Run only against an installed release package, never the checkout's dist.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const installed = fs.realpathSync(path.resolve(process.argv[2] ?? 'package-install/node_modules/@sdd/codegraph-wx'));
const evidence = path.resolve(process.argv[3] ?? 'artifacts/installed-layout');
fs.mkdirSync(evidence, {recursive:true});
const env = {...process.env, STRICT_SYMLINK_TESTS:'1', CODEGRAPH_ALL_LANGUAGES:'1', CODEGRAPH_PROTOTYPE_READ_GATES:'0', GATE_DIAGNOSTICS_DIR:path.join(evidence,'gate-diagnostics'), CODEGRAPH_LAYOUT_EVIDENCE:path.join(evidence,'layout-disk'), CODEGRAPH_LAYOUT_EVIDENCE_DIR:path.join(evidence,'mcp-disk'), CODEGRAPH_MIGRATION_RETRY_EVIDENCE:path.join(evidence,'migration-retry')};
for (const key of ['E2E_CASE','CODEGRAPH_NO_DAEMON','CODEGRAPH_NO_WATCH','CODEGRAPH_ADAPTIVE_SYNC']) delete env[key];
const tests = fs.readdirSync(path.join(installed,'scripts/tests')).filter(n=>/^fixed-(?:path|layout)-.*\.test\.cjs$/.test(n)).sort();
if (!tests.length) throw Error('Installed package has no fixed-path acceptance tests');
let failures = 0;
for (const file of tests) {
  const result=spawnSync(process.execPath,['--liftoff-only','--test-reporter=tap',path.join(installed,'scripts/tests',file)],{cwd:installed,env,encoding:'utf8',timeout:600000,maxBuffer:64*1024*1024});
  const output=(result.stdout??'')+(result.stderr??'');
  fs.writeFileSync(path.join(evidence,file+'.tap'),output);
  const pass=!result.error&&result.status===0&&/^# skipped 0\r?$/m.test(output)&&!/# SKIP(?: |\r?$)/m.test(output);
  console.log(`${pass?'PASS':'FAIL'} ${file}`);
  if (!pass) { failures++; console.error(result.error??output); }
}
fs.writeFileSync(path.join(evidence,'summary.json'),JSON.stringify({platform:process.platform,arch:process.arch,node:process.version,installed,tests,failures},null,2));
if(failures) process.exitCode=1;
