import json,pathlib,sys,collections
E=pathlib.Path('/workspace/codegraph-evidence');mode=sys.argv[1];P=E/('rocksdb-guarded-'+mode);op=sys.argv[2] if len(sys.argv)>2 else 'init'
def load(v,t):
 stats=json.loads((P/f'r1-{v}-{op}-stats.json').read_text());cols=stats['tables'][t]['columns'];return [dict(zip(cols,json.loads(s))) for s in (P/f'r1-{v}-{op}-{t}.jsonl').read_text().splitlines()]
a=load('baseline','nodes');b=load('fixed','nodes');aa={n['id']:n for n in a};bb={n['id']:n for n in b};mapping={k:k for k in aa.keys()&bb.keys()};changes=[]
for k in mapping:
 if aa[k]!=bb[k]:changes.append({'before':aa[k],'after':bb[k]})
key=lambda n:tuple(n.get(k) for k in ['kind','name','qualified_name','file_path','start_line','signature','is_declaration'])
newgroups=collections.defaultdict(list)
for k in bb.keys()-aa.keys():newgroups[key(bb[k])].append(bb[k])
removed=[];unexplained=[]
for k in aa.keys()-bb.keys():
 n=aa[k];matches=newgroups.get(key(n),[])
 if len(matches)==1:
  target=matches[0];mapping[k]=target['id'];changes.append({'before':n,'after':target})
 else:removed.append(n)
for n in removed:
 candidates=[q for q in b if q['file_path']==n['file_path'] and q['start_line']==n['start_line'] and q['kind']==n['kind'] and q['name']==n['name'] and not q['is_declaration']]
 if n['is_declaration'] and len(candidates)==1:mapping[n['id']]=candidates[0]['id']
 else:unexplained.append(n)
mappedIds=set(mapping.values());added=[n for n in b if n['id']not in mappedIds]
assert len(removed)==8 and all(n['file_path']=='util/crc32c_test.cc' and n['name']=='TestBody' and n['is_declaration'] for n in removed)
assert not unexplained and not added
changes=[{'oldId':x['before']['id'],'newId':x['after']['id'],'name':x['after']['qualified_name'],'fields':{k:[x['before'][k],x['after'][k]] for k in x['before'] if x['before'][k]!=x['after'][k]}}for x in changes]
def edgekey(n,convert):
 d=dict(n)
 if convert:
  for k in ['source','target']:d[k]=mapping.get(d[k],d[k])
 return json.dumps(d,sort_keys=True)
ea={edgekey(x,True)for x in load('baseline','edges')};eb={edgekey(x,False)for x in load('fixed','edges')}
result={'mode':mode,'operation':op,'baselineNodes':len(a),'fixedNodes':len(b),'removedDeclarations':removed,'changedNodes':changes,'unexplainedRemoved':unexplained,'unexplainedAdded':added,'removedEdgesAfterExactPairMapping':[json.loads(x)for x in ea-eb],'addedEdgesAfterExactPairMapping':[json.loads(x)for x in eb-ea]}
(E/f'guarded-graph-audit-{mode}-{op}.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print({k:v for k,v in result.items()if k not in ['removedDeclarations','changedNodes']});print('Changed node fields',collections.Counter(k for x in changes for k in x['fields']))
