#!/usr/bin/env node
// Only restore Unix execute permission lost by archives built on Windows.
// No compiler, download, helper execution or package installation here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactApi, macroArtifactApi } from './rust-scan-release-lib.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'linux' || process.arch !== 'x64') process.exit(0);
try {
  const binary = path.join(root, 'dist/native-scan/linux-x64/codegraph-scan');
  if (fs.existsSync(binary)) {
    artifactApi(root).checkRustScanArtifact(binary, process.platform, process.arch, undefined, false);
    fs.chmodSync(binary, 0o755);
  }
} catch (error) {
  console.warn(`[rust-scan] Native permissions unavailable; TypeScript fallback remains available: ${error.message}`);
}

// Restore permission only after validating the macro artifact metadata and
// exact bytes. Installation never runs the helper or a compiler.
try {
  const binary = path.join(root, 'dist/native-macros/linux-x64/codegraph-macros');
  if (fs.existsSync(binary)) {
    macroArtifactApi(root).checkRustMacroArtifact(binary, 'linux', 'x64', undefined, false);
    fs.chmodSync(binary, 0o755);
  }
} catch (error) {
  console.warn(`[rust-macros] Native permissions unavailable; TypeScript fallback remains available: ${error.message}`);
}
