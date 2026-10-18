import os,sys,json,time,threading,pathlib,subprocess,sqlite3,shutil,hashlib,signal,statistics
E=pathlib.Path('/workspace/codegraph-evidence');MODE=sys.argv[1];OUT=E/('rocksdb-guarded-'+MODE);OUT.mkdir(exist_ok=True)
SOURCE=E/'rocksdb'
CLI={'baseline':'/workspace/codegraph-baseline-30d/dist/bin/codegraph.js','fixed':'/workspace/codegraph-regression-fixes/dist/bin/codegraph.js'}
env=dict(os.environ,CODEGRAPH_RUST_SCAN=('1' if MODE=='native' else '0'),CODEGRAPH_RUST_MACROS=('1' if MODE=='native' else '0'),CODEGRAPH_RUST_SCAN_PATH='/workspace/codegraph-regression-fixes/dist/native-scan/linux-x64/codegraph-scan',CODEGRAPH_RUST_MACROS_PATH='/workspace/codegraph-regression-fixes/dist/native-macros/linux-x64/codegraph-macros',CODEGRAPH_ALL_LANGUAGES='1',CODEGRAPH_PARSE_WORKERS='1',CODEGRAPH_NO_STORE_WORKER='1',NODE_OPTIONS='--max-old-space-size=4096')
rows=[];snapshots={};canonical_tables={}
config={'sourceCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=SOURCE,text=True).strip(),'codeCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd='/workspace/codegraph-regression-fixes',text=True).strip(),'orders':['AB','BA','AB','BA'],'environment':{k:v for k,v in env.items() if k.startswith('CODEGRAPH_') or k=='NODE_OPTIONS'},'cpuQuota':pathlib.Path('/sys/fs/cgroup/cpu.max').read_text().strip(),'memoryLimit':pathlib.Path('/sys/fs/cgroup/memory.max').read_text().strip(),'initialMemory':pathlib.Path('/sys/fs/cgroup/memory.current').read_text().strip(),'diskFree':shutil.disk_usage(E).free,'limits':{'wallSeconds':600,'groupRssGiB':8,'cgroupMemoryGiB':14,'minimumFreeDiskGiB':4},'rssSamplingSeconds':.05}
(OUT/'configuration.json').write_text(json.dumps(config,indent=2))
def run(version,op,root,label):
 assert shutil.disk_usage(E).free>4*1024**3
 stop=threading.Event();peak=[0];reason=[];samples=[0]
 with open(OUT/(label+'.log'),'w') as log:
  start=time.perf_counter();p=subprocess.Popen(['node','--liftoff-only',CLI[version],op,str(root),'--verbose'],stdout=log,stderr=subprocess.STDOUT,env=env,start_new_session=True)
  def kill(why):
   reason.append(why)
   try:os.killpg(p.pid,signal.SIGKILL)
   except ProcessLookupError:pass
  def sample():
   while not stop.is_set():
    rss=0
    for item in pathlib.Path('/proc').iterdir():
     if not item.name.isdigit():continue
     try:
      if os.getpgid(int(item.name))==p.pid:rss+=int((item/'statm').read_text().split()[1])*os.sysconf('SC_PAGE_SIZE')
     except (OSError,ValueError,IndexError):pass
    peak[0]=max(peak[0],rss);samples[0]+=1
    if rss>8*1024**3:kill('group RSS limit');break
    if int(pathlib.Path('/sys/fs/cgroup/memory.current').read_text())>14*1024**3:kill('cgroup memory limit');break
    if shutil.disk_usage(E).free<4*1024**3:kill('disk free limit');break
    stop.wait(.05)
  thread=threading.Thread(target=sample);thread.start();timer=threading.Timer(600,lambda:kill('wall limit'));timer.start()
  try:code=p.wait();wall=time.perf_counter()-start
  finally:timer.cancel();stop.set();thread.join()
 row={'version':version,'operation':op,'label':label,'wall_seconds':wall,'process_group_peak_rss_mib':peak[0]/1048576,'samples':samples[0],'exitCode':code,'stopReasons':reason};rows.append(row)
 (OUT/'raw.json').write_text(json.dumps(rows,indent=2));print(json.dumps(row),flush=True)
 assert code==0 and not reason,row

def snapshot(root,label):
 db=sqlite3.connect(root/'.codegraph-wx/codegraph.db');assert db.execute('pragma integrity_check').fetchone()[0]=='ok'
 out={'tables':{},'indexedFiles':db.execute('select count(*) from files').fetchone()[0]}
 paths=[r[0] for r in db.execute('select path from files')]
 out['indexedBytes']=sum((root/p).stat().st_size for p in paths)
 (OUT/(label+'-indexed-files.json')).write_text(json.dumps(paths))
 out['testBody']=db.execute("select qualified_name,is_declaration,start_line from nodes where file_path='util/crc32c_test.cc' and name='TestBody' order by qualified_name,is_declaration").fetchall()
 out['probe']=db.execute("select qualified_name,is_declaration from nodes where name='codegraph_release_probe'").fetchall()
 for table,omit in [('nodes',{'updated_at'}),('edges',{'id'})]:
  cols=[c[1] for c in db.execute('pragma table_info('+table+')') if c[1] not in omit]
  digest=hashlib.sha256();count=0
  with open(OUT/(label+'-'+table+'.jsonl'),'wb') as f:
   for row in db.execute('select '+','.join(cols)+' from '+table+' order by '+','.join(cols)):
    data=(json.dumps(row,ensure_ascii=False,separators=(',',':'))+'\n').encode();f.write(data);digest.update(data);count+=1
  out['tables'][table]={'rows':count,'sha256':digest.hexdigest(),'columns':cols}
  key=(table,digest.hexdigest());target=OUT/(label+'-'+table+'.jsonl')
  if key in canonical_tables:
   replacement=target.with_suffix('.identical');os.link(canonical_tables[key],replacement);os.replace(replacement,target)
  else:canonical_tables[key]=target
 db.close();(OUT/(label+'-stats.json')).write_text(json.dumps(out,indent=2));return out

def prepare(label,edited=False):
 root=OUT/label;shutil.copytree(SOURCE,root,ignore=shutil.ignore_patterns('.git','.codegraph-wx'))
 if edited:edit(root,label)
 return root

def edit(root,label):
 p=root/'util/crc32c.cc';before=p.read_bytes();after=before+b'\nnamespace ROCKSDB_NAMESPACE::crc32c {\nuint32_t codegraph_release_probe() { return Value("abc", 3); }\n}\n';p.write_bytes(after)
 (OUT/(label+'-change.json')).write_text(json.dumps({'path':'util/crc32c.cc','beforeBytes':len(before),'afterBytes':len(after),'beforeSha256':hashlib.sha256(before).hexdigest(),'afterSha256':hashlib.sha256(after).hexdigest(),'addedText':after[len(before):].decode()},indent=2))

for round,order in enumerate([['baseline','fixed'],['fixed','baseline'],['baseline','fixed'],['fixed','baseline']],1):
 for version in order:
  label=f'r{round}-{version}';root=prepare(label)
  run(version,'init',root,label+'-init');initial=snapshot(root,label+'-init')
  run(version,'sync',root,label+'-noop');noop=snapshot(root,label+'-noop');assert initial==noop,'noop changed graph'
  edit(root,label);run(version,'sync',root,label+'-edit');changed=snapshot(root,label+'-edit');assert len(changed['probe'])==1
  snapshots[label]={'initial':initial,'changed':changed}
  (OUT/'snapshots.json').write_text(json.dumps(snapshots,indent=2))
  assert root.parent==OUT and (root/'CMakeLists.txt').is_file();shutil.rmtree(root)
for version in ['baseline','fixed']:
 label='fresh-edited-'+version;root=prepare(label,True);run(version,'init',root,label);snapshots[label]=snapshot(root,label)
 assert root.parent==OUT and (root/'CMakeLists.txt').is_file();shutil.rmtree(root)
(OUT/'snapshots.json').write_text(json.dumps(snapshots,indent=2))
summary={}
for version in ['baseline','fixed']:
 for op in ['init','noop','edit']:
  selected=[r for r in rows if r['version']==version and r['label'].startswith('r') and r['label'].endswith('-'+op)]
  summary[version+'-'+op]={k:{'median':statistics.median(r[k] for r in selected),'min':min(r[k] for r in selected),'max':max(r[k] for r in selected)} for k in ['wall_seconds','process_group_peak_rss_mib']}
checks={}
for version in ['baseline','fixed']:
 checks[version+'-repeatable']=all(snapshots[f'r1-{version}']==snapshots[f'r{i}-{version}'] for i in range(2,5))
 checks[version+'-incrementalFresh']={t:snapshots[f'r1-{version}']['changed']['tables'][t]['sha256']==snapshots['fresh-edited-'+version]['tables'][t]['sha256'] for t in ['nodes','edges']}
checks['crossVersion']={t:snapshots['r1-baseline']['initial']['tables'][t]['sha256']==snapshots['r1-fixed']['initial']['tables'][t]['sha256'] for t in ['nodes','edges']}
(OUT/'summary.json').write_text(json.dumps({'performance':summary,'graphChecks':checks},indent=2));print(json.dumps(checks),flush=True)
