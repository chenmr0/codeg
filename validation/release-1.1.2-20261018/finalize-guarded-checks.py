import json,pathlib
E=pathlib.Path('/workspace/codegraph-evidence')
def read(p):return json.loads((E/p).read_text())
out={'crossMode':{},'sameAsPriorNarrow':{},'nativeExecution':{}}
for v in ['baseline','fixed']:
 for op in ['init','edit']:
  label=f'r1-{v}-{op}-stats.json'
  a=read('rocksdb-guarded-ts/'+label)['tables'];b=read('rocksdb-guarded-native/'+label)['tables']
  out['crossMode'][v+'-'+op]={t:a[t]['sha256']==b[t]['sha256']for t in a};assert all(out['crossMode'][v+'-'+op].values())
  for m in ['ts','native']:
   old=read(f'rocksdb-pairing-{m}/'+label)['tables'];new=read(f'rocksdb-guarded-{m}/'+label)['tables']
   out['sameAsPriorNarrow'][m+'-'+v+'-'+op]={t:old[t]['sha256']==new[t]['sha256']for t in old};assert all(out['sameAsPriorNarrow'][m+'-'+v+'-'+op].values())
for m in ['ts','native']:
 checks=read(f'rocksdb-guarded-{m}/summary.json')['graphChecks']
 for v in ['baseline','fixed']:
  assert checks[v+'-repeatable'] and all(checks[v+'-incrementalFresh'].values())
 for op in ['init','edit']:
  a=read(f'guarded-graph-audit-{m}-{op}.json')
  for k in ['unexplainedRemoved','unexplainedAdded','removedEdgesAfterExactPairMapping','addedEdgesAfterExactPairMapping']:assert not a[k]
  assert len(a['changedNodes'])==8 and all(set(n['fields'])=={'id','visibility'}for n in a['changedNodes'])
 rows=read(f'rocksdb-guarded-{m}/raw.json');assert len(rows)==26 and all(r['exitCode']==0 and not r['stopReasons']for r in rows)
for p in (E/'rocksdb-guarded-native').glob('*.log'):
 if '-noop' in p.name:continue
 lines=[l for l in p.read_text().splitlines()if 'macro-detail mode='in l]
 assert lines and all('mode=rust 'in l and 'fallbackFiles=0 'in l for l in lines),p
 out['nativeExecution'][p.name]=lines
(E/'guarded-cross-mode.json').write_text(json.dumps(out,indent=2));print('All final graph, native execution, and repeatability checks passed')
