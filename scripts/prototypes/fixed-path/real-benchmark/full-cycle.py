#!/usr/bin/env python3
"""Bounded REAL OceanBase full-build cycles. Never reuses a candidate or edits protocol.
Only use a dedicated, previously created benchmark checkout. All outcomes are retained.
"""
import argparse, hashlib, json, os, pathlib, shutil, subprocess, sys, time, traceback

A='7e2de11a0e3c328dddaaaefedd6e911be36fb58d'
B='9bdfa9e22b618cc4ad0a724010b1bb9567629399'
A_HASH='d14e9edd9bcfe0e6718d4c20ec80778eb97c748277c749d490a230bdeee38dd9'
B_HASH='ea3e67daabd13368babe0ee77c99d401fea2348a8a91def514fe1eedbc6aa6b2'
ENTRY=pathlib.Path(__file__).resolve().parent
CODE=ENTRY.parents[3]

def sha(file):
    h=hashlib.sha256()
    with open(file,'rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''):h.update(block)
    return h.hexdigest()

def save(file,value):file.write_text(json.dumps(value,indent=2)+'\n')
def read(file):return json.loads(file.read_text())
def run(command, logfile, env):
    start=time.time()
    with open(logfile,'w') as log:result=subprocess.run([str(x) for x in command],stdout=log,stderr=subprocess.STDOUT,env=env)
    return {'command':[str(x) for x in command],'startedAt':start,'finishedAt':time.time(),'returncode':result.returncode}

def runtime_inventory(root):
    runtime=root/'.codegraph-wx/.runtime'
    return {str(p.relative_to(runtime)):{'size':p.stat().st_size,'sha256':sha(p)} for p in sorted(runtime.rglob('*')) if p.is_file()} if runtime.exists() else {}

def offline_ready(root):
    active=root/'.codegraph-wx/codegraph.db'
    for suffix in ('-wal','-shm','-journal'):
        if pathlib.Path(str(active)+suffix).exists():raise RuntimeError(f'Offline overwrite refused: SQLite sidecar {suffix} remains')
    files=[str(active),*[str(p) for p in (root/'.codegraph-wx/.runtime').rglob('*') if p.is_file()]]
    # This is supplementary evidence; only a dedicated fixture, awaited clients and
    # protocol lease checks authorize its offline overwrite, never PID absence alone.
    checked=subprocess.run(['fuser',*files],capture_output=True,text=True)
    if checked.returncode!=1 or checked.stdout.strip():raise RuntimeError(f'Offline overwrite refused: fuser outcome {checked.returncode}: {checked.stdout} {checked.stderr}')
    javascript="""const{DatabaseSync}=require('node:sqlite');const fs=require('node:fs');const path=require('node:path');const r=process.argv[1];const active=path.join(r,'.codegraph-wx/codegraph.db');const runtime=path.join(r,'.codegraph-wx/.runtime/fixed-path-prototype');let held=[];try{for(const n of ['publisher.sqlite','connections.sqlite','writers.sqlite']){const f=path.join(runtime,n);if(!fs.existsSync(f))continue;const d=new DatabaseSync(f);d.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');held.push(d);}const gate=path.join(runtime,'gate.sqlite');if(fs.existsSync(gate)){const d=new DatabaseSync(gate,{readOnly:true});try{const s=d.prepare('SELECT mode FROM state WHERE id=1').get();if(s.mode!=='idle')throw Error('State not idle');const rows=d.prepare('SELECT record FROM operations').all();for(const x of rows){const p=JSON.parse(x.record).phase;if(!['cleaned','aborted'].includes(p))throw Error('Unresolved operation '+p);}}finally{d.close();}}}finally{for(const d of held.reverse()){d.exec('ROLLBACK');d.close();}}"""
    subprocess.run(['node','--liftoff-only','-e',javascript,str(root)],check=True,capture_output=True)
    return {'fuserReturnCode':checked.returncode,'leaseCheck':'publisher/connections/writers EXCLUSIVE obtained; idle state; no unresolved operation'}

def overwrite(root,source,report):
    readiness=offline_ready(root);before=runtime_inventory(root);active=root/'.codegraph-wx/codegraph.db'
    old=sha(active);sourcehash=sha(source);start=time.time();shutil.copyfile(source,active)
    with open(active,'rb') as file:os.fsync(file.fileno())
    after=runtime_inventory(root)
    if before!=after:raise RuntimeError('Offline copy unexpectedly changed runtime')
    if sha(active)!=sourcehash:raise RuntimeError('Offline copy checksum mismatch')
    save(report,{'startedAt':start,'finishedAt':time.time(),'readiness':readiness,'oldSha256':old,'publicSha256':sourcehash,'sameIdentity':old==sourcehash,'runtimeBefore':before,'runtimeAfter':after,'runtimePreserved':True})

def tracked_clean(root):
    for args in (['diff','--quiet'],['diff','--cached','--quiet']):subprocess.run(['git','-C',str(root),*args],check=True)

def sources():
    dirs=[CODE/'src',ENTRY.parent]
    return {str(p.relative_to(CODE)):sha(p) for d in dirs for p in sorted(d.rglob('*')) if p.is_file() and p.suffix in ('.mjs','.ts','.py','.sh')}

def main():
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--public-a',required=True);p.add_argument('--public-b',required=True);p.add_argument('--evidence',required=True);p.add_argument('--frozen-commit',required=True);p.add_argument('--rounds',type=int,default=3);a=p.parse_args()
    if a.rounds!=3:raise RuntimeError('This preregistered experiment requires exactly three rounds, not rerun-until-green')
    root=pathlib.Path(a.root).resolve();pubA=pathlib.Path(a.public_a).resolve();pubB=pathlib.Path(a.public_b).resolve();ev=pathlib.Path(a.evidence).resolve()
    if ev.exists():raise RuntimeError('Evidence destination exists; refusing overwrite of earlier attempt')
    ev.mkdir(parents=True);tracked_clean(root)
    head=subprocess.check_output(['git','-C',str(CODE),'rev-parse','HEAD'],text=True).strip()
    if head!=a.frozen_commit:raise RuntimeError(f'Frozen code mismatch {head}')
    subprocess.run(['git','-C',str(CODE),'diff','--exit-code'],check=True)
    subprocess.run(['git','-C',str(CODE),'diff','--cached','--exit-code'],check=True)
    env=dict(os.environ,CODEGRAPH_ALL_LANGUAGES='1',CODEGRAPH_PARSE_WORKERS='2',CODEGRAPH_RESOLVE_WORKERS='2',CODEGRAPH_RUST_MACROS_WORKERS='2',CODEGRAPH_PARSE_TIMEOUT_MS='180000',CODEGRAPH_PROTOTYPE_READ_GATES='0',BENCHMARK_QUERY_INTERVAL_MS='500',BENCHMARK_IDLE_MS='30000')
    frozen=sources();save(ev/'predeclared-plan.json',{'schema':1,'frozenCommit':head,'roundCount':3,'root':str(root),'sourceA':A,'sourceB':B,'publicA':{'path':str(pubA),'sha256':sha(pubA)},'publicB':{'path':str(pubB),'sha256':sha(pubB)},'queryQps':10,'queryClients':5,'fullBuildEveryRound':True,'candidateReuse':False,'performanceGate':'Every measured successful query incl queue <=1000ms (conservative sufficient test; baseline subtraction reference only). No failed requests, backlog, mixed identity or missing nodes. Cutover pause <=1000ms.','retention':'Every attempt, request and failure retained; no replacement round. Stop only for safety/source/state or process failure preventing safe continuation.','environment':{k:v for k,v in env.items() if k.startswith(('CODEGRAPH_','BENCHMARK_'))},'platform':sys.platform,'node':subprocess.check_output(['node','--version'],text=True).strip(),'initialFreeBytes':shutil.disk_usage(root).free,'codeHashes':frozen})
    summaries=[]
    for i in range(1,4):
        r=ev/f'round-{i}';r.mkdir();summary={'round':i,'status':'running','steps':[],'startedAt':time.time()};save(r/'summary.json',summary)
        def measured(label,cmd):
            result=run(['python3',ENTRY/'measure.py',root,r/label,*cmd],r/f'{label}.launcher.log',env);summary['steps'].append({'label':label,**result});save(r/'summary.json',summary)
            if result['returncode']!=0:raise RuntimeError(f'{label} failed with {result["returncode"]}')
        try:
            if sources()!=frozen:raise RuntimeError('Frozen source changed')
            tracked_clean(root);subprocess.run(['git','-C',str(root),'checkout','--detach',A],check=True,capture_output=True)
            overwrite(root,pubA,r/'cover-public-a.json')
            measured('query-public-a',['node','--liftoff-only',ENTRY/'load-profile.mjs','load',root,r/'query-public-a.json','idle'])
            if read(r/'query-public-a.json')['observedHashes']!=[A_HASH]:raise RuntimeError('Public A queries not actually A')
            with open(root/'src/observer/ob_server.cpp','a') as file:file.write(f'\n// Fixed-path full-cycle round {i}: real one-file increment.\n')
            measured('small-sync',['node','--liftoff-only',ENTRY/'worker.mjs','sync',root,r/'small-sync.json'])
            small=read(r/'small-sync.json')
            if small['completeness']['status']!='complete' or small['result']['filesModified']!=1:raise RuntimeError('Small increment not complete or not exactly one modified file')
            subprocess.run(['git','-C',str(root),'restore','src/observer/ob_server.cpp'],check=True)
            subprocess.run(['git','-C',str(root),'checkout','--detach',B],check=True,capture_output=True)
            measured('idle-before-build',['node','--liftoff-only',ENTRY/'load-profile.mjs','load',root,r/'idle-before-build.json','idle'])
            measured('full-rebuild',['node','--liftoff-only',ENTRY/'load-profile.mjs','load',root,r/'full-rebuild.json','rebuild'])
            op=read(r/'full-rebuild.json.operation.json');load=read(r/'full-rebuild.json')
            published=[x for x in op.get('result',{}).get('outcomes',[]) if x.get('type')=='publish' and x.get('status')=='published']
            if op['completeness']['status']!='complete' or op['result']['status']!='verified-observation' or not published:raise RuntimeError('Full rebuild did not publish complete verified graph')
            if not all(B_HASH in hs for hs in load['perClientHashes']):raise RuntimeError('Not every query client read B')
            if any(x.get('cachedBuild') for x in published):raise RuntimeError('Candidate reuse forbidden')
            offline_ready(root)
            overwrite(root,pubB,r/'cover-public-b.json')
            measured('query-public-b',['node','--liftoff-only',ENTRY/'load-profile.mjs','load',root,r/'query-public-b.json','idle'])
            measured('sync-public-b',['node','--liftoff-only',ENTRY/'worker.mjs','sync',root,r/'sync-public-b.json'])
            finalsync=read(r/'sync-public-b.json');finalquery=read(r/'query-public-b.json')
            if finalsync['completeness']['status']!='complete' or not finalsync['result'].get('complete') or finalsync['result']['filesModified']!=0:raise RuntimeError('Public B continuation sync not complete/no-change')
            if finalquery['observedHashes']!=[B_HASH]:raise RuntimeError('Public B queries not actually B')
            checks={}
            for name in ['query-public-a','idle-before-build','full-rebuild','query-public-b']:
                d=read(r/f'{name}.json');checks[name]={'noErrors':not d['errors'] and not d['closeErrors'],'noBacklog':d['pendingScheduled']==0,'noMixedOrMissing':d['mixedHashReads']==0 and d['missingNodeReads']==0,'queryMaxMs':d['wholeLifetimeService']['maxMs'],'scheduledMaxMs':d['wholeLifetimeScheduled']['maxMs'],'under1000ms':d['wholeLifetimeService']['maxMs']<=1000 and d['wholeLifetimeScheduled']['maxMs']<=1000}
            pause=[x['metrics']['admissionPauseMs'] for x in published if 'metrics'in x]
            summary.update(status='completed',functionalPassed=all(c['noErrors'] and c['noBacklog'] and c['noMixedOrMissing'] for c in checks.values()),performancePassed=all(c['under1000ms'] for c in checks.values()) and bool(pause) and max(pause)<=1000,checks=checks,cutoverPauseMs=pause,buildWallMs=op['wallMs'])
        except Exception as e:
            summary.update(status='blocked',error=str(e),traceback=traceback.format_exc());save(r/'summary.json',summary);summaries.append(summary);break
        finally:
            summary['finishedAt']=time.time();save(r/'summary.json',summary)
        summaries.append(summary);save(ev/'summary.json',{'rounds':summaries,'allThreeCompleted':len(summaries)==3 and all(x['status']=='completed' for x in summaries)})
    final={'rounds':summaries,'allThreeCompleted':len(summaries)==3 and all(x['status']=='completed' for x in summaries),'allPassed':len(summaries)==3 and all(x.get('functionalPassed') and x.get('performancePassed') for x in summaries),'sourceHashesUnchanged':sources()==frozen,'finalFreeBytes':shutil.disk_usage(root).free}
    save(ev/'summary.json',final)
    return 0 if final['allPassed'] and final['sourceHashesUnchanged'] else 1
if __name__=='__main__':sys.exit(main())
