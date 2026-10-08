#!/bin/sh
# Linux x64 portable fork installer. No Node/npm/compiler required.
# Offline: sh install-portable.sh --archive bundle.tar.gz --sha256 HEX
# Online (after a maintainer publishes an audited release):
#   CODEGRAPH_VERSION=vX.Y.Z sh install-portable.sh
set -eu
fail() { echo "codegraph: $*" >&2; exit 1; }
archive= checksum=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --archive) [ "$#" -ge 2 ] || fail '--archive needs a path'; archive=$2; shift 2 ;;
    --sha256) [ "$#" -ge 2 ] || fail '--sha256 needs a digest'; checksum=$2; shift 2 ;;
    --help) echo 'Usage: sh install-portable.sh [--archive PATH --sha256 HEX]'; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done
[ "$(uname -s)" = Linux ] || fail 'this portable target supports Linux only'
case "$(uname -m)" in x86_64|amd64) ;; *) fail 'this portable target supports x86_64 only' ;; esac
target=linux-x64-glibc217
INSTALL_DIR=${CODEGRAPH_INSTALL_DIR:-"$HOME/.local/share/codegraph-wx"}
BIN_DIR=${CODEGRAPH_BIN_DIR:-"$HOME/.local/bin"}
for dir in "$INSTALL_DIR" "$BIN_DIR"; do
  case "$dir" in /*) ;; *) fail 'installation directories must be absolute paths' ;; esac
  [ "$dir" != / ] || fail 'refusing to install into /'
done
for command in tar sha256sum mktemp awk grep sed readlink mv ln; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required utility: $command"
done
# Do not replace another distribution or a real directory. Existing links owned
# by this installer are the only automatic update case.
if [ -e "$BIN_DIR/codegraph" ] || [ -L "$BIN_DIR/codegraph" ]; then
  [ -L "$BIN_DIR/codegraph" ] && [ "$(readlink "$BIN_DIR/codegraph")" = "$INSTALL_DIR/current/bin/codegraph" ] \
    || fail "existing $BIN_DIR/codegraph is not managed by this installer"
fi
if [ -e "$INSTALL_DIR/current" ] && [ ! -L "$INSTALL_DIR/current" ]; then
  fail 'current must be an installer-managed symlink'
fi
tmp=$(mktemp -d)
stage=
cleanup() { rm -rf "$tmp"; [ -z "$stage" ] || rm -rf "$stage"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ -z "$archive" ]; then
  command -v curl >/dev/null 2>&1 || fail 'online installation requires curl'
  version=${CODEGRAPH_VERSION:-}
  [ -n "$version" ] || fail 'pin CODEGRAPH_VERSION to a published fork release, or use --archive and --sha256'
  case "$version" in *[!a-zA-Z0-9._-]*|.|..) fail 'invalid release tag' ;; esac
  url="https://github.com/chenmr0/codeg/releases/download/$version/codegraph-$target.tar.gz"
  archive="$tmp/bundle.tar.gz"
  curl --proto '=https' --tlsv1.2 -fsSL "$url" -o "$archive"
  curl --proto '=https' --tlsv1.2 -fsSL "$url.sha256" -o "$tmp/checksum"
  checksum=$(awk 'NR==1 {print $1}' "$tmp/checksum")
fi
[ -f "$archive" ] || fail 'archive not found'
[ "${#checksum}" -eq 64 ] || fail 'a trusted SHA256 digest is required'
case "$checksum" in *[!0-9a-f]*) fail 'SHA256 must be lowercase hexadecimal' ;; esac
actual=$(sha256sum "$archive" | awk '{print $1}')
[ "$actual" = "$checksum" ] || fail 'archive checksum mismatch'
# Archive contents must be ordinary files/directories inside exactly one root.
# Reject links/devices and traversal before extraction, even for local archives.
tar -tzf "$archive" > "$tmp/members"
[ -s "$tmp/members" ] || fail 'empty archive'
awk -v root="codegraph-$target" '
  $0 != root && $0 != root "/" && index($0, root "/") != 1 {exit 1}
  /(^|\/)\.\.?($|\/)/ || /\\/ {exit 1}
' "$tmp/members" || fail 'unsafe archive path'
tar -tvzf "$archive" > "$tmp/types"
awk 'substr($0,1,1) != "-" && substr($0,1,1) != "d" {exit 1}' "$tmp/types" || fail 'archive links or special files are not allowed'
mkdir -p "$INSTALL_DIR/versions" "$BIN_DIR"
stage=$(mktemp -d "$INSTALL_DIR/versions/.staging.XXXXXXXX")
tar -xzf "$archive" -C "$stage" --strip-components=1 --no-same-owner --no-same-permissions
[ -x "$stage/node" ] && [ -x "$stage/bin/codegraph" ] || fail 'bundle is missing executable runtime/launcher'
# Smoke test BEFORE changing any active link; incompatible loaders leave the
# current installation intact. Run from a fresh directory, never a user project.
(cd "$tmp" && "$stage/bin/codegraph" --version) || fail 'bundled runtime/CLI smoke test failed'
dest="$INSTALL_DIR/versions/$checksum"
if [ -e "$dest" ]; then
  [ -f "$dest/.archive-sha256" ] && [ "$(cat "$dest/.archive-sha256")" = "$checksum" ] || fail 'existing version directory has no matching install receipt'
  (cd "$tmp" && "$dest/bin/codegraph" --version) || fail 'existing installation failed its smoke test'
  rm -rf "$stage"; stage=
else
  printf '%s\n' "$checksum" > "$stage/.archive-sha256"
  mv -T "$stage" "$dest"; stage=
fi
# Atomic current switch. Keep older versions for manual rollback.
link="$INSTALL_DIR/.current.$$"
ln -s "$dest" "$link"
mv -Tf "$link" "$INSTALL_DIR/current"
if [ ! -L "$BIN_DIR/codegraph" ]; then
  ln -s "$INSTALL_DIR/current/bin/codegraph" "$BIN_DIR/codegraph"
fi
echo "Installed CodeGraph: $BIN_DIR/codegraph"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "Add to PATH: $BIN_DIR" ;; esac
