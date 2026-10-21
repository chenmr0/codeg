"""Prepare isolated tool-only replay data; never calls a model."""
from pathlib import Path
import hashlib
import json
import shutil
import sqlite3

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'artifacts/oceanbase-explore-selection-20261021'
OLD = ROOT / 'artifacts/oceanbase-demand-20261021-v2'
OURS = ROOT / 'artifacts/oceanbase-demand-20261021-explore-first-r2/candidate'
COMMUNITY = Path('D:/c_proj/codegraph-ori')


def sha(p):
    h = hashlib.sha256()
    with p.open('rb') as f:
        for block in iter(lambda: f.read(4 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def dump(p, value):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def facts(dbpath):
    with sqlite3.connect(dbpath.resolve().as_uri() + '?mode=ro', uri=True) as db:
        return {'counts': {t: db.execute(f'SELECT count(*) FROM {t}').fetchone()[0] for t in ['files','nodes','edges']},
                'metadata': list(db.execute('SELECT * FROM project_metadata')),
                'files': list(db.execute('SELECT path, content_hash FROM files ORDER BY path'))}


if __name__ == '__main__':
    if OUT.exists():
        raise RuntimeError('Refusing to overwrite probe directory')
    OUT.mkdir()
    manifest = json.loads((OLD / 'source-manifest.json').read_text(encoding='utf-8'))
    for name in [f['path'] for f in manifest['files']]:
        if 'FEAT_DTL' in name or name.endswith(('AGENTS.md','CLAUDE.md')):
            raise RuntimeError('Unexpected instructions or requirement in source snapshot')
    config = {'model_calls': 0, 'ours_package': str(OURS), 'community_package': str(COMMUNITY),
              'source_snapshot_head': manifest['versions']['oceanbase']['head'],
              'queries': [
                  {'label': 'primary', 'query': 'ObDtlBasicChannel ObDtlFlowControl DTL_BLOCKING_TIME ObPxTransmitOp', 'maxFiles': 12},
                  {'label': 'with-wait-blocking', 'query': 'ObDtlBasicChannel ObDtlFlowControl wait blocking DTL_BLOCKING_TIME ObPxTransmitOp', 'maxFiles': 12},
                  {'label': 'named-functions', 'query': 'ObDtlFlowControl::need_block ObDtlFlowControl::can_unblock ObDtlBasicChannel::wait_unblocking', 'maxFiles': 12},
              ], 'indices': {}, 'binary_hashes': {}}
    for arm,folder,package in [('community','.codegraph',COMMUNITY),('ours','.codegraph-wx',OURS)]:
        dest = OUT / 'repos' / arm
        for item in manifest['files']:
            source = OLD / 'repos' / arm / item['path']
            if sha(source) != item['sha256']:
                raise RuntimeError(f'Source changed: {source}')
            target = dest / item['path']; target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        original = OLD / 'repos' / arm / folder / 'codegraph.db'
        before = facts(original)
        for rel, digest in before['files']:
            if sha(dest / rel) != digest:
                raise RuntimeError(f'Stale indexed source: {arm}/{rel}')
        target = dest / folder / 'codegraph.db'; target.parent.mkdir()
        with sqlite3.connect(original.resolve().as_uri() + '?mode=ro', uri=True) as src:
            with sqlite3.connect(target) as dst:
                src.backup(dst, pages=4096)
        assert facts(target) == before
        config['indices'][arm] = before
        config['binary_hashes'][arm] = {str(p.relative_to(package)):sha(p) for p in sorted((package/'dist').rglob('*')) if p.is_file()}
        print(f'{arm}: copied {len(manifest["files"])} source files and complete index', flush=True)
    dump(OUT/'manifest.json', manifest)
    dump(OUT/'protocol.json', config)
    dump(OUT/'product-source-hashes.json', {str(p.relative_to(ROOT)):sha(p) for p in sorted((ROOT/'src').rglob('*')) if p.is_file()})
