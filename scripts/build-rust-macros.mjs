#!/usr/bin/env node
// Explicit publisher/developer build. Never called by npm install.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { checkExecutable } from './rust-scan-release-lib.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const specs = {
  'x86_64-pc-windows-msvc': ['win32-x64', 'codegraph-macros.exe'],
  'x86_64-unknown-linux-musl': ['linux-x64', 'codegraph-macros'],
};
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--target')) throw new Error('Usage: build-rust-macros.mjs [--target <triple>]');
const target = args[1] ?? (process.platform === 'win32' ? 'x86_64-pc-windows-msvc' : 'x86_64-unknown-linux-musl');
if (!specs[target]) throw new Error('Unsupported macro scanner target');
const [key, executable] = specs[target];
const [platform, arch] = key.split('-');
const cargo = process.env.CODEGRAPH_CARGO ?? 'cargo';
const rustc = process.env.CODEGRAPH_RUSTC ?? (path.isAbsolute(cargo)
  ? path.join(path.dirname(cargo), process.platform === 'win32' ? 'rustc.exe' : 'rustc') : 'rustc');
const env = { ...process.env };
if (/target-cpu[= ]native/.test(env.RUSTFLAGS ?? '')) throw new Error('Portable CPU baseline required');
env.RUSTFLAGS = `${env.RUSTFLAGS ?? ''} -C target-feature=+crt-static`.trim();
if (platform === 'linux') {
  const host = execFileSync(rustc, ['-vV'], { encoding: 'utf8', windowsHide: true }).match(/^host: (.+)$/m)?.[1]?.trim();
  const sysroot = execFileSync(rustc, ['--print', 'sysroot'], { encoding: 'utf8', windowsHide: true }).trim();
  env.CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER = path.join(sysroot, 'lib/rustlib', host, 'bin', process.platform === 'win32' ? 'rust-lld.exe' : 'rust-lld');
  env.RUSTFLAGS += ' -C link-self-contained=yes';
}
const build = spawnSync(cargo, ['build', '--locked', '--release', '--manifest-path', 'codegraph-macros/Cargo.toml',
  '--target', target, '--message-format=json-render-diagnostics'],
  { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
if (build.stderr) process.stderr.write(build.stderr);
if (build.error || build.status !== 0) throw new Error('Macro scanner build failed; existing helpers unchanged');
const messages = build.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
const source = messages.find(m => m.reason === 'compiler-artifact' && m.target?.name === 'codegraph-macros' && m.executable)?.executable;
if (!source) throw new Error('Cargo did not report the macro scanner');
const bytes = fs.readFileSync(source); checkExecutable(bytes, platform);
const directory = path.join(root, 'dist/native-macros', key);
fs.mkdirSync(directory, { recursive: true });
fs.copyFileSync(source, path.join(directory, executable));
if (process.platform !== 'win32') fs.chmodSync(path.join(directory, executable), 0o755);
const hash = createHash('sha256');
for (const file of ['Cargo.toml', 'Cargo.lock', 'src/main.rs']) {
  hash.update(file + '\0').update(fs.readFileSync(path.join(root, 'codegraph-macros', file), 'utf8').replace(/\r\n/g, '\n'));
}
fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ schema: 1, protocol: 1, platform, arch,
  target, executable, packageVersion: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
  sourceHash: hash.digest('hex'), sha256: createHash('sha256').update(bytes).digest('hex'), profile: 'release',
  experimental: true }, null, 2) + '\n');
console.log(`[rust-macros] Built ${key}; prototype remains opt-in. Existing directory helper untouched.`);
