"""Prepare immutable-baseline, tool-only P0 regression copies. No model calls."""
from pathlib import Path
import json
import runpy
import shutil
import sqlite3
import subprocess

ROOT = Path(__file__).resolve().parents[2]
OLD = ROOT / 'artifacts/oceanbase-explore-selection-20261021'
OUT = ROOT / 'artifacts/oceanbase-explore-p0-20261021'
helpers = runpy.run_path(str(Path(__file__).with_name('oceanbase-explore-selection-probe.py')))
sha, dump, facts = (helpers[k] for k in ['sha', 'dump', 'facts'])

if OUT.exists():
    raise RuntimeError('Refusing to replace an existing regression')
OUT.mkdir()
protected = {}
for folder in (ROOT / 'artifacts').iterdir():
    if not folder.is_dir() or folder == OUT or not folder.name.startswith('oceanbase'):
        continue
    for sub in ['runs', 'results']:
        for p in (folder / sub).rglob('*'):
            if p.is_file():
                protected[str(p.relative_to(ROOT))] = sha(p)
dump(OUT / 'protected-log-hashes.json', protected)
manifest = json.loads((OLD / 'manifest.json').read_text(encoding='utf8'))
protocol = json.loads((OLD / 'protocol.json').read_text(encoding='utf8'))
dump(OUT / 'manifest.json', manifest)
candidate = OUT / 'candidate'
shutil.copytree(ROOT / 'dist', candidate / 'dist')
shutil.copy2(ROOT / 'package.json', candidate / 'package.json')
dump(OUT / 'root-dist-hashes.json', {str(p.relative_to(ROOT)): sha(p) for p in (ROOT / 'dist').rglob('*') if p.is_file()})
for arm, folder in [('ours', '.codegraph-wx'), ('community', '.codegraph')]:
    repo = OUT / 'repos' / arm
    for f in manifest['files']:
        original = OLD / 'repos' / arm / f['path']
        assert sha(original) == f['sha256']
        target = repo / f['path']
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(original, target)
    dbpath = repo / folder / 'codegraph.db'
    dbpath.parent.mkdir()
    with sqlite3.connect((OLD / 'repos' / arm / folder / 'codegraph.db').resolve().as_uri()+'?mode=ro', uri=True) as src:
        with sqlite3.connect(dbpath) as dst:
            src.backup(dst, pages=4096)
    dump(OUT / f'{arm}-index-before.json', facts(dbpath))
    print(f'{arm}: copied frozen source and index', flush=True)
protocol['ours_package'] = str(candidate)
protocol['baseline'] = str(OLD)
protocol['model_calls'] = 0
protocol['index_policy'] = 'runtime-only control first; full extraction rebuild for P0 result'
dump(OUT / 'protocol.json', protocol)
(OUT / 'validation').mkdir()
with (OUT / 'validation/build.txt').open('w', encoding='utf8') as log:
    subprocess.run(['node', str(ROOT/'node_modules/typescript/bin/tsc'), '--outDir', str(candidate/'dist')], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True)
dump(OUT / 'candidate-hashes.json', {str(p.relative_to(candidate)):sha(p) for p in (candidate/'dist').rglob('*') if p.is_file()})
print('Candidate built; original dist and logs preserved', flush=True)
