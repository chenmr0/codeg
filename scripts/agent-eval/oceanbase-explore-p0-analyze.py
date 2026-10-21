"""Compare fixed query outputs against the preserved baseline, source-verified."""
from pathlib import Path
import hashlib
import json
import re

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'artifacts/oceanbase-explore-p0-20261021'
OLD=ROOT/'artifacts/oceanbase-explore-selection-20261021'
TARGETS=[('need_block','src/sql/dtl/ob_dtl_flow_control.h',106,118),
         ('can_unblock','src/sql/dtl/ob_dtl_flow_control.h',119,131),
         ('wait_unblocking','src/sql/dtl/ob_dtl_basic_channel.cpp',801,891)]

def read(p): return json.loads(p.read_text(encoding='utf8'))
def spans(numbers):
    result=[]
    for n in sorted(set(numbers)):
        if result and result[-1][1]+1==n: result[-1][1]=n
        else: result.append([n,n])
    return result

def analyze(p,repo):
    data=p.read_bytes();text=data.decode('utf8');current=None;fenced=False;files={}
    for line in text.splitlines():
        m=re.match(r'(?:#### (\S+)|\*\*`([^`]+)`\*\*)',line)
        if m:current=next(x for x in m.groups() if x)
        if line.startswith('```'):fenced=not fenced;continue
        m=re.match(r'^(\d+)\t(.*)$',line)
        if fenced and m and current:files.setdefault(current,{})[int(m[1])]=m[2]
    blocks=[]
    for file,lines in files.items():
        original=(repo/file).read_text(encoding='utf8').splitlines()
        assert all(n<=len(original) and original[n-1]==line for n,line in lines.items()),(p,file)
        blocks.append({'file':file,'ranges':spans(lines),'numberedLines':len(lines)})
    coverage={}
    for name,file,start,end in TARGETS:
        covered=set(files.get(file,{})) & set(range(start,end+1))
        coverage[name]={'complete':len(covered)==end-start+1,'coveredLines':len(covered),'totalLines':end-start+1}
    return {'chars':len(text.encode('utf-16-le'))//2,'sha256':hashlib.sha256(data).hexdigest(),
            'files':len(blocks),'numberedLines':sum(b['numberedLines'] for b in blocks),
            'coverage':coverage,'blocks':blocks,'truncated':'output truncated to budget' in text}

report={'modelCalls':0,'sourceLinesVerified':True,'pairs':[]}
for q in read(OUT/'protocol.json')['queries']:
    row={'label':q['label'],'query':q['query'],'maxFiles':q['maxFiles'],'arms':{}}
    for label,folder,arm,repo in [
        ('community',OUT/'results','community',OUT/'repos/community'),
        ('ours-before',OLD/'results','ours',OLD/'repos/ours'),
        ('ours-p0-initial',OUT/'results','ours',OUT/'repos/ours'),
        ('ours-p0-final',OUT/'verified-results','ours',OUT/'repos/ours')]:
        row['arms'][label]=analyze(folder/f'{arm}-{q["label"]}.txt',repo)
    final=row['arms']['ours-p0-final'];before=row['arms']['ours-before']
    final['charChange']=final['chars']-before['chars']
    final['charChangePercent']=round(100*(final['chars']/before['chars']-1),2)
    traversals=read(OUT/'verified-results'/f'ours-{q["label"]}.traversals.json')
    final['bfsCapViolations']=[r for r in traversals if isinstance(r['options'].get('limit'),(float,int)) and r['nodes']>r['options']['limit']]
    gathers=read(OUT/'verified-results'/f'ours-{q["label"]}.gathers.json')
    final['gather']=[{'roots':[next(n for n in g['nodes'] if n['id']==i) for i in g['roots']],
                     'nodes':len(g['nodes']),'edges':len(g['edges']),
                     'targets':[n for n in g['nodes'] if n['name'] in [t[0] for t in TARGETS]]} for g in gathers]
    assert row['arms']['community']['sha256']==analyze(OLD/'results'/f'community-{q["label"]}.txt',OLD/'repos/community')['sha256']
    report['pairs'].append(row)
(OUT/'comparison.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
for row in report['pairs']:
    print(row['label'])
    for label,arm in row['arms'].items():
        print(label,arm['chars'],{k:v['coveredLines'] for k,v in arm['coverage'].items()},'truncated',arm['truncated'])
