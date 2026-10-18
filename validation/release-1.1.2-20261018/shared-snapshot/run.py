import pathlib,shutil,sqlite3,json,subprocess,time,os,hashlib,re,resource
E=pathlib.Path('/workspace/codegraph-evidence');D=E/'shared-snapshot';S=E/'rocksdb-full/r1-baseline';root=D/'project';assert not root.exists()
CLI={'baseline':'/workspace/codegraph-baseline-30d/dist/bin/codegraph.js','fixed':'/workspace/codegraph-regression-fixes/dist/bin/codegraph.js'}
env=dict(os.environ,**json.loads((E/'rocksdb-guarded-native/configuration.json').read_text())['environment']);h=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
shutil.copytree(S,root,ignore=shutil.ignore_patterns('.git','.codegraph-wx'));state=root/'.codegraph-wx';state.mkdir()
a=sqlite3.connect('file:'+str(S/'.codegraph-wx/codegraph.db')+'?mode=ro',uri=True);b=sqlite3.connect(state/'codegraph.db');a.backup(b);b.close();a.close()
# Recover an unedited healthy base through the supported CLI, never by editing DB rows.
source=(E/'rocksdb/util/crc32c.cc').read_bytes();(root/'util/crc32c.cc').write_bytes(source)
with (D/'prepare-base.log').open('w')as f:p=subprocess.run(['node','--liftoff-only',CLI['baseline'],'sync',str(root),'--verbose'],env=env,stdout=f,stderr=subprocess.STDOUT,timeout=120)
assert p.returncode==0
con=sqlite3.connect(state/'codegraph.db');assert con.execute('pragma integrity_check').fetchone()[0]=='ok';assert con.execute("select count(*)from nodes where name='codegraph_release_probe'").fetchone()[0]==0;assert con.execute('select count(*)from nodes').fetchone()[0]==107724
metadata=con.execute('select * from project_metadata order by key').fetchall();assert next(r[1]for r in metadata if r[0]=='indexed_with_extraction_version')=='36';assert next(r[1]for r in metadata if r[0]=='index_completeness')=='complete'
template=D/'template.db';dest=sqlite3.connect(template);con.backup(dest);dest.close();con.close();digest=h(template)
manifest={'templateSha256':digest,'templateBytes':template.stat().st_size,'metadata':metadata,'sourceBeforeSha256':hashlib.sha256(source).hexdigest(),'sourceOrigin':str(S),'preparation':'read-only backup of existing 30d edited DB, restore original source then normal baseline sync, SQLite backup after CLI closed','order':['AB','BA','AB'],'environment':{k:v for k,v in env.items()if k.startswith('CODEGRAPH_')or k=='NODE_OPTIONS'},'instrumentationSha256':h(D/'profile.cjs')};(D/'manifest.json').write_text(json.dumps(manifest,indent=2))
edit=source+b'\nnamespace ROCKSDB_NAMESPACE::crc32c {\nuint32_t codegraph_release_probe() { return Value("abc", 3); }\n}\n';assert len(edit)-len(source)==104
rows=[]
def snapshot(label):
 db=sqlite3.connect(state/'codegraph.db');assert db.execute('pragma integrity_check').fetchone()[0]=='ok';out={}
 for table,omit in [('nodes',{'updated_at'}),('edges',{'id'})]:
  cols=[r[1]for r in db.execute('pragma table_info('+table+')')if r[1]not in omit];sha=hashlib.sha256();count=0
  for row in db.execute('select '+','.join(cols)+' from '+table+' order by '+','.join(cols)):
   sha.update((json.dumps(row,ensure_ascii=False,separators=(',',':'))+'\n').encode());count+=1
  out[table]={'rows':count,'sha256':sha.hexdigest()}
 out['metadata']=db.execute('select *from project_metadata order by key').fetchall();db.close();return out
for i,order in enumerate([['baseline','fixed'],['fixed','baseline'],['baseline','fixed']],1):
 for v in order:
  label=f'r{i}-{v}';shutil.rmtree(state);state.mkdir();shutil.copy2(template,state/'codegraph.db');assert h(state/'codegraph.db')==digest
  (root/'util/crc32c.cc').write_bytes(edit);local=dict(env,CODEGRAPH_DIAGNOSTIC_OUTPUT=str(D/(label+'-profile')))
  before=resource.getrusage(resource.RUSAGE_CHILDREN);start=time.perf_counter()
  with (D/(label+'.log')).open('w')as f:p=subprocess.run(['node','--liftoff-only','--require',str(D/'profile.cjs'),CLI[v],'sync',str(root),'--verbose'],env=local,stdout=f,stderr=subprocess.STDOUT,timeout=120)
  wall=time.perf_counter()-start;after=resource.getrusage(resource.RUSAGE_CHILDREN);assert p.returncode==0
  log=(D/(label+'.log')).read_text();counts=re.findall(r'\[sync\] reconcile-counts[^\n]*',log);assert len(counts)==1 and 'modified=1 removed=0'in counts[0]and'recoveryRetryFiles=0'in counts[0]
  row={'label':label,'version':v,'wallSeconds':wall,'cpuUserSeconds':after.ru_utime-before.ru_utime,'cpuSystemSeconds':after.ru_stime-before.ru_stime,'inputDatabaseSha256':digest,'inputSourceSha256':hashlib.sha256(edit).hexdigest(),'graph':snapshot(label),'reconcile':counts[0]};rows.append(row);(D/'results.json').write_text(json.dumps(rows,indent=2));print(label,wall,row['cpuUserSeconds']+row['cpuSystemSeconds'],flush=True)
assert all(r['graph'][t]==rows[0]['graph'][t]for r in rows for t in ['nodes','edges'])
print('All six graph hashes equal; complete',flush=True)
