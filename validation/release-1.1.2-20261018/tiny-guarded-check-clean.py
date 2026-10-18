import importlib.util,json,sqlite3
spec=importlib.util.spec_from_file_location('v','/workspace/codegraph-evidence/validate-cli.py');v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
out={}
for name in ['baseline','fixed']:
 root=v.project(v.E/('tiny-guarded-clean-'+name));v.run(name,'init',root,'tiny-guarded-clean-'+name+'-init');db=sqlite3.connect(root/'.codegraph-wx/codegraph.db');data={}
 for table,omit in [('nodes',{'updated_at'}),('edges',{'id'})]:
  cols=[r[1]for r in db.execute('pragma table_info('+table+')')if r[1]not in omit];rows=db.execute('select '+','.join(cols)+' from '+table+' order by '+','.join(cols)).fetchall();data[table]=rows
 assert db.execute('pragma integrity_check').fetchone()[0]=='ok';db.close();out[name]=data
assert out['baseline']==out['fixed'];(v.E/'tiny-guarded-clean-graphs.json').write_text(json.dumps(out));print({n:{t:len(r)for t,r in d.items()}for n,d in out.items()})
