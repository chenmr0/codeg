import { createIpcChannel } from './ipc.mjs';
/** Acceptance-only child processes. These roles are protocol adapters, not production CLI/MCP entrypoints. */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { Participant, beginOperation, publish, recover, paths, seal } from './protocol.mjs';

export function fixture(file, tag) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try { db.exec('PRAGMA synchronous=FULL; CREATE TABLE snapshot(id INTEGER PRIMARY KEY, first TEXT, second TEXT); CREATE TABLE writes(value TEXT)'); db.prepare('INSERT INTO snapshot VALUES(1,?,?)').run(tag, tag); }
  finally { db.close(); }
}
export function snapshot(db) { const row = db.prepare('SELECT first,second FROM snapshot WHERE id=1').get(); if (row.first !== row.second) throw new Error(`Mixed database: ${JSON.stringify(row)}`); return { first: row.first, second: row.second }; }
const [mode, project, encoded = '{}'] = process.argv.slice(2);
const config = JSON.parse(encoded);
const { send, close: closeIpc } = createIpcChannel();
function die() { process.kill(process.pid, 'SIGKILL'); }
if (mode === 'publisher') {
  const op = beginOperation(project);
  const started = performance.now();
  fixture(op.record.candidate, config.tag ?? 'B');
  if(config.dirtyBuildCrash){const dirty=new DatabaseSync(op.record.candidate);dirty.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO writes VALUES('partial-builder-write')");die();}
  if (config.crashAt === 'building') { if(config.trace) fs.appendFileSync(config.trace,JSON.stringify({phase:'building',at:performance.now(),operation:op.record.id})+'\n'); die(); }
  if (config.corruptCandidate) fs.writeFileSync(op.record.candidate, 'not a sqlite database');
  const hook = phase => {
    if (config.trace) fs.appendFileSync(config.trace, JSON.stringify({phase,at:performance.now(),operation:op.record.id})+'\n');
    send({event:'phase',phase});
    if (config.crashAt === phase) die();
    if (config.throwAt === phase) throw new Error(`Injected failure at ${phase}`);
    if (config.pauseAt === phase) {
      fs.writeFileSync(config.pausedFile, phase);
      const limit = performance.now() + 10000;
      while (!fs.existsSync(config.resumeFile)) { if (performance.now() > limit) throw new Error('Test pause timed out'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2); }
    }
    if (phase === 'resumed' && config.writeAfterResume) {
      const db = new DatabaseSync(op.p.active);
      try { db.exec('PRAGMA synchronous=FULL'); db.prepare('INSERT INTO writes VALUES(?)').run('confirmed-after-publish'); } finally { db.close(); }
      fs.writeFileSync(config.writeProof, 'confirmed-after-publish');
      if (config.crashAfterWrite) die();
    }
  };
  try {
    const result = await publish(op, { buildMs:performance.now()-started, fail:config.fail, drainBudgetMs:config.budget ?? 1000, hook,
      validate:config.failValidation ? () => { throw new Error('Injected index validation failure'); } : undefined,
      validateSource:config.failSource ? () => { throw new Error('Source changed before publication'); } : undefined });
    await send({event:'result',result}); await closeIpc();
  } catch (error) { process.exitCode=1; try { await send({event:'fatal',error:error.stack}); } finally { await closeIpc(); } }
} else if (mode === 'recover') {
  try { const value = recover(project,{hook:phase=>{send({event:'phase',phase});if(config.pauseAt===phase){fs.writeFileSync(config.pausedFile,phase);const limit=performance.now()+10000;while(!fs.existsSync(config.resumeFile)){if(performance.now()>limit)throw new Error('Recovery test pause timed out');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2);}}}}); await send({event:'result',result:value}); await closeIpc(); }
  catch (error) { process.exitCode=1; try { await send({event:'fatal',error:error.stack}); } finally { await closeIpc(); } }
} else if (mode === 'client') {
  if(config.startFile){send({event:'boot-waiting'});const deadline=performance.now()+10000;while(!fs.existsSync(config.startFile)){if(performance.now()>deadline)throw new Error('Bootstrap barrier timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1);}}
  let participant;
  try {
    participant = new Participant(project, file => { const db = new DatabaseSync(file); if(config.wal) db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL'); return db; }, {pollMs:config.pollMs??5});
    send({event:'ready',role:config.role??'SDK'});
  } catch(error) { process.exitCode=1; try { await send({event:'fatal',error:error.stack}); } finally { await closeIpc(); } }
  if (participant) {
    let loopPromise = null, looping = false, samples = [], tags = [], errors = [];
    process.on('message', async message => {
      const {id,command} = message;
      try {
        let value;
        if (command === 'query') value = await participant.request(db => snapshot(db));
        else if (command === 'querySync') value = participant.requestSync(db => snapshot(db));
        else if (command === 'hold') value = await participant.request(async db => {
          const before = snapshot(db); send({event:'held',id}); await delay(message.ms ?? 1500); const after = snapshot(db);
          return {before,after};
        });
        else if(command==='writeAndCrash') value=await participant.write(db=>{db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE');db.prepare('UPDATE snapshot SET first=?,second=? WHERE id=1').run('CONFIRMED-WRITE','CONFIRMED-WRITE');db.exec('COMMIT');fs.writeFileSync(message.proof,'CONFIRMED-WRITE');die();});
        else if(command==='holdWrite') value=await participant.write(async db=>{send({event:'writer-held',id});await delay(message.ms??400);db.prepare('UPDATE snapshot SET first=?,second=? WHERE id=1').run('ACTIVE-WRITER','ACTIVE-WRITER');return snapshot(db);});
        else if (command === 'write') value = await participant.write(db => { db.exec('BEGIN IMMEDIATE'); try { db.prepare('UPDATE snapshot SET first=?, second=? WHERE id=1').run(message.tag,message.tag); db.exec('COMMIT'); } catch(e) { db.exec('ROLLBACK'); throw e; } return snapshot(db); });
        else if (command === 'startLoop') {
          if(loopPromise) throw new Error('Loop already started'); looping=true; samples=[]; tags=[]; errors=[];
          loopPromise=(async()=>{while(looping){ const started=performance.now(); try { const result=await participant.request(db=>snapshot(db)); samples.push(performance.now()-started); tags.push(result.first); } catch(e){errors.push(e.stack);} await delay(message.intervalMs??2); }})(); value=true;
        } else if(command==='stopLoop') {looping=false; await loopPromise; loopPromise=null; value={samples,tags,errors,reopens:participant.reopens,backgroundError:participant.backgroundError?.message};}
        else if(command==='stats') value={reopens:participant.reopens,active:participant.active,backgroundError:participant.backgroundError?.message};
        else if(command==='close') {looping=false; await loopPromise; participant.close(); value=true;}
        else throw new Error(`Unknown command ${command}`);
        if(command==='close'){try{await send({id,value});}finally{await closeIpc();}}else await send({id,value});
      } catch(error) { try{await send({id,error:error.stack});}catch(transportError){process.exitCode=1;console.error(transportError);await closeIpc().catch(e=>console.error(e));} }
    });
  }
}
