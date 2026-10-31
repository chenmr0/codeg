#!/usr/bin/env node
// Run only against an installed release package, never the checkout's dist.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const installed = fs.realpathSync(path.resolve(process.argv[2] ?? 'package-install/node_modules/@sdd/codegraph-wx'));
const evidence = path.resolve(process.argv[3] ?? 'artifacts/installed-layout');
fs.mkdirSync(evidence, {recursive:true});
const env = {...process.env, STRICT_SYMLINK_TESTS:'1', CODEGRAPH_ALL_LANGUAGES:'1', CODEGRAPH_PROTOTYPE_READ_GATES:'0', GATE_DIAGNOSTICS_DIR:path.join(evidence,'gate-diagnostics'), CODEGRAPH_LAYOUT_EVIDENCE:path.join(evidence,'layout-disk'), CODEGRAPH_LAYOUT_EVIDENCE_DIR:path.join(evidence,'mcp-disk'), CODEGRAPH_MIGRATION_RETRY_EVIDENCE:path.join(evidence,'migration-retry'), CODEGRAPH_LAYOUT_DEFAULT_EVIDENCE:path.join(evidence,'layout-default'), CODEGRAPH_DAEMON_STARTUP_EVIDENCE:path.join(evidence,'daemon-startup')};
for (const key of ['E2E_CASE','CODEGRAPH_NO_DAEMON','CODEGRAPH_NO_WATCH','CODEGRAPH_ADAPTIVE_SYNC']) delete env[key];
const tests = fs.readdirSync(path.join(installed,'scripts/tests')).filter(n=>/^fixed-(?:path|layout)-.*\.test\.cjs$/.test(n)).sort();
const required = ['daemon-startup-unit.test.cjs', 'daemon-startup-process.test.cjs', 'daemon-handshake-lifetime.test.cjs', 'runtime-paths.test.cjs'];
for (const file of required) {
  if (!fs.existsSync(path.join(installed,'scripts/tests',file))) throw Error('Missing required installed suite: '+file);
  tests.push(file);
}
if (!tests.length) throw Error('Installed package has no fixed-path acceptance tests');
let failures = 0;
for (const file of tests) {
  const result=spawnSync(process.execPath,['--liftoff-only','--test-reporter=tap',path.join(installed,'scripts/tests',file)],{cwd:installed,env,encoding:'utf8',timeout:600000,maxBuffer:64*1024*1024});
  const output=(result.stdout??'')+(result.stderr??'');
  fs.writeFileSync(path.join(evidence,file+'.tap'),output);
  const skipLines=output.split(/\r?\n/).filter(line=>/# SKIP(?: |$)/.test(line));
  const windowsRuntime=process.platform==='win32'&&file==='runtime-paths.test.cjs';
  const allowedSkipNames=[
    'Git exclusion reports unwritable metadata instead of pretending protection',
    'missing Git fails closed on unreadable ancestor discovery',
  ];
  const expectedSkip=windowsRuntime?2:0;
  const skipsValid=skipLines.length===expectedSkip&&(!windowsRuntime||allowedSkipNames.every(name=>skipLines.filter(line=>new RegExp('^ok [0-9]+ - '+name+' # SKIP requires POSIX permissions and non-root user$').test(line)).length===1));
  const strictSymlinkValid=!windowsRuntime||/^ok [0-9]+ - runtime marker file symlink fails closed \(requires actual file-symlink capability\)\r?$/m.test(output);
  const pass=!result.error&&result.status===0&&new RegExp('^# skipped '+expectedSkip+'\\r?$','m').test(output)&&/^# fail 0\r?$/m.test(output)&&skipsValid&&strictSymlinkValid;
  console.log(`${pass?'PASS':'FAIL'} ${file}`);
  if (!pass) { failures++; console.error(result.error??output); }
}
fs.writeFileSync(path.join(evidence,'summary.json'),JSON.stringify({platform:process.platform,arch:process.arch,node:process.version,installed,tests,failures},null,2));
if(failures) process.exitCode=1;
