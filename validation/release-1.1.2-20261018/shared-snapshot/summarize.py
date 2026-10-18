import pathlib,json,re,statistics,hashlib
D=pathlib.Path('/workspace/codegraph-evidence/shared-snapshot');rows=json.loads((D/'results.json').read_text());manifest=json.loads((D/'manifest.json').read_text());profiles=[]
for r in rows:
 x=json.loads(next(D.glob(r['label']+'-profile.*.0.json')).read_text());s=(D/(r['label']+'.log')).read_text()
 r['tailMs']={k:int(v)for k,v in re.findall(r'(\w+)=(\d+)ms',re.search(r'\[sync\] tail-detail[^\n]*',s)[0])}
 r['pipelineMs']={k:int(v)for k,v in re.findall(r'(\w+)=(\d+)ms',re.search(r'\[sync\] phases[^\n]*',s)[0])}
 r['cpuSeconds']=r['cpuUserSeconds']+r['cpuSystemSeconds'];r['sqlWallMs']=sum(a['wallMs']for a in x['sql']);r['sqlCpuMs']=sum(a['cpuUserMs']+a['cpuSystemMs']for a in x['sql']);r['adapterOperations']=sum(a['count']for a in x['sql']);r['sqlCounts']={a['phase']+'|'+a['operation']+'|'+a['sql']:a['count']for a in x['sql']};r['sqlCountHash']=hashlib.sha256(json.dumps(r['sqlCounts'],sort_keys=True).encode()).hexdigest();r['topSql']=sorted(x['sql'],key=lambda a:a['wallMs'],reverse=True)[:5];r['resolverMethodMeasurements']=x['phases'];r['mainProcessProfileTotal']=x['total'];profiles.append(x)
assert all(r['sqlCounts']==rows[0]['sqlCounts']for r in rows)
assert all(r['graph'][t]==rows[0]['graph'][t]for r in rows for t in ['nodes','edges'])
pairs=[]
for i in range(1,4):
 a=next(r for r in rows if r['label']==f'r{i}-baseline');b=next(r for r in rows if r['label']==f'r{i}-fixed');pairs.append({'pair':i,'wallChangePercent':(b['wallSeconds']/a['wallSeconds']-1)*100,'cpuChangePercent':(b['cpuSeconds']/a['cpuSeconds']-1)*100})
medians={}
for k in ['wallSeconds','cpuSeconds','sqlWallMs','sqlCpuMs']:
 a=statistics.median(r[k]for r in rows if r['version']=='baseline');b=statistics.median(r[k]for r in rows if r['version']=='fixed');medians[k]={'baseline':a,'fixed':b,'changePercent':(b/a-1)*100}
result={'manifest':manifest,'runs':rows,'pairs':pairs,'medians':medians,'allGraphHashesEqual':True,'allSqlShapesAndCountsEqual':True,'productionChanged':False,'scope':'common 30d physical snapshot; existing eight extra declarations remain in both; does not compare independently initialized candidate layout or repaired TestBody graph','measurementLimit':'identical SQL instrumentation overhead in all six runs; adapter operations include iterator.next and preparation, not SQL statement execution count'};(D/'summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
print('snapshot',manifest['templateSha256']);print('graph',rows[0]['graph']['nodes'],rows[0]['graph']['edges']);print('pairs',pairs);print('medians',medians)
for r in rows:print(r['label'],r['wallSeconds'],r['cpuSeconds'],r['tailMs']['orphanAndSynthesisMs'],r['sqlWallMs'],r['sqlCpuMs'])
