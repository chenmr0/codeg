#!/bin/sh
# Actual Linux smoke test. All HOME/PATH changes stay inside a temporary fixture.
set -eu
[ "$(uname -s)" = Linux ] || { echo 'Run this test on Linux' >&2; exit 1; }
archive=$(readlink -f "$1")
fixture=$(mktemp -d /tmp/codegraph-single-file.XXXXXXXX)
trap 'rm -rf "$fixture"' EXIT
export HOME="$fixture/home"
export SHELL=/bin/bash
export PATH=/usr/bin:/bin
export CODEGRAPH_INSTALL_DIR="$fixture/install 中文 with spaces"
export CODEGRAPH_BIN_DIR="$fixture/bin with spaces"
unset CODEGRAPH_ARCHIVE CODEGRAPH_SHA256 CODEGRAPH_UPDATE_PATH
mkdir -p "$HOME"
for tool in node npm cargo rustc; do
  if command -v "$tool" >/dev/null 2>&1; then echo "Note: $tool is present; installation must still use bundled Node."; fi
done
sh "$archive"
[ "$("$CODEGRAPH_BIN_DIR/codegraph" --version)" = 1.1.2 ]
first=$(readlink "$CODEGRAPH_INSTALL_DIR/current")
grep -q 'codegraph-wx-self-contained' "$HOME/.profile"
sh "$archive"
[ "$(readlink "$CODEGRAPH_INSTALL_DIR/current")" = "$first" ]
[ "$(grep -c codegraph-wx-self-contained "$HOME/.profile")" = 1 ]
cp "$archive" "$fixture/corrupt.run"
printf 'tampered' >> "$fixture/corrupt.run"
if sh "$fixture/corrupt.run" > "$fixture/failure.log" 2>&1; then echo 'Corrupted payload was accepted'; exit 1; fi
grep -q 'checksum mismatch' "$fixture/failure.log"
[ "$(readlink "$CODEGRAPH_INSTALL_DIR/current")" = "$first" ]
[ "$("$CODEGRAPH_BIN_DIR/codegraph" --version)" = 1.1.2 ]
echo 'PASS: Linux .run installation, native verification, repeat install, isolated PATH, corruption rejection, active-version preservation.'
