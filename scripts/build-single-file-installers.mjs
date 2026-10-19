#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sha256, assertChecksum } from './self-contained-lib.mjs';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const validVersion = version => {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Invalid package version');
};
const writeHash = output => fs.writeFileSync(output + '.sha256', `${sha256(output)}  ${path.basename(output)}\n`);

export function linuxRunHeader({ version, checksum, installer }) {
  validVersion(version);
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error('Invalid payload checksum');
  const body = fs.readFileSync(installer, 'utf8').replace(/\r\n/g, '\n');
  if (body.includes('__CODEGRAPH_INSTALL_SCRIPT__') || body.includes('__CODEGRAPH_PAYLOAD__')) throw new Error('Installer delimiter collision');
  return `#!/bin/sh
# CodeGraph ${version} Linux x64 offline installer.
set -eu
case "\${1:-}" in
  --help) echo 'Usage: sh codegraph-${version}-linux-x64.run [--no-path]'; exit 0 ;;
  ''|--no-path) ;;
  *) echo 'Only --no-path and --help are supported; use CODEGRAPH_INSTALL_DIR/CODEGRAPH_BIN_DIR for custom paths.' >&2; exit 1 ;;
esac
[ "\$#" -le 1 ] || exit 1
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
payload_line=$(awk '/^__CODEGRAPH_PAYLOAD__$/ {print NR + 1; exit}' "$0")
[ -n "$payload_line" ] || { echo 'Missing embedded payload' >&2; exit 1; }
tail -n +"$payload_line" "$0" > "$tmp/bundle.tar.gz"
actual=$(sha256sum "$tmp/bundle.tar.gz" | awk '{print $1}')
[ "$actual" = '${checksum}' ] || { echo 'Embedded payload checksum mismatch' >&2; exit 1; }
cat > "$tmp/install.sh" <<'__CODEGRAPH_INSTALL_SCRIPT__'
${body}
__CODEGRAPH_INSTALL_SCRIPT__
sh "$tmp/install.sh" --archive "$tmp/bundle.tar.gz" --sha256 '${checksum}' --version '${version}' "$@"
exit 0
__CODEGRAPH_PAYLOAD__
`;
}

export function buildLinuxInstaller({ archive, output, installer, version, checksum }) {
  assertChecksum(archive, checksum);
  const header = linuxRunHeader({ version, checksum, installer });
  fs.writeFileSync(output, header);
  fs.appendFileSync(output, fs.readFileSync(archive));
  fs.chmodSync(output, 0o755);
  writeHash(output);
}

export function windowsEntry({ version, checksum }) {
  validVersion(version);
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error('Invalid payload checksum');
  return `param([switch]$Quiet)
$ErrorActionPreference = 'Stop'
$result = 0
try { $Host.UI.RawUI.WindowTitle = if ($env:CODEGRAPH_INSTALL_WINDOW_TITLE) { $env:CODEGRAPH_INSTALL_WINDOW_TITLE } else { 'CodeGraph installer' } } catch {}
try {
  Write-Host 'Installing CodeGraph ${version} (offline)...'
  & (Join-Path $PSScriptRoot 'install.ps1') -Archive (Join-Path $PSScriptRoot 'payload.zip') -Sha256 '${checksum}' -Version '${version}'
  Write-Host 'Installation completed. Open a new terminal and run: codegraph --version'
} catch {
  $result = 1
  Write-Host ('Installation failed: ' + $_.Exception.Message) -ForegroundColor Red
  Write-Host 'An existing active version has not been replaced if candidate verification failed.'
}
# Optional result file is used only by isolated automated smoke tests.
if ($env:CODEGRAPH_INSTALL_RESULT_FILE) {
  [IO.File]::WriteAllText($env:CODEGRAPH_INSTALL_RESULT_FILE, [string]$result)
}
if (!$Quiet) { Write-Host 'Press Enter to close'; [void](Read-Host) }
exit $result
`.replace(/\r?\n/g, '\r\n');
}

export function windowsSed(directory) {
  // IExpress uses 0=Default, 1=Hidden; these are NOT Win32 SW_* constants.
  // All payload names are fixed ASCII basenames. SED paths are quoted; avoid
  // directives being interpreted through an unrepresentable newline/quote.
  if (/[\r\n"]/.test(directory)) throw new Error('Unsupported IExpress staging path');
  return `[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=0
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=%InstallPrompt%
DisplayLicense=%DisplayLicense%
FinishMessage=%FinishMessage%
TargetName=%TargetName%
FriendlyName=%FriendlyName%
AppLaunched=%AppLaunched%
PostInstallCmd=%PostInstallCmd%
AdminQuietInstCmd=%AdminQuietInstCmd%
UserQuietInstCmd=%UserQuietInstCmd%
SourceFiles=SourceFiles
[Strings]
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=${path.join(directory, 'installer.exe')}
FriendlyName=CodeGraph offline installer
AppLaunched=cmd.exe /d /c setup.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=cmd.exe /d /c setup.cmd -Quiet
UserQuietInstCmd=cmd.exe /d /c setup.cmd -Quiet
FILE0="payload.zip"
FILE1="install.ps1"
FILE2="entry.ps1"
FILE3="setup.cmd"
[SourceFiles]
SourceFiles0=${directory}${path.sep}
[SourceFiles0]
%FILE0%=
%FILE1%=
%FILE2%=
%FILE3%=
`.replace(/\r?\n/g, '\r\n');
}

export function buildWindowsInstaller({ archive, output, installer, version, checksum }) {
  if (process.platform !== 'win32') throw new Error('Build the EXE on Windows with IExpress');
  assertChecksum(archive, checksum);
  const iexpress = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/iexpress.exe');
  if (!fs.existsSync(iexpress)) throw new Error('Windows IExpress is required for EXE packaging');
  const parent = fs.realpathSync(os.tmpdir());
  const temp = fs.mkdtempSync(path.join(parent, 'cg-sfx-'));
  let succeeded = false;
  try {
    fs.copyFileSync(archive, path.join(temp, 'payload.zip'));
    fs.copyFileSync(installer, path.join(temp, 'install.ps1'));
    fs.writeFileSync(path.join(temp, 'entry.ps1'), windowsEntry({ version, checksum }), 'utf8');
    fs.writeFileSync(path.join(temp, 'setup.cmd'), '@echo off\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0entry.ps1" %*\r\nexit /b %errorlevel%\r\n', 'ascii');
    const sed = path.join(temp, 'package.sed');
    fs.writeFileSync(sed, windowsSed(temp));
    const result = spawnSync(iexpress, ['/N', '/Q', sed], { cwd: temp, windowsHide: true,
      encoding: 'utf8', timeout: 300000, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(`IExpress failed: ${result.error?.message || result.stderr || result.status}`);
    const exe = path.join(temp, 'installer.exe');
    if (!fs.existsSync(exe) || fs.statSync(exe).size < 1024 || fs.readFileSync(exe).toString('ascii', 0, 2) !== 'MZ') throw new Error('IExpress did not produce a valid executable');
    fs.copyFileSync(exe, output);
    writeHash(output);
    succeeded = true;
  } finally {
    if (succeeded && path.dirname(temp) === parent && path.basename(temp).startsWith('cg-sfx-')) fs.rmSync(temp, { recursive: true });
    else console.error(`IExpress diagnostic files retained: ${temp}`);
  }
}

export function buildSingleFileInstaller({ archive, outputDir, target, version }) {
  const checksum = fs.readFileSync(archive + '.sha256', 'utf8').trim().split(/\s+/)[0];
  const windows = target === 'win32-x64';
  if (!windows && target !== 'linux-x64') throw new Error('Unsupported installer target');
  const output = path.join(outputDir, `codegraph-${version}-${target}${windows ? '.exe' : '.run'}`);
  const args = { archive, output, version, checksum,
    installer: path.join(scripts, `install-self-contained.${windows ? 'ps1' : 'sh'}`) };
  if (windows) buildWindowsInstaller(args); else buildLinuxInstaller(args);
  console.log(`Created single-file installer: ${output}`);
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = { 'bundle-dir': path.resolve(scripts, '../release/self-contained'), target: 'all',
    version: JSON.parse(fs.readFileSync(path.resolve(scripts, '../package.json'))).version };
  for (let i = 2; i < process.argv.length; i++) {
    const key = process.argv[i].replace(/^--/, '');
    if (!(key in options) || !process.argv[i + 1]) throw new Error('Usage: node scripts/build-single-file-installers.mjs [--bundle-dir DIR] [--target all|win32-x64|linux-x64] [--version VERSION]');
    options[key] = process.argv[++i];
  }
  if (!['all', 'win32-x64', 'linux-x64'].includes(options.target)) throw new Error('Unsupported target');
  for (const target of options.target === 'all' ? ['win32-x64', 'linux-x64'] : [options.target]) {
    buildSingleFileInstaller({ target, version: options.version, outputDir: path.resolve(options['bundle-dir']),
      archive: path.resolve(options['bundle-dir'], `codegraph-${options.version}-${target}${target === 'win32-x64' ? '.zip' : '.tar.gz'}`) });
  }
}
