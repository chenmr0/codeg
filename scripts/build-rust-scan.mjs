#!/usr/bin/env node
// Release-time compilation only. npm install never invokes Rust or downloads it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { artifactApi, nativeSourceHash, checkExecutable } from './rust-scan-release-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const api = artifactApi(root);
const cargo = process.env.CODEGRAPH_CARGO ?? 'cargo';
const rustc = process.env.CODEGRAPH_RUSTC ?? (path.isAbsolute(cargo)
  ? path.join(path.dirname(cargo), process.platform === 'win32' ? 'rustc.exe' : 'rustc') : 'rustc');
let target, debug = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--debug') debug = true;
  else if (args[i] === '--target' && args[i + 1]) target = args[++i];
  else throw new Error('Usage: build-rust-scan.mjs [--debug] [--target <Rust triple>]');
}
target ??= api.RUST_SCAN_TARGETS[`${process.platform}-${process.arch}`]?.target;
const selected = Object.entries(api.RUST_SCAN_TARGETS).find(([, spec]) => spec.target === target);
if (!selected) throw new Error(`Unsupported build target: ${target ?? process.platform + '-' + process.arch}`);
const [platformKey, spec] = selected;
const [platform, arch] = platformKey.split('-');
const env = { ...process.env };
if (/target-cpu[= ]native/.test(env.RUSTFLAGS ?? '')) throw new Error('Release helpers must use a portable CPU baseline, not target-cpu=native.');
if (platform === 'win32') env.RUSTFLAGS = `${env.RUSTFLAGS ?? ''} -C target-feature=+crt-static`.trim();
if (target.endsWith('-linux-musl')) {
  const host = execFileSync(rustc, ['-vV'], { encoding: 'utf8', windowsHide: true }).match(/^host: (.+)$/m)?.[1]?.trim();
  const sysroot = execFileSync(rustc, ['--print', 'sysroot'], { encoding: 'utf8', windowsHide: true }).trim();
  const linker = path.join(sysroot, 'lib/rustlib', host ?? '', 'bin', process.platform === 'win32' ? 'rust-lld.exe' : 'rust-lld');
  if (!fs.existsSync(linker)) throw new Error('Rust bundled LLD linker is missing; install the build toolchain, not a target-machine compiler.');
  env.CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER = linker;
  env.RUSTFLAGS = `${env.RUSTFLAGS ?? ''} -C link-self-contained=yes -C target-feature=+crt-static`.trim();
}
console.log(`[rust-scan] Building ${target}; target installation is explicit, never automatic.`);
const build = spawnSync(cargo, ['build', '--locked', '--manifest-path', path.join(root, 'codegraph-scan/Cargo.toml'),
  '--target', target, '--message-format=json-render-diagnostics', ...(debug ? [] : ['--release'])],
{ cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
if (build.stderr) process.stderr.write(build.stderr);
const messages = (build.stdout ?? '').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return {}; } });
for (const message of messages) if (message.reason === 'compiler-message' && message.message?.rendered) process.stderr.write(message.message.rendered);
if (build.error || build.status !== 0) {
  if (build.error) console.error(build.error.message);
  console.error('[rust-scan] Build failed; check Cargo diagnostics and installed target. Existing binaries were not relabeled.');
  process.exit(build.status || 1);
}
// Use Cargo's true output, not a guessed (possibly stale) host executable.
const source = messages.find(m => m.reason === 'compiler-artifact' && m.target?.name === 'codegraph-scan' && m.executable)?.executable;
if (!source || !fs.existsSync(source)) throw new Error('Cargo did not report a scanner executable');
const bytes = fs.readFileSync(source); checkExecutable(bytes, platform);
const directory = path.join(root, 'dist/native-scan', platformKey);
fs.mkdirSync(directory, { recursive: true });
const binary = path.join(directory, spec.executable);
fs.copyFileSync(source, binary); if (process.platform !== 'win32') fs.chmodSync(binary, 0o755);
const manifest = { schema: 1, protocol: api.RUST_SCAN_PROTOCOL, platform, arch, target,
  executable: spec.executable, packageVersion: api.rustScanPackageVersion(), sourceHash: nativeSourceHash(root),
  sha256: api.sha256(bytes), profile: debug ? 'debug' : 'release' };
fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`[rust-scan] Staged ${binary}; not yet auto-enabled. Validate on ${platformKey} before release.`);
