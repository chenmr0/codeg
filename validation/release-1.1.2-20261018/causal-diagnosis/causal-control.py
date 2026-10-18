import pathlib,shutil,sqlite3,json,subprocess,time,os,hashlib,re
E=pathlib.Path('/workspace/codegraph-evidence');S=E/'rocksdb-full/r1-baseline';D=E/'causal-control';D.mkdir(exist_ok=True);root=D/'project'
assert not root.exists();shutil.copytree(S,root,ignore=shutil.ignore_patterns('.git','.codegraph-wx'))
# SQLite backup creates a coherent read-only-source snapshot; original evidence is untouched.
template=D/'template.db';a=sqlite3.connect('file:'+str(S/'.codegraph-wx/codegraph.db')+'?mode=ro',uri=True);b=sqlite3.connect(template);a.backup(b);b.close();a.close()
base=(root/'util/crc32c.cc').read_bytes();assert b'codegraph_release_probe' in base
edit=base+b'\nint codegraph_causal_control_probe() { return 112; }\n';(root/'util/crc32c.cc').write_bytes(edit)
env=dict(os.environ,**json.loads((E/'rocksdb-guarded-native/configuration.json').read_text())['environment'])
rows=[];digest=hashlib.sha256(template.read_bytes()).hexdigest()
for label in ['A1','B1','B2','A2']:
 state=root/'.codegraph-wx'
 if state.exists():shutil.rmtree(state)
 state.mkdir();shutil.copy2(template,state/'codegraph.db');assert hashlib.sha256((state/'codegraph.db').read_bytes()).hexdigest()==digest
 before=pathlib.Path('/sys/fs/cgroup/cpu.stat').read_text();start=time.perf_counter()
 with (D/(label+'.log')).open('w')as f:p=subprocess.run(['node','--liftoff-only','/workspace/codegraph-baseline-30d/dist/bin/codegraph.js','sync',str(root),'--verbose'],env=env,stdout=f,stderr=subprocess.STDOUT,timeout=120)
 wall=time.perf_counter()-start;log=(D/(label+'.log')).read_text();counts=re.findall(r'\[sync\] reconcile-counts[^\n]*',log);assert p.returncode==0 and len(counts)==1 and 'modified=1 removed=0'in counts[0],counts
 row={'label':label,'implementation':'30d for both A and B','wallSeconds':wall,'inputDatabaseSha256':digest,'inputSourceSha256':hashlib.sha256(edit).hexdigest(),'reconcile':counts[0],'cpuStatBefore':before,'cpuStatAfter':pathlib.Path('/sys/fs/cgroup/cpu.stat').read_text()};rows.append(row);(D/'results.json').write_text(json.dumps(rows,indent=2));print(label,wall,flush=True)
print('bounded identical-30d control complete',flush=True)
