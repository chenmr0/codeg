#!/usr/bin/env node
// Publisher-side builder; users install the resulting archive without npm.
// Linux x64 only. Other targets need independent runtime locks and validation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditPortableElf } from './audit-portable-elf.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'scripts/portable-runtime.json'), 'utf8'));
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Build portable Linux x64 on Linux x64; cross-host npm optional dependencies are not portable.');
if (process.env.CODEGRAPH_PACK_ALLOW_INCOMPLETE === '1') throw new Error('Portable bundles may not bypass native artifact checks.');
let runtimeArchive, prepareOnly = false;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--runtime-archive' && process.argv[i + 1]) runtimeArchive = path.resolve(process.argv[++i]);
  else if (process.argv[i] === '--prepare-only') prepareOnly = true;
  else throw new Error('Usage: node scripts/build-portable.mjs [--runtime-archive trusted-node.tar.gz] [--prepare-only]');
}
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.error?.message ?? ''}`);
};
const hash = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-portable-'));
try {
  if (!runtimeArchive) {
    runtimeArchive = path.join(work, 'node.tar.gz');
    run('curl', ['--proto', '=https', '--tlsv1.2', '-fsSL', lock.url, '-o', runtimeArchive]);
  }
  if (hash(runtimeArchive) !== lock.sha256) throw new Error('Pinned Node runtime SHA256 mismatch');
  run('tar', ['-xzf', runtimeArchive, '-C', work]);
  run('npm', ['run', 'build']);
  run(process.execPath, ['scripts/check-rust-scan-artifacts.mjs', '--require', 'linux-x64']);
  const bundleName = `codegraph-${lock.target}`;
  const stage = path.join(work, bundleName), app = path.join(stage, 'lib');
  fs.mkdirSync(path.join(stage, 'bin'), { recursive: true });
  fs.mkdirSync(app);
  fs.cpSync(path.join(root, 'dist'), path.join(app, 'dist'), { recursive: true });
  // Include native validators and source fingerprints so release smoke tests
  // can recheck both exact helpers without any compiler or external download.
  for (const name of ['scripts', 'codegraph-scan', 'codegraph-macros']) {
    fs.cpSync(path.join(root, name), path.join(app, name), { recursive: true,
      filter: filename => !['target', 'node_modules'].includes(path.basename(filename)) });
  }
  for (const name of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(root, name), path.join(app, name));
  for (const name of ['LICENSE', 'README.md']) if (fs.existsSync(path.join(root, name))) fs.copyFileSync(path.join(root, name), path.join(app, name));
  const env = { ...process.env, npm_config_cache: process.env.npm_config_cache || path.join(work, 'npm-cache') };
  // npm overrides inherited from another build must not select a foreign rg.
  for (const key of Object.keys(env)) if (/^npm_config_(arch|platform|os|cpu|omit|optional|ignore_scripts|production)$/i.test(key)) delete env[key];
  run('npm', ['ci', '--omit=dev', '--include=optional', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: app, env });
  fs.rmSync(path.join(app, 'node_modules/.bin'), { recursive: true, force: true });
  fs.copyFileSync(path.join(work, lock.archiveRoot, 'bin/node'), path.join(stage, 'node'));
  fs.chmodSync(path.join(stage, 'node'), 0o755);
  fs.copyFileSync(path.join(work, lock.archiveRoot, 'LICENSE'), path.join(stage, 'NODE-LICENSE'));
  fs.copyFileSync(path.join(root, 'scripts/portable-launcher.sh'), path.join(stage, 'bin/codegraph'));
  fs.chmodSync(path.join(stage, 'bin/codegraph'), 0o755);
  // Remove foreign helper directories; every included executable must pass the
  // same ABI audit, not merely the private Node binary.
  for (const kind of ['native-scan', 'native-macros']) {
    const directory = path.join(app, 'dist', kind);
    for (const entry of fs.readdirSync(directory)) if (entry !== 'linux-x64') fs.rmSync(path.join(directory, entry), { recursive: true });
  }
  const elf = auditPortableElf(stage, lock.maxGlibc);
  const required = ['node', 'lib/dist/native-scan/linux-x64/codegraph-scan', 'lib/dist/native-macros/linux-x64/codegraph-macros', 'lib/node_modules/@vscode/ripgrep-linux-x64/bin/rg'];
  for (const file of required) if (!elf.some(item => item.file === file)) throw new Error(`Missing ELF runtime dependency: ${file}`);
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const sourceDirty = Boolean(spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).stdout.trim());
  const manifest = { schema: 1, target: lock.target, runtime: lock, sourceCommit: commit, sourceDirty, packageVersion: JSON.parse(fs.readFileSync(path.join(app, 'package.json'))).version, elf,
    validation: { host: `${os.platform()}-${os.arch()}`, kernel: os.release(), legacyOsTested: false, runtimeTestsPassed: !prepareOnly } };
  // This executes the vendored runtime. Download provenance and permission
  // must be reviewed before a publisher invokes this build script.
  const node = path.join(stage, 'node');
  if (!prepareOnly) {
  run(node, ['-e', `if(process.version!==${JSON.stringify(lock.version)})process.exit(1); const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');db.exec('CREATE VIRTUAL TABLE t USING fts5(body)');db.close();`]);
  run(path.join(stage, 'bin/codegraph'), ['--version'], { cwd: work });
  run(node, ['--liftoff-only', path.join(app, 'scripts/validate-rust-scan.mjs')], { cwd: app });
  run(node, ['--liftoff-only', path.join(app, 'scripts/validate-rust-macros.mjs')], { cwd: app });
  }
  fs.writeFileSync(path.join(stage, 'portable-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const out = path.join(root, 'release', ...(prepareOnly ? ['candidates'] : [])); fs.mkdirSync(out, { recursive: true });
  const archive = path.join(out, `${bundleName}.tar.gz`);
  run('tar', ['-czf', archive, '-C', work, bundleName]);
  const digest = hash(archive);
  fs.writeFileSync(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`);
  fs.copyFileSync(path.join(stage, 'portable-manifest.json'), path.join(out, `${bundleName}.manifest.json`));
  console.log(`Built ${prepareOnly ? 'UNTESTED CANDIDATE ' : ''}${archive}\nSHA256 ${digest}\nLegacy OS support remains unverified until tested on that OS.`);
} finally { fs.rmSync(work, { recursive: true, force: true }); }
