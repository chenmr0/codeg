import os,subprocess,time,json,sqlite3,shutil,pathlib
E=pathlib.Path('/workspace/codegraph-evidence')
CLI={'old':'/workspace/codegraph-baseline-289/dist/bin/codegraph.js','baseline':'/workspace/codegraph-baseline-30d/dist/bin/codegraph.js','fixed':'/workspace/codegraph-package-test/node_modules/@sdd/codegraph-wx/dist/bin/codegraph.js'}
env=dict(os.environ,CODEGRAPH_RUST_SCAN='0',CODEGRAPH_RUST_MACROS='0',CODEGRAPH_ALL_LANGUAGES='1',NODE_OPTIONS='--max-old-space-size=4096')
def run(version,op,root,label):
    log=E/(label+'.log');start=time.perf_counter()
    with open(log,'w') as out:
        p=subprocess.run(['node','--liftoff-only',CLI[version],op,str(root),'--verbose'],stdout=out,stderr=subprocess.STDOUT,env=env,timeout=180)
    assert p.returncode==0,(label,p.returncode,log.read_text()[-3000:])
    return {'version':version,'op':op,'wall':time.perf_counter()-start,'log':str(log)}
def snapshot(root):
    db=sqlite3.connect(root/'.codegraph-wx/codegraph.db')
    integrity=db.execute('pragma integrity_check').fetchone()[0]
    nodes=db.execute('select id,kind,name,qualified_name,file_path,start_line,end_line,signature,is_declaration,updated_at from nodes order by id').fetchall()
    meta=dict(db.execute('select key,value from project_metadata'))
    db.close();assert integrity=='ok'
    return {'integrity':integrity,'nodes':nodes,'metadata':meta}
def project(target):
    shutil.copytree(E/'tinyxml2',target,dirs_exist_ok=True,ignore=shutil.ignore_patterns('.git','.codegraph-wx'))
    return target
if __name__=='__main__':
    root=project(E/'legacy-upgrade')
    runs=[run('old','init',root,'legacy-old-init')];old=snapshot(root)
    runs.append(run('fixed','sync',root,'legacy-fixed-noop'));noop=snapshot(root)
    assert old['nodes']==noop['nodes'],'noop rewrote old nodes'
    runs.append(run('fixed','sync',root,'legacy-fixed-noop-repeat'));again=snapshot(root)
    assert noop['nodes']==again['nodes']
    edit=root/'tinyxml2.cpp';edit.write_text(edit.read_text()+'\nint codegraph_release_probe() { return 112; }\n')
    runs.append(run('fixed','sync',root,'legacy-fixed-edit'));changed=snapshot(root)
    assert any(n[2]=='codegraph_release_probe' for n in changed['nodes'])
    untouched=lambda data:[n for n in data['nodes'] if n[4]!='tinyxml2.cpp']
    assert untouched(old)==untouched(changed),'unmodified files rewritten'
    for label,data in [('old',old),('noop',noop),('repeat',again),('edit',changed)]:
        (E/('legacy-'+label+'-graph.json')).write_text(json.dumps(data))
    (E/'legacy-upgrade-results.json').write_text(json.dumps({'runs':runs,'unchangedNoop':True,'unchangedOtherFilesAfterEdit':True,'oldMetadata':old['metadata'],'finalMetadata':changed['metadata']},indent=2))
    print('legacy upgrade passed',len(old['nodes']),len(changed['nodes']))
