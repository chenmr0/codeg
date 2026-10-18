import pathlib,hashlib,json,subprocess,re
E=pathlib.Path('/workspace/codegraph-evidence');R=pathlib.Path('/workspace/codegraph-regression-fixes');B=pathlib.Path('/workspace/codegraph-baseline-30d');P=pathlib.Path('/workspace/codegraph-package-test/node_modules/@sdd/codegraph-wx')
h=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
files=lambda r:{str(p.relative_to(r)):h(p)for p in (r/'dist').rglob('*.js')}
a,b,p=files(B),files(R),files(P);out={'runtimeJsDifferences':{n:[a.get(n),b.get(n)]for n in a.keys()|b.keys()if a.get(n)!=b.get(n)},'packageVsFrozenJs':{n:[b.get(n),p.get(n)]for n in b.keys()|p.keys()if b.get(n)!=p.get(n)},'node':{'version':subprocess.check_output(['node','--version'],text=True).strip(),'binary':h(pathlib.Path(subprocess.check_output(['which','node'],text=True).strip()))},'native':{str(x.relative_to(R)):h(x)for x in [R/'dist/native-scan/linux-x64/codegraph-scan',R/'dist/native-macros/linux-x64/codegraph-macros']},'dependencyRealpaths':[str((r/'node_modules').resolve())for r in [B,R]],'inputChanges':{},'configs':{}}
for m in ['ts','native']:
 out['configs'][m]=json.loads((E/f'rocksdb-guarded-{m}/configuration.json').read_text());changes=[json.loads(p.read_text())for p in (E/f'rocksdb-guarded-{m}').glob('*-change.json')];assert all(x==changes[0]for x in changes);out['inputChanges'][m]=changes[0]
assert out['inputChanges']['ts']==out['inputChanges']['native'];assert not out['packageVsFrozenJs']
# Existing benchmark stored full logical graphs and file lists; its temporary DBs were deleted.
out['originalDatabaseBytesRetained']=False;out['originalDatabaseComparison']='logical nodes/edges hashes + indexed paths/bytes and logs; cannot retrospectively compare SQLite page layout or all metadata byte-for-byte'
out['sourceDiff']=subprocess.check_output(['git','diff','30d5959','594c45f','--','src'],cwd=R,text=True)
(E/'causal-manifest.json').write_text(json.dumps(out,indent=2));print(json.dumps({k:v for k,v in out.items()if k not in ['sourceDiff','configs']},indent=2))
