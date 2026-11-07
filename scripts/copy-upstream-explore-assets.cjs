const fs = require('node:fs');
fs.cpSync('src/upstream-explore/extraction/wasm', 'dist/upstream-explore/extraction/wasm', { recursive: true });
fs.copyFileSync('src/upstream-explore/UPSTREAM_LICENSE', 'dist/upstream-explore/UPSTREAM_LICENSE');
