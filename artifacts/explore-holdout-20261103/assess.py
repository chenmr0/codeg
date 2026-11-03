import json,re,pathlib,collections,hashlib,sys,subprocess
if not __debug__: raise RuntimeError("Run without -O/PYTHONOPTIMIZE: validation assertions are required")
from validation import check_frozen_inputs, checked_source, extract_source
SCORER_VERSION="2.2-trusted-freeze-contained-source"
assert len(sys.argv)==3, 'usage: python3 assess.py OUTPUT_DIR OCEANBASE_SOURCE'
r=pathlib.Path(sys.argv[1]);source_root=pathlib.Path(sys.argv[2])
check_frozen_inputs(pathlib.Path(__file__).parent)
qs, freeze = check_frozen_inputs(r)
expected_source = '5e8a63d29dae9fde5e962b8fcc7b167d438fc343'
actual_source = subprocess.check_output(['git','-C',str(source_root),'rev-parse','HEAD'],text=True).strip()
assert actual_source == expected_source, 'wrong OceanBase source commit'
assert not subprocess.check_output(['git','-C',str(source_root),'status','--porcelain','--untracked-files=no'],text=True).strip(), 'modified tracked OceanBase source'
rows=[];source_errors=[];source_cache={}
tracked=set(subprocess.check_output(['git','-C',str(source_root),'ls-files','-z'],text=True).split('\0'))
assert len({q['id'] for q in qs})==len(qs), 'duplicate query IDs'
for q in qs:
 for g in q['gold']:
  src=checked_source(source_root,g['path'],tracked)
  assert src.read_text().splitlines()[g['line']-1] == g['text'], 'gold/source mismatch'
for arm in ['baseline','final','community']:
 records=[json.loads(l)for l in (r/(arm+'.jsonl')).read_text().splitlines()]
 assert len(records)==len(qs) and {x['id']for x in records}=={q['id']for q in qs}, f'{arm}: missing/duplicate records'
 assert (r/(arm+'.exit')).read_text().strip()=='0', f'{arm}: process failed'
 for x in records:
  assert 'error' not in x and x.get('isError') is False, f'{arm}/{x["id"]}: failed call'
  p=r/'outputs'/arm/(x['id']+'.txt')
  assert p.is_file() and hashlib.sha256(p.read_bytes()).hexdigest()==x['sha256'], f'{arm}/{x["id"]}: missing/changed output'
def extract(text):
 return extract_source(text, lambda name: checked_source(source_root,name,tracked))
for q in qs:
 row={k:q[k] for k in ['id','subsystem','category','query']};row['goldCount']=len(q['gold']);row['arms']={}
 for arm in ['baseline','final','community']:
  p=r/'outputs'/arm/(q['id']+'.txt')
  assert p.exists(), f'missing output: {p}'
  text=p.read_text();lines=extract(text)
  hits=[i for i,g in enumerate(q['gold'])if lines.get((g['path'],g['line']),'').strip()==g['text'].strip()]
  row['arms'][arm]={'hits':hits,'hitCount':len(hits),'allGold':len(hits)==len(q['gold']) if q['gold']else None,'chars':len(text),'sourceLines':len(lines)}
  for (file,n),line in lines.items():
   src=checked_source(source_root,file,tracked)
   if not src.exists():source_errors.append([q['id'],arm,file,n,'missing path']);continue
   if file not in source_cache:source_cache[file]=src.read_text().split('\n')
   actual=source_cache[file]
   if not(0<n<=len(actual) and line.strip()==actual[n-1].strip()):source_errors.append([q['id'],arm,file,n,'content mismatch'])
  row['arms'][arm]['sourceBlocks']=re.findall(r'```[^\n]*\n(.*?)```',text,re.S)
 if all(a in row['arms']for a in ['baseline','final']):
  a=row['arms']['baseline'];c=row['arms']['final'];row['finalVsBaselineEvidenceDelta']=c['hitCount']-a['hitCount'];row['sameSourceBlocks']=a['sourceBlocks']==c['sourceBlocks']
 for arm in row['arms']:row['arms'][arm].pop('sourceBlocks')
 rows.append(row)
summary={}
for groupfield in ['overall','category','subsystem']:
 groups=collections.defaultdict(list)
 for row in rows:
  if row['goldCount']:groups[row.get(groupfield,'all')].append(row)
 summary[groupfield]={}
 for group,rs in groups.items():
  summary[groupfield][group]={arm:{'queries':len(rs),'allGold':sum(x['arms'].get(arm,{}).get('allGold',False)for x in rs),'hitCount':sum(x['arms'].get(arm,{}).get('hitCount',0)for x in rs),'goldCount':sum(x['goldCount']for x in rs)}for arm in ['baseline','final','community']}
(r/'scorer-version.json').write_text(json.dumps({'version':SCORER_VERSION,'sha256':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),'validationSha256':hashlib.sha256(pathlib.Path(__file__).with_name('validation.py').read_bytes()).hexdigest(),'frozenGoldSha256':freeze['sha256']},indent=2))
(r/'results.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2));(r/'summary.json').write_text(json.dumps(summary,indent=2));(r/'source-errors.json').write_text(json.dumps(source_errors,indent=2));print(json.dumps(summary['overall']));print('source errors',len(source_errors))
for row in rows:
 print(row['id'],row['goldCount'],*[row['arms'].get(arm,{}).get('hitCount')for arm in ['baseline','final','community']],row.get('sameSourceBlocks'))

if source_errors: raise SystemExit('Source verification failed; results are diagnostic only')
