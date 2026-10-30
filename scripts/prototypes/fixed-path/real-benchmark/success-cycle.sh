#!/usr/bin/env bash
set -euo pipefail
# Dedicated clean OceanBase checkout only; this changes its checked-out commit.
ROOT="$(realpath "$1")"; A="$(realpath "$2")"; B="$(realpath "$3")"; EV="$(realpath -m "$4")"
ENTRY="$(cd "$(dirname "$0")" && pwd)"
git -C "$ROOT" diff --quiet && git -C "$ROOT" diff --cached --quiet
mkdir -p "$EV"
export CODEGRAPH_ALL_LANGUAGES=1 CODEGRAPH_PARSE_WORKERS=2 CODEGRAPH_RESOLVE_WORKERS=2 CODEGRAPH_RUST_MACROS_WORKERS=2 CODEGRAPH_PARSE_TIMEOUT_MS=180000 CODEGRAPH_PROTOTYPE_READ_GATES=0 BENCHMARK_QUERY_INTERVAL_MS=500
for suffix in -wal -shm -journal; do [ ! -e "$ROOT/.codegraph-wx/codegraph.db$suffix" ] || exit 1; done
git -C "$ROOT" checkout --detach 7e2de11a0e3c328dddaaaefedd6e911be36fb58d
cp "$A" "$ROOT/.codegraph-wx/codegraph.db"
printf '\n// Fixed path prototype real small-increment cycle verification.\n' >> "$ROOT/src/observer/ob_server.cpp"
python3 "$ENTRY/measure.py" "$ROOT" "$EV/small-sync" node --liftoff-only "$ENTRY/worker.mjs" sync "$ROOT" "$EV/small-sync.json"
python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));assert d["completeness"]["status"]=="complete";assert d["result"]["filesModified"]==1' "$EV/small-sync.json"
git -C "$ROOT" restore src/observer/ob_server.cpp
git -C "$ROOT" checkout --detach 9bdfa9e22b618cc4ad0a724010b1bb9567629399
python3 "$ENTRY/measure.py" "$ROOT" "$EV/cached-publish" node --liftoff-only "$ENTRY/cached-cycle-publish.mjs" "$ROOT" "$B" "$EV/cached-publish.json"
for suffix in -wal -shm -journal; do [ ! -e "$ROOT/.codegraph-wx/codegraph.db$suffix" ] || exit 1; done
find "$ROOT/.codegraph-wx/.runtime" -type f -printf '%P %s\n' | sort > "$EV/runtime-before.txt"
cp "$B" "$ROOT/.codegraph-wx/codegraph.db"
find "$ROOT/.codegraph-wx/.runtime" -type f -printf '%P %s\n' | sort > "$EV/runtime-after.txt"
cmp "$EV/runtime-before.txt" "$EV/runtime-after.txt"
node --liftoff-only "$ENTRY/load.mjs" load "$ROOT" "$EV/final-query.json" idle
node --liftoff-only "$ENTRY/worker.mjs" sync "$ROOT" "$EV/final-sync.json"
python3 - "$EV" <<'PYASSERT'
import json, pathlib, sys
p=pathlib.Path(sys.argv[1])
pub=json.loads((p/'cached-publish.json').read_text()); q=json.loads((p/'final-query.json').read_text()); sync=json.loads((p/'final-sync.json').read_text())
assert pub['result']['status']=='verified-observation'
assert any(x['type']=='publish' and x['status']=='published' for x in pub['result']['outcomes'])
assert q['errors']==[] and q['pendingScheduled']==0
assert q['observedHashes']==['ea3e67daabd13368babe0ee77c99d401fea2348a8a91def514fe1eedbc6aa6b2']
assert sync['result']['complete'] and sync['result']['filesModified']==0
assert sync['completeness']['status']=='complete'
PYASSERT
printf 'DONE %s\n' "$(date -u +%FT%TZ)" > "$EV/complete.txt"
