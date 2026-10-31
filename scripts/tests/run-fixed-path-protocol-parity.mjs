/** Exercise the frozen prototype's regression matrix against emitted production
 * protocol, without editing the prototype or claiming those are production E2E. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const source = path.resolve('scripts/prototypes/fixed-path');
const target = fs.mkdtempSync(path.resolve('scripts/prototypes/fixed-path-parity-'));
try {
  fs.cpSync(source,target,{recursive:true});
  const exports = ['now','paths','checkpointCoordinator','initialize','gate','state','records','lease','sha','seal','cleanup','recover','beginOperation','publish','Participant'];
  fs.writeFileSync(path.join(target,'protocol.mjs'),`export { ${exports.join(',')} } from '../../../dist/sync/fixed-path/protocol.js';\n`);
  // The frozen prototype intentionally retained unrecorded bootstrap tasks.
  // Production now has durable allocation intents, so its old expectations of
  // permanent unadopted debris/fail-closed partial install are obsolete, not
  // regressions to suppress. Replace only those cases with the production
  // crash-at-every-stage + IOERR + unknown-artifact preservation matrix. Keep
  // the original bounded contention, WAL keeper and OS exclusion assertions.
  const preparation=fs.readFileSync(path.join(target,'bootstrap-prepare.test.mjs'),'utf8');
  const contention=preparation.slice(0,preparation.indexOf('for(const count'))
    .replaceAll("sql.includes('CREATE TABLE lease')","/CREATE TABLE (?:IF NOT EXISTS )?lease/.test(sql)")
    .replace("filter(n=>n.startsWith('bootstrap-'))","filter(n=>n.startsWith('bootstrap-')&&fs.lstatSync(path.join(paths(project).runtime,n)).isDirectory())");
  fs.writeFileSync(path.join(target,'bootstrap-prepare.test.mjs'),contention+"\nimport '../../tests/fixed-path-reclamation.test.cjs';\n");
  const leases=fs.readFileSync(path.join(target,'lease-bootstrap.test.mjs'),'utf8');
  fs.writeFileSync(path.join(target,'lease-bootstrap.test.mjs'),leases.slice(0,leases.indexOf('for(const target'))+leases.slice(leases.indexOf("test('lease probes")));
  const keeper=path.join(target,'bootstrap-keeper.test.mjs');
  fs.writeFileSync(keeper,fs.readFileSync(keeper,'utf8').replaceAll("sql.includes('CREATE TABLE lease')","/CREATE TABLE (?:IF NOT EXISTS )?lease/.test(sql)"));
  console.log('Production bootstrap parity: obsolete private-allocation cases replaced by durable-intent real-kill/IOERR matrix; budgets and OS exclusion unchanged.');
  const tests = fs.readdirSync(target).filter(file=>file.endsWith('.test.mjs')).sort().map(file=>path.join(target,file));
  const code = await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--liftoff-only','--test','--test-concurrency=1',...tests],{stdio:'inherit',env:{...process.env,FIXED_PATH_EVIDENCE_DIR:path.resolve('artifacts/fixed-path-production-parity')}});
    child.once('error',reject);child.once('close',resolve);
  });
  process.exitCode = code ?? 1;
} finally { fs.rmSync(target,{recursive:true,force:true}); }
