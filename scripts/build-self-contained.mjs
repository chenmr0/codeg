#!/usr/bin/env node
// Separate release path: never changes package.json, dist or npm pack hooks.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { buildSingleFileInstaller } from './build-single-file-installers.mjs';
import { targets, cleanEnv, targetInstallArgs, sha256, assertChecksum,
  auditDependencies, auditPayload, checkTargetExecutable, gzipPortableTar } from './self-contained-lib.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(scriptDir);
const options = { ref: 'HEAD', target: 'all', 'prebuilt-dir': path.join(root, 'dist'),
  'output-dir': path.join(root, 'release/self-contained'), 'cache-dir': path.join(root, 'release/self-contained-cache'),
  'npm-cli': process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js') };
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].replace(/^--/, '');
  if (key === 'help') {
    console.log('node scripts/build-self-contained.mjs [--ref HEAD] [--target all|win32-x64|linux-x64] [--prebuilt-dir DIR] [--output-dir DIR] [--cache-dir DIR] [--npm-cli FILE] [--offline]');
    process.exit(0);
  }
  if (key === 'offline') { options.offline = true; continue; }
  if (!(key in options) || !process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw new Error(`Invalid option: ${process.argv[i]}`);
  options[key] = process.argv[++i];
}
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This builder requires Windows x64. Use build:portable for the existing Linux workflow.');
if (![22, 24].includes(Number(process.versions.node.split('.')[0]))) throw new Error('Build with Node 22 or 24 and npm >= 10.');
if (!['all', ...targets].includes(options.target)) throw new Error('Unsupported target');
for (const key of ['prebuilt-dir', 'output-dir', 'cache-dir', 'npm-cli']) options[key] = path.resolve(options[key]);
if (!fs.existsSync(options['npm-cli'])) throw new Error('Cannot locate npm-cli.js. Use the PowerShell wrapper or --npm-cli.');
const env = cleanEnv();
const run = (command, args, cwd = root, capture = false) => {
  const r = spawnSync(command, args, { cwd, env, encoding: 'utf8', windowsHide: true,
    stdio: capture ? 'pipe' : 'inherit', maxBuffer: 16 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`${command} ${args[0]} failed: ${r.error?.message || r.stderr || r.status}`);
  return r.stdout?.trim();
};
const npm = (args, cwd, capture = false) => run(process.execPath, [options['npm-cli'], ...args,
  '--cache', path.join(options['cache-dir'], 'npm'), ...(options.offline ? ['--offline'] : [])], cwd, capture);
const npmVersion = run(process.execPath, [options['npm-cli'], '--version'], root, true);
if (Number(npmVersion.split('.')[0]) < 10) throw new Error('npm >= 10 is required for explicit target platform installation.');
const commit = run('git', ['rev-parse', '--verify', `${options.ref}^{commit}`], root, true);
const lock = JSON.parse(fs.readFileSync(path.join(scriptDir, 'self-contained-runtimes.json')));
const selected = options.target === 'all' ? targets : [options.target];
fs.mkdirSync(options['output-dir'], { recursive: true });
fs.mkdirSync(options['cache-dir'], { recursive: true });
const work = fs.mkdtempSync(path.join(options['cache-dir'], 'build-'));
console.log(`Source commit: ${commit}; work: ${work}`);
const fetchRuntime = async spec => {
  const file = path.join(options['cache-dir'], spec.archive);
  if (fs.existsSync(file)) { assertChecksum(file, spec.sha256); return file; }
  if (options.offline) throw new Error(`Offline runtime missing: ${file}`);
  const url = `https://nodejs.org/dist/${lock.version}/${spec.archive}`;
  console.log(`Downloading ${url}`);
  const partial = path.join(work, spec.archive + '.partial');
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok || !response.body) throw new Error(`Runtime download failed: ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial));
  assertChecksum(partial, spec.sha256);
  fs.renameSync(partial, file);
  return file;
};
let success = false;
try {
  const source = path.join(work, 'source');
  fs.mkdirSync(source);
  run('git', ['archive', '--format=tar', `--output=${path.join(work, 'source.tar')}`, commit]);
  run('tar', ['-xf', path.join(work, 'source.tar'), '-C', source]);
  // Build only the committed snapshot; no stale dist or unrelated untracked TS.
  npm(['ci', '--include=dev', '--include=optional', '--ignore-scripts', '--no-audit', '--no-fund'], source);
  npm(['run', 'build'], source);
  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
  for (const target of selected) {
    for (const kind of ['scan', 'macros']) {
      const input = path.join(options['prebuilt-dir'], `native-${kind}`, target);
      if (!fs.existsSync(input)) throw new Error(`Missing prebuilt directory: ${input}. Obtain matching CI artifacts; no Rust is invoked here.`);
      fs.cpSync(input, path.join(source, `dist/native-${kind}`, target), { recursive: true });
    }
    run(process.execPath, ['scripts/check-rust-scan-artifacts.mjs', '--require', target, '--allow-unvalidated'], source);
  }
  for (const target of selected) {
    const spec = lock.targets[target];
    const runtimeArchive = await fetchRuntime(spec);
    const runtimeDir = path.join(work, `runtime-${target}`);
    fs.mkdirSync(runtimeDir);
    // Extract just the executable and license: no foreign npm symlinks on Windows.
    const archiveRoot = spec.archive.replace(/\.zip$|\.tar\.gz$/, '');
    const nodeEntry = target === 'win32-x64' ? 'node.exe' : 'bin/node';
    run('tar', ['-xf', runtimeArchive, '-C', runtimeDir, `${archiveRoot}/${nodeEntry}`, `${archiveRoot}/LICENSE`]);
    const name = `codegraph-${pkg.version}-${target}`;
    const stage = path.join(work, name), app = path.join(stage, 'lib');
    fs.mkdirSync(path.join(stage, 'bin'), { recursive: true });
    fs.mkdirSync(app);
    for (const dir of ['dist', 'scripts', 'codegraph-scan', 'codegraph-macros']) {
      fs.cpSync(path.join(source, dir), path.join(app, dir), { recursive: true });
    }
    for (const kind of ['scan', 'macros']) {
      const dir = path.join(app, `dist/native-${kind}`);
      for (const entry of fs.readdirSync(dir)) if (entry !== target) fs.rmSync(path.join(dir, entry), { recursive: true });
    }
    for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(source, file), path.join(app, file));
    for (const file of ['LICENSE', 'README.md']) if (fs.existsSync(path.join(source, file))) fs.copyFileSync(path.join(source, file), path.join(stage, file));
    // Verifier lives beside existing validation scripts and has no dependencies.
    for (const file of ['verify-self-contained.mjs', 'self-contained-lib.mjs']) fs.copyFileSync(path.join(scriptDir, file), path.join(app, 'scripts', file));
    npm(targetInstallArgs(target), app);
    const binLinks = path.join(app, 'node_modules/.bin');
    if (fs.existsSync(binLinks)) fs.rmSync(binLinks, { recursive: true });
    const rg = auditDependencies(app, target);
    const nodeName = target === 'win32-x64' ? 'node.exe' : 'node';
    fs.copyFileSync(path.join(runtimeDir, archiveRoot, nodeEntry), path.join(stage, nodeName));
    fs.copyFileSync(path.join(runtimeDir, archiveRoot, 'LICENSE'), path.join(stage, 'NODE-LICENSE'));
    checkTargetExecutable(path.join(stage, nodeName), target);
    if (target === 'win32-x64') {
      fs.writeFileSync(path.join(stage, 'bin/codegraph.cmd'), '@echo off\r\nif /I "%~1"=="upgrade" (echo Replace this bundle to upgrade. & exit /b 1)\r\n"%~dp0..\\node.exe" --liftoff-only "%~dp0..\\lib\\dist\\bin\\codegraph.js" %*\r\nexit /b %errorlevel%\r\n');
      fs.writeFileSync(path.join(stage, 'bin/verify.cmd'), '@echo off\r\n"%~dp0..\\node.exe" --liftoff-only "%~dp0..\\lib\\scripts\\verify-self-contained.mjs"\r\nexit /b %errorlevel%\r\n');
    } else {
      fs.writeFileSync(path.join(app, 'scripts/install-self-contained.sh'), fs.readFileSync(path.join(scriptDir, 'install-self-contained.sh'), 'utf8').replace(/\r\n/g, '\n'));
      fs.writeFileSync(path.join(stage, 'install.sh'), `#!/bin/sh\nset -eu\nDIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"\nexec sh "$DIR/lib/scripts/install-self-contained.sh" --version '${pkg.version}' --directory "$DIR" "$@"\n`);
      fs.copyFileSync(path.join(source, 'scripts/portable-launcher.sh'), path.join(stage, 'bin/codegraph'));
      // New bundles upgrade by replacement, not the inherited external installer.
      let launcher = fs.readFileSync(path.join(stage, 'bin/codegraph'), 'utf8').replace(/echo 'Portable fork upgrades:.*'/, "echo 'Replace this self-contained bundle to upgrade.'").replace(/^  echo 'See https:.*\n/m, '');
      fs.writeFileSync(path.join(stage, 'bin/codegraph'), launcher.replace(/\r\n/g, '\n'));
      fs.writeFileSync(path.join(stage, 'bin/verify'), '#!/bin/sh\nset -eu\nDIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"\nexec "$DIR/node" --liftoff-only "$DIR/lib/scripts/verify-self-contained.mjs"\n');
    }
    const readme = `CodeGraph ${pkg.version} (${target})\nSource: ${commit}\n\nExtract into a writable directory. Run bin/verify${target === 'win32-x64' ? '.cmd' : ''} once on the target OS, then bin/codegraph${target === 'win32-x64' ? '.cmd' : ''} --help. No Node/npm/Rust installation or network access is required at runtime. Add this bin directory to PATH or use its absolute path. Upgrade by replacing the bundle; do not use codegraph upgrade.\n\nLinux: official Node runtime; x64 glibc distribution only, not Alpine/musl or the older-glibc portable variant. Windows build does not certify Linux runtime compatibility.\n`;
    fs.writeFileSync(path.join(stage, 'BUNDLE-README.txt'), readme + (target === 'linux-x64'
      ? `\nOne-line local install (only this archive is needed):\ntar -xzf ${name}.tar.gz && sh ${name}/install.sh\nInstallation runs offline verification, activates a versioned copy and configures user PATH. Open a new terminal afterward.\n` : ''));
    // Validation stamps are writable metadata; actual binary bytes stay hashed.
    const files = auditPayload(stage, target).filter(x => !/^lib\/dist\/native-(scan|macros)\/[^/]+\/manifest\.json$/.test(x.file));
    const manifest = { schema: 1, target, packageVersion: pkg.version, sourceCommit: commit,
      runtime: { version: lock.version, archive: spec.archive, sha256: spec.sha256, source: lock.source },
      validation: { builtOn: `${process.platform}-${process.arch}`, targetRuntimePassed: false }, files };
    const manifestFile = path.join(stage, 'bundle-manifest.json');
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
    if (target === `${process.platform}-${process.arch}`) {
      run(path.join(stage, nodeName), ['--liftoff-only', path.join(app, 'scripts/verify-self-contained.mjs')], stage);
      manifest.validation.targetRuntimePassed = true;
      fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
    }
    const extension = target === 'win32-x64' ? '.zip' : '.tar.gz';
    const archive = path.join(work, name + extension);
    if (target === 'win32-x64') run('tar', ['-a', '-cf', archive, '-C', work, name]);
    else {
      const rawTar = path.join(work, name + '.tar');
      run('tar', ['--format=ustar', '-cf', rawTar, '-C', work, name]);
      const executableFiles = ['node', 'install.sh', 'bin/codegraph', 'bin/verify',
        'lib/dist/native-scan/linux-x64/codegraph-scan', 'lib/dist/native-macros/linux-x64/codegraph-macros',
        path.relative(stage, rg).split(path.sep).join('/')];
      gzipPortableTar(rawTar, archive, new Set(executableFiles.map(x => `${name}/${x}`)));
    }
    const output = path.join(options['output-dir'], path.basename(archive));
    fs.copyFileSync(archive, output);
    fs.writeFileSync(output + '.sha256', `${sha256(output)}  ${path.basename(output)}\n`);
    fs.copyFileSync(manifestFile, output + '.manifest.json');
    console.log(`Created ${output}; target runtime validated: ${manifest.validation.targetRuntimePassed}`);
    buildSingleFileInstaller({ archive: output, outputDir: options['output-dir'], target, version: pkg.version });
  }
  // Distribute installers beside the archives; existing npm pack stays separate.
  for (const file of ['install-self-contained.ps1', 'install-self-contained.sh']) {
    if (file.endsWith('.sh')) fs.writeFileSync(path.join(options['output-dir'], file), fs.readFileSync(path.join(scriptDir, file), 'utf8').replace(/\r\n/g, '\n'));
    else fs.copyFileSync(path.join(scriptDir, file), path.join(options['output-dir'], file));
  }
  success = true;
} finally {
  // Delete only this invocation's generated directory; retain failures for diagnosis.
  if (success && path.dirname(work) === options['cache-dir'] && path.basename(work).startsWith('build-')) fs.rmSync(work, { recursive: true });
  else console.error(`Build files retained for diagnosis: ${work}`);
}
