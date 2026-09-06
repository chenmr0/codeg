#!/usr/bin/env node
// Explicit build only. Normal npm install/build never installs Rust or downloads
// a scanner binary. No cross-target library is silently labeled as the host.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const crate = path.join(root, 'codegraph-scan');
const cargo = process.env.CODEGRAPH_CARGO ?? 'cargo';
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--debug')) throw new Error('Usage: node scripts/build-rust-scan.mjs [--debug]');
const debug = args.includes('--debug');
const build = spawnSync(cargo, ['build', '--manifest-path', path.join(crate, 'Cargo.toml'),
  ...(debug ? [] : ['--release'])], { cwd: root, stdio: 'inherit', windowsHide: true });
if (build.error || build.status !== 0) {
  console.error(build.error
    ? '[rust-scan] Could not start Cargo. Install a host Rust toolchain or set CODEGRAPH_CARGO to its cargo executable.'
    : '[rust-scan] Cargo build failed; see the compiler or linker diagnostics above.');
  process.exit(build.status || 1);
}
const name = process.platform === 'win32' ? 'codegraph-scan.exe' : 'codegraph-scan';
const target = process.env.CARGO_TARGET_DIR ? path.resolve(root, process.env.CARGO_TARGET_DIR) : path.join(crate, 'target');
const source = path.join(target, debug ? 'debug' : 'release', name);
const destination = path.join(root, 'dist', 'native-scan', `${process.platform}-${process.arch}`, name);
if (!fs.existsSync(source)) throw new Error(`Host executable not found at ${source}; cross-target staging is not supported by this prototype script.`);
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.copyFileSync(source, destination);
if (process.platform !== 'win32') fs.chmodSync(destination, 0o755);
console.log(`[rust-scan] Staged ${destination}`);
