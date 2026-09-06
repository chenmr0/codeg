#!/usr/bin/env node
// Only restore Unix execute permission lost by archives built on Windows.
// No compiler, download, helper execution or package installation here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactApi } from './rust-scan-release-lib.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'linux' || process.arch !== 'x64') process.exit(0);
try {
  if (!fs.existsSync(path.join(root, 'dist/extraction/rust-scan-artifact.js'))) process.exit(0);
  const binary = path.join(root, 'dist/native-scan/linux-x64/codegraph-scan');
  if (!fs.existsSync(binary)) process.exit(0);
  artifactApi(root).checkRustScanArtifact(binary, process.platform, process.arch, undefined, false);
  fs.chmodSync(binary, 0o755);
} catch (error) {
  console.warn(`[rust-scan] Native permissions unavailable; TypeScript fallback remains available: ${error.message}`);
}

// The macro prototype is independent and remains opt-in. Restore permission
// only for the exact checked-in-layout bytes; never run it during installation.
try {
  const binary = path.join(root, 'dist/native-macros/linux-x64/codegraph-macros');
  if (fs.existsSync(binary)) {
    const api = artifactApi(root);
    const m = JSON.parse(fs.readFileSync(path.join(path.dirname(binary), 'manifest.json'), 'utf8'));
    if (m.schema !== 1 || m.protocol !== 1 || m.platform !== 'linux' || m.arch !== 'x64' ||
      m.target !== 'x86_64-unknown-linux-musl' || m.executable !== 'codegraph-macros' ||
      m.packageVersion !== api.rustScanPackageVersion() || m.profile !== 'release' || m.experimental !== true ||
      !fs.lstatSync(binary).isFile() || api.sha256(fs.readFileSync(binary)) !== m.sha256) throw new Error('macro-artifact-mismatch');
    fs.chmodSync(binary, 0o755);
  }
} catch (error) {
  console.warn(`[rust-macros] Prototype permissions unavailable; TypeScript fallback remains available: ${error.message}`);
}
