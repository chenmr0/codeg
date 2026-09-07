# C++ grammar artifact

The C++ parser is vendored from upstream `tree-sitter/tree-sitter-cpp` v0.23.4
(commit prefix `f41e1a0`). The binary is copied unchanged from the local community
CodeGraph checkout's `src/extraction/wasm/tree-sitter-cpp.wasm`.

- SHA-256: `70f5e2b9976dad56bdcd1fafcb3af8c839c7a92e7beaa437162bcf45f390e83d`
- Size: 3,434,644 bytes.
- Upstream: https://github.com/tree-sitter/tree-sitter-cpp/tree/v0.23.4
- License: MIT (see the adjacent license file).
- Community build provenance: `docs/design/ccpp-kernel-port-checklist.md` and
  `src/extraction/grammars.ts`: checked-in parser.c and scanner.c from the upstream
  tag, SHA-matched to the crate; built with tree-sitter-cli 0.25.10 `build --wasm`,
  without regenerating the parse tables. The build was not repeated in this fix.

The previous tree-sitter-wasms 0.1.13 bundle uses an old C++ grammar that parses
`a.x < 1 || a.y < 1` as template arguments and can swallow following functions.
The replacement fixes the primary parse, preserving function bodies and call
ownership, instead of inventing missing symbols with a regular expression.

Only C++ (including extensions already mapped to C++) uses this artifact; C
macro timeout workarounds and native Rust scanning are unchanged. The existing
copy-assets and npm dist packaging paths include the binary. No Rust/compiler
installation or database schema migration is required by users.

Existing indexes remain readable. Sync fixes changed files; an unchanged file
previously affected by bad parsing is not automatically re-extracted. A forced
index rebuild is needed to comprehensively repair old missing graph facts.
