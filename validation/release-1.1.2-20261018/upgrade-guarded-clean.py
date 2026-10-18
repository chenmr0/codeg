import importlib.util
spec=importlib.util.spec_from_file_location('validation','/workspace/codegraph-evidence/validate-cli.py');v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
results={}
for version in ['old','baseline']:
 root=v.project(v.E/('upgrade-guarded-clean-'+version))
 v.run(version,'init',root,'upgrade-guarded-clean-'+version+'-init');old=v.snapshot(root)
 for i in range(2):
  v.run('fixed','sync',root,f'upgrade-guarded-clean-{version}-noop-{i}');now=v.snapshot(root)
  assert now['nodes']==old['nodes']
  assert now['metadata']['indexed_with_extraction_version']==old['metadata']['indexed_with_extraction_version']
 edit=root/'tinyxml2.cpp';edit.write_text(edit.read_text()+'\nint codegraph_release_probe() { return 112; }\n')
 v.run('fixed','sync',root,'upgrade-guarded-clean-'+version+'-edit');changed=v.snapshot(root)
 assert any(n[2]=='codegraph_release_probe' for n in changed['nodes'])
 untouched=lambda data:[n for n in data['nodes'] if n[4]!='tinyxml2.cpp']
 assert untouched(old)==untouched(changed)
 assert changed['metadata']['indexed_with_extraction_version']==old['metadata']['indexed_with_extraction_version']
 results[version]={'beforeNodes':len(old['nodes']),'afterNodes':len(changed['nodes']),'oldStamp':old['metadata']['indexed_with_extraction_version'],'finalStamp':changed['metadata']['indexed_with_extraction_version'],'unchangedNoop':True,'unchangedOtherFilesAfterEdit':True,'integrity':'ok'}
 (v.E/('upgrade-guarded-clean-'+version+'-before.json')).write_text(v.json.dumps(old))
 (v.E/('upgrade-guarded-clean-'+version+'-after.json')).write_text(v.json.dumps(changed))
(v.E/'upgrade-guarded-clean-results.json').write_text(v.json.dumps(results,indent=2));print(results)
