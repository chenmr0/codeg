#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactApi, macroArtifactApi, macroSourceHash, nativeSourceHash, checkExecutable } from './rust-scan-release-lib.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let requiredKeys, requireValidated = true;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--allow-unvalidated') requireValidated = false;
  else if (args[i] === '--require' && args[i + 1] && !args[i + 1].startsWith('--')) requiredKeys = args[++i].split(',');
  else throw new Error('Usage: check-rust-scan-artifacts.mjs [--require win32-x64,linux-x64] [--allow-unvalidated]');
}
if (process.env.CODEGRAPH_PACK_ALLOW_INCOMPLETE === '1') {
  console.warn('[rust-scan] Explicit CANDIDATE packaging: not all platforms are validated. Unverified helpers remain disabled in auto mode.');
  process.exit(0);
}
const api = artifactApi(root);
// Packing verifies both platforms without needing to execute either helper.
// The standalone check remains strict; runtime auto-selection is unchanged.
const keys = requiredKeys ?? Object.keys(api.RUST_SCAN_TARGETS);
if (!requireValidated) console.log('[native] Packaging checks: verifying artifacts; target runtime validation is separate.');
for (const key of keys) {
  const spec = api.RUST_SCAN_TARGETS[key];
  if (!spec) throw new Error('Unknown release target: ' + key);
  const [platform, arch] = key.split('-');
  const binary = path.join(root, 'dist/native-scan', key, spec.executable);
  const manifest = api.checkRustScanArtifact(binary, platform, arch, undefined, requireValidated);
  if (manifest.sourceHash !== nativeSourceHash(root)) throw new Error(`Stale helper source hash: ${key}`);
  checkExecutable(fs.readFileSync(binary), platform);
  if (process.platform !== 'win32' && platform !== 'win32') fs.chmodSync(binary, 0o755);
  console.log(`[rust-scan] ${requireValidated ? 'Release' : 'Artifact'} check passed: ${key}, ${manifest.sha256}`);
}
const macroApi = macroArtifactApi(root);
for (const key of keys) {
  const spec = macroApi.RUST_MACRO_TARGETS[key];
  if (!spec) throw new Error('Unknown macro release target: ' + key);
  const [platform, arch] = key.split('-');
  const binary = path.join(root, 'dist/native-macros', key, spec.executable);
  const manifest = macroApi.checkRustMacroArtifact(binary, platform, arch, undefined, requireValidated);
  if (manifest.sourceHash !== macroSourceHash(root)) throw new Error(`Stale macro helper source hash: ${key}`);
  checkExecutable(fs.readFileSync(binary), platform);
  if (process.platform !== 'win32' && platform !== 'win32') fs.chmodSync(binary, 0o755);
  console.log(`[rust-macros] ${requireValidated ? 'Release' : 'Artifact'} check passed: ${key}, ${manifest.sha256}`);
}
