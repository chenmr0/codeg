import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildLinuxInstaller, buildWindowsInstaller, windowsEntry, windowsSed } from './build-single-file-installers.mjs';
import { sha256 } from './self-contained-lib.mjs';
const scripts = path.dirname(fileURLToPath(import.meta.url));
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sfx-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('RUN embeds exact bytes and refuses a bad input checksum', t => {
  const dir = fixture(t), archive = path.join(dir, 'payload'), output = path.join(dir, 'test.run');
  const installer = path.join(dir, 'install.sh');
  fs.writeFileSync(installer, '#!/bin/sh\nexit 0\n');
  fs.writeFileSync(archive, Buffer.from([0, 10, 255, 12, 200]));
  const args = { archive, output, installer, version: '1.1.2', checksum: sha256(archive) };
  buildLinuxInstaller(args);
  const bytes = fs.readFileSync(output), marker = Buffer.from('\n__CODEGRAPH_PAYLOAD__\n');
  assert.deepEqual(bytes.subarray(bytes.indexOf(marker) + marker.length), fs.readFileSync(archive));
  assert.ok(bytes.toString().includes(args.checksum));
  assert.match(fs.readFileSync(output + '.sha256', 'utf8'), new RegExp(sha256(output)));
  assert.throws(() => buildLinuxInstaller({ ...args, checksum: '0'.repeat(64) }), /SHA256 mismatch/);
});
test('Windows entry keeps interactive results open and supports quiet execution', () => {
  const entry = windowsEntry({ version: '1.1.2', checksum: 'a'.repeat(64) });
  assert.match(entry, /if \(!\$Quiet\).*Read-Host/);
  assert.match(entry, /exit \$result/);
  assert.match(windowsSed('C:\\temp\\payload'), /RebootMode=N/);
  assert.match(windowsSed('C:\\temp\\payload'), /ShowInstallProgramWindow=0/);
  assert.match(windowsSed('C:\\temp\\payload'), /AdminQuietInstCmd=.*-Quiet/);
});
test('real EXE installs without host Node on PATH, repeats and preserves old version after a bad candidate', {
  skip: process.platform !== 'win32' || !process.env.CODEGRAPH_TEST_EXE,
}, t => {
  const dir = fixture(t), install = path.join(dir, '安装 with spaces'), resultFile = path.join(dir, 'result.txt');
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')),
    CODEGRAPH_INSTALL_DIR: install, CODEGRAPH_UPDATE_PATH: '0', CODEGRAPH_INSTALL_RESULT_FILE: resultFile,
    PATH: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}` };
  const run = exe => {
    fs.rmSync(resultFile, { force: true });
    const r = spawnSync(exe, ['/Q'], { env, windowsHide: true, timeout: 180000, encoding: 'utf8' });
    assert.equal(r.error, undefined, r.error?.message);
    assert.ok(fs.existsSync(resultFile), `Installer did not report completion: ${r.status} ${r.stderr}`);
    return fs.readFileSync(resultFile, 'utf8');
  };
  const exe = path.resolve(process.env.CODEGRAPH_TEST_EXE);
  assert.equal(run(exe), '0');
  const pointer = fs.readFileSync(path.join(install, 'current.txt'), 'utf8');
  assert.equal(run(exe), '0');
  assert.equal(fs.readFileSync(path.join(install, 'current.txt'), 'utf8'), pointer);
  const node = path.join(install, 'versions', pointer.trim(), 'node.exe');
  const cli = path.join(install, 'versions', pointer.trim(), 'lib/dist/bin/codegraph.js');
  const check = spawnSync(node, [cli, '--version'], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(check.status, 0, check.stderr); assert.match(check.stdout, /1\.1\.2/);
  // Exercise the non-quiet entry from the real SFX, feeding Enter only after
  // installation. The default entry must display its result and wait to close.
  const extracted = path.join(dir, 'extracted'); fs.mkdirSync(extracted);
  const unpack = spawnSync(exe, ['/Q', '/C', `/T:${extracted}`], { env, windowsHide: true, timeout: 60000 });
  assert.equal(unpack.status, 0);
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const interactive = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(extracted, 'entry.ps1')], {
    env, input: '\n', encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(interactive.status, 0, interactive.stderr);
  assert.match(interactive.stdout, /Installation completed/);
  assert.match(interactive.stdout, /Press Enter to close/);
  const badZip = path.join(dir, 'bad.zip'), badExe = path.join(dir, 'bad.exe');
  fs.writeFileSync(badZip, 'not a zip archive');
  buildWindowsInstaller({ archive: badZip, output: badExe, installer: path.join(scripts, 'install-self-contained.ps1'), version: '1.1.2', checksum: sha256(badZip) });
  assert.equal(run(badExe), '1');
  assert.equal(fs.readFileSync(path.join(install, 'current.txt'), 'utf8'), pointer);
});
