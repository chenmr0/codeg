#!/bin/sh
set -eu
SELF="$0"
while [ -L "$SELF" ]; do
  target="$(readlink "$SELF")"
  case "$target" in
    /*) SELF="$target" ;;
    *) SELF="$(dirname "$SELF")/$target" ;;
  esac
done
DIR="$(CDPATH= cd -- "$(dirname "$SELF")/.." && pwd)"
# The inherited upgrade command targets the community repository. Never let a
# fork bundle silently replace itself with that unrelated distribution.
if [ "${1:-}" = upgrade ]; then
  echo 'Portable fork upgrades: run scripts/install-portable.sh with a verified new archive.' >&2
  echo 'See https://github.com/chenmr0/codeg/blob/feat/portable-installer-20261008/docs/portable-install.md' >&2
  exit 1
fi
exec "$DIR/node" --liftoff-only "$DIR/lib/dist/bin/codegraph.js" "$@"
