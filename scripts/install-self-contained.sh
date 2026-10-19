#!/bin/sh
# Fork self-contained installer: Linux x64 only. No Node/npm/Rust needed.
set -eu
fail() { echo "codegraph: $*" >&2; exit 1; }
archive=${CODEGRAPH_ARCHIVE:-}
checksum=${CODEGRAPH_SHA256:-}
directory=
version=${CODEGRAPH_VERSION:-1.1.2}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --archive) [ "$#" -ge 2 ] || fail '--archive requires a path'; archive=$2; shift 2 ;;
    --directory) [ "$#" -ge 2 ] || fail '--directory requires a path'; directory=$2; archive=; checksum=; shift 2 ;;
    --sha256) [ "$#" -ge 2 ] || fail '--sha256 requires a digest'; checksum=$2; shift 2 ;;
    --version) [ "$#" -ge 2 ] || fail '--version requires a version'; version=$2; shift 2 ;;
    --no-path) CODEGRAPH_UPDATE_PATH=0; shift ;;
    --help) echo 'Usage: sh install-self-contained.sh [--archive PATH | --directory DIR] [--sha256 HEX] [--version 1.1.2] [--no-path]'; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done
[ "$(uname -s)" = Linux ] || fail 'only Linux x64 is packaged; macOS is not supported'
case "$(uname -m)" in x86_64|amd64) ;; *) fail 'only Linux x64 is packaged' ;; esac
version=${version#v}
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$' || fail 'invalid package version'
tag=${CODEGRAPH_RELEASE_TAG:-v$version}
case "$tag" in ''|*[!a-zA-Z0-9._-]*|.|..) fail 'invalid release tag' ;; esac
INSTALL_DIR=${CODEGRAPH_INSTALL_DIR:-"$HOME/.local/share/codegraph-wx-self-contained"}
BIN_DIR=${CODEGRAPH_BIN_DIR:-"$HOME/.local/bin"}
for dir in "$INSTALL_DIR" "$BIN_DIR"; do
  case "$dir" in /*) ;; *) fail 'installation directories must be absolute' ;; esac
  case "$dir" in /|*'
'*) fail 'invalid installation path' ;; esac
done
for utility in tar sha256sum mktemp awk grep readlink mv ln sed; do
  command -v "$utility" >/dev/null 2>&1 || fail "missing utility: $utility"
done
owner=codegraph-wx-self-contained-v1
if [ -e "$INSTALL_DIR" ] || [ -L "$INSTALL_DIR" ]; then
  [ ! -L "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/.installer-owner" ] && [ "$(cat "$INSTALL_DIR/.installer-owner")" = "$owner" ] || fail 'installation directory is not managed by this installer'
fi
[ ! -L "$INSTALL_DIR/versions" ] || fail 'versions must not be a symlink'
if [ -e "$BIN_DIR/codegraph" ] || [ -L "$BIN_DIR/codegraph" ]; then
  [ -L "$BIN_DIR/codegraph" ] && [ "$(readlink "$BIN_DIR/codegraph")" = "$INSTALL_DIR/current/bin/codegraph" ] || fail 'existing codegraph command is not managed by this installer; set CODEGRAPH_BIN_DIR'
fi
if [ -e "$INSTALL_DIR/current" ] && [ ! -L "$INSTALL_DIR/current" ]; then fail 'current must be a managed symlink'; fi
tmp=$(mktemp -d)
stage=
cleanup() { rm -rf "$tmp"; [ -z "$stage" ] || rm -rf "$stage"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
prefix="codegraph-$version-linux-x64"
if [ -n "$directory" ]; then
  # Bundled install.sh installs an already-unpacked local payload. Reuse the
  # archive path checks and staged verification; no companion file or network.
  directory=$(CDPATH= cd -- "$directory" && pwd -P) || fail 'bundle directory not found'
  [ "${directory##*/}" = "$prefix" ] || fail "expected bundle directory named $prefix"
  [ -f "$directory/bundle-manifest.json" ] || fail 'bundle manifest missing'
  archive="$tmp/local-bundle.tar.gz"
  tar -czf "$archive" -C "${directory%/*}" "$prefix"
  # This digest identifies the local snapshot; manifest verification below
  # checks packaged bytes. It is not an independent publisher signature.
  checksum=$(sha256sum "$archive" | awk '{print $1}')
elif [ -z "$archive" ]; then
  command -v curl >/dev/null 2>&1 || fail 'online installation requires curl'
  url="https://github.com/chenmr0/codeg/releases/download/$tag/codegraph-$version-linux-x64.tar.gz"
  archive="$tmp/bundle.tar.gz"
  curl --proto '=https' --tlsv1.2 -fsSL "$url" -o "$archive"
  curl --proto '=https' --tlsv1.2 -fsSL "$url.sha256" -o "$tmp/checksum"
  checksum=$(awk 'NR==1 {print $1}' "$tmp/checksum")
elif [ -z "$checksum" ] && [ -f "$archive.sha256" ]; then
  checksum=$(awk 'NR==1 {print $1}' "$archive.sha256")
fi
[ -f "$archive" ] || fail 'archive not found'
[ "${#checksum}" -eq 64 ] || fail 'provide trusted SHA256 or archive.sha256 companion file'
case "$checksum" in *[!0-9a-f]*) fail 'SHA256 must be lowercase hex' ;; esac
[ "$(sha256sum "$archive" | awk '{print $1}')" = "$checksum" ] || fail 'archive checksum mismatch'
tar -tzf "$archive" > "$tmp/members"
[ -s "$tmp/members" ] || fail 'empty archive'
awk -v root="$prefix" '
  $0 != root && $0 != root "/" && index($0, root "/") != 1 {exit 1}
  /(^|\/)\.\.?($|\/)/ || /\\/ || /[[:cntrl:]]/ {exit 1}
' "$tmp/members" || fail 'unsafe archive path'
tar -tvzf "$archive" > "$tmp/types"
awk 'substr($0,1,1) != "-" && substr($0,1,1) != "d" {exit 1}' "$tmp/types" || fail 'links or special files are not allowed'
mkdir -p "$INSTALL_DIR/versions" "$BIN_DIR"
printf '%s\n' "$owner" > "$INSTALL_DIR/.installer-owner"
stage=$(mktemp -d "$INSTALL_DIR/versions/.staging.XXXXXXXX")
tar -xzf "$archive" -C "$stage" --strip-components=1 --no-same-owner --no-same-permissions
verify() {
  [ -x "$1/node" ] && [ -x "$1/bin/verify" ] || fail 'missing runtime/verifier'
  (cd "$tmp" && "$1/node" -e 'const m=require(process.argv[1]);if(m.target!=="linux-x64"||m.packageVersion!==process.argv[2])process.exit(1)' "$1/bundle-manifest.json" "$version") || fail 'bundle version/platform mismatch'
  (cd "$tmp" && "$1/bin/verify") || fail 'target verification failed; active installation unchanged'
}
verify "$stage"
dest="$INSTALL_DIR/versions/$checksum"
if [ -e "$dest" ] || [ -L "$dest" ]; then
  [ ! -L "$dest" ] && [ -f "$dest/.archive-sha256" ] && [ "$(cat "$dest/.archive-sha256")" = "$checksum" ] || fail 'existing version has no matching install receipt'
  verify "$dest"
  rm -rf "$stage"; stage=
else
  printf '%s\n' "$checksum" > "$stage/.archive-sha256"
  mv -T "$stage" "$dest"; stage=
fi
link="$INSTALL_DIR/.current.$$"
ln -s "$dest" "$link"
mv -Tf "$link" "$INSTALL_DIR/current"
if [ ! -L "$BIN_DIR/codegraph" ]; then ln -s "$INSTALL_DIR/current/bin/codegraph" "$BIN_DIR/codegraph"; fi
if [ "${CODEGRAPH_UPDATE_PATH:-1}" != 0 ]; then
  # Escape a literal single quote without evaluating the user's chosen path.
  escaped=$(printf '%s' "$BIN_DIR" | sed "s/'/'\\\\''/g")
  pathline="export PATH='$escaped':\"\$PATH\" # codegraph-wx-self-contained"
  add_path() { if ! grep -Fqx "$pathline" "$1" 2>/dev/null; then printf '\n%s\n' "$pathline" >> "$1"; fi; }
  add_path "$HOME/.profile"
  case "${SHELL:-}" in */bash) add_path "$HOME/.bashrc" ;; */zsh) add_path "${ZDOTDIR:-$HOME}/.zshrc" ;; esac
fi
echo "Installed CodeGraph $version: $BIN_DIR/codegraph"
echo "Open a new terminal, or run: $BIN_DIR/codegraph --version"
