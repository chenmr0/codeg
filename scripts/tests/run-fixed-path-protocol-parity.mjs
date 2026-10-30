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
  const tests = fs.readdirSync(target).filter(file=>file.endsWith('.test.mjs')).sort().map(file=>path.join(target,file));
  const code = await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--liftoff-only','--test','--test-concurrency=1',...tests],{stdio:'inherit',env:{...process.env,FIXED_PATH_EVIDENCE_DIR:path.resolve('artifacts/fixed-path-production-parity')}});
    child.once('error',reject);child.once('close',resolve);
  });
  process.exitCode = code ?? 1;
} finally { fs.rmSync(target,{recursive:true,force:true}); }
