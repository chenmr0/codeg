#!/usr/bin/env node
// Packaging tests only: fixtures contain shell mocks, never a downloaded runtime.
// Run with: node --test scripts/test-portable-installer.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installer = path.join(repoRoot, 'scripts', 'install-portable.sh');
const launcher = path.join(repoRoot, 'scripts', 'portable-launcher.sh');
const archivePrefix = 'codegraph-linux-x64-glibc217';
const fixturePlatform = process.platform === 'linux' && process.arch === 'x64';

// Construct USTAR headers directly. This permits genuinely unsafe archive
// members that command-line tar would otherwise sanitize while creating them.
function tarMember({ name, contents = '', type = '0', mode = 0o644, linkname = '' }) {
  const body = Buffer.from(contents);
  const header = Buffer.alloc(512);
  const write = (value, offset, length) => {
    assert.ok(Buffer.byteLength(value) <= length, `fixture field too long: ${value}`);
    header.write(value, offset, length, 'utf8');
  };
  const octal = (value, offset, length) =>
    write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length);
  write(name, 0, 100);
  octal(mode, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(body.length, 124, 12);
  octal(1_700_000_000, 136, 12);
  header.fill(0x20, 148, 156);
  write(type, 156, 1);
  write(linkname, 157, 100);
  write('ustar\0', 257, 6);
  write('00', 263, 2);
  write('fixture', 265, 32);
  write('fixture', 297, 32);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

function bundleEntries({ version = '1.1.1', nodeFailure = false, smokeFailure = false } = {}) {
  const directories = ['', '/bin', '/lib', '/lib/dist', '/lib/dist/bin'].map((suffix) => ({
    name: `${archivePrefix}${suffix}/`, type: '5', mode: 0o755,
  }));
  return [
    ...directories,
    {
      name: `${archivePrefix}/node`, mode: 0o755,
      contents: `#!/bin/sh
${nodeFailure ? 'exit 51' : ':'}
if [ "$1" = '--version' ]; then
  printf '%s\\n' 'v24.21.0'
  exit 0
fi
[ "$1" = '--liftoff-only' ] || exit 53
shift
[ -f "$1" ] || exit 54
shift
if [ "$1" = '--version' ]; then
  if [ -n "\${CODEGRAPH_TEST_SMOKE_LOG:-}" ]; then
    previous=$(readlink "$CODEGRAPH_INSTALL_DIR/current" 2>/dev/null || :)
    printf '%s\\n' "$previous" >> "$CODEGRAPH_TEST_SMOKE_LOG"
  fi
  ${smokeFailure ? 'exit 52' : `printf '%s\\n' '${version}'`}
  exit 0
fi
printf '<%s>\\n' "$@"
`,
    },
    {
      name: `${archivePrefix}/bin/codegraph`, mode: 0o755,
      contents: fs.readFileSync(launcher, 'utf8'),
    },
    {
      name: `${archivePrefix}/lib/package.json`,
      contents: `${JSON.stringify({ name: '@sdd/codegraph-wx', version })}\n`,
    },
    { name: `${archivePrefix}/lib/dist/bin/codegraph.js`, contents: '// packaging fixture\n' },
  ];
}

function writeArchive(fixture, name, entries = bundleEntries()) {
  const archive = path.join(fixture.root, `${name}.tar.gz`);
  const bytes = gzipSync(Buffer.concat([...entries.map(tarMember), Buffer.alloc(1024)]));
  fs.writeFileSync(archive, bytes);
  return { archive, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph portable installer test '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    installDir: path.join(root, 'install with spaces'),
    binDir: path.join(root, 'bin with spaces'),
    smokeLog: path.join(root, 'smoke probe.log'),
  };
}

function install(fixture, bundle, extraEnv = {}) {
  return spawnSync('/bin/sh', [installer, '--archive', bundle.archive, '--sha256', bundle.sha256], {
    cwd: fixture.root,
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      CODEGRAPH_INSTALL_DIR: fixture.installDir,
      CODEGRAPH_BIN_DIR: fixture.binDir,
      CODEGRAPH_TEST_SMOKE_LOG: fixture.smokeLog,
      ...extraEnv,
    },
  });
}

function describeResult(result) {
  return `status=${result.status}, signal=${result.signal}, error=${result.error ?? 'none'}\n${result.stdout}\n${result.stderr}`;
}

function assertSuccess(result) {
  assert.equal(result.status, 0, describeResult(result));
}

function assertFailure(result) {
  assert.equal(result.error, undefined, describeResult(result));
  assert.equal(result.signal, null, describeResult(result));
  assert.notEqual(result.status, 0, describeResult(result));
}

function activeState(fixture) {
  const current = path.join(fixture.installDir, 'current');
  const command = path.join(fixture.binDir, 'codegraph');
  assert.ok(fs.lstatSync(current).isSymbolicLink(), 'current must be a symlink');
  assert.ok(fs.lstatSync(command).isSymbolicLink(), 'the installed command must be a symlink');
  const resolved = fs.realpathSync(current);
  return {
    current: fs.readlinkSync(current),
    command: fs.readlinkSync(command),
    resolved,
    inode: fs.statSync(resolved).ino,
    launcher: fs.readFileSync(path.join(resolved, 'bin', 'codegraph'), 'utf8'),
  };
}

function assertVersion(fixture, version) {
  const result = spawnSync(path.join(fixture.binDir, 'codegraph'), ['--version'], {
    encoding: 'utf8', timeout: 5_000,
    env: { ...process.env, CODEGRAPH_TEST_SMOKE_LOG: '' },
  });
  assertSuccess(result);
  assert.equal(result.stdout.trim(), version);
}

function installBaseline(t) {
  const fixture = createFixture(t);
  const bundle = writeArchive(fixture, 'baseline');
  assertSuccess(install(fixture, bundle));
  assertVersion(fixture, '1.1.1');
  return { fixture, bundle, before: activeState(fixture) };
}

function assertUnchanged(fixture, before) {
  assert.deepEqual(activeState(fixture), before, 'failed installation changed the active release');
  assertVersion(fixture, '1.1.1');
  assert.equal(
    fs.readdirSync(path.join(fixture.installDir, 'versions')).some((name) => name.startsWith('.staging.')),
    false,
    'failed installation left an unfinished staging directory',
  );
}

test('portable installer with local synthetic Linux x64 bundles', {
  skip: fixturePlatform ? false : 'synthetic bundle targets Linux x64',
}, async (t) => {
  assert.ok(fs.existsSync(installer), `installer is missing: ${installer}`);

  await t.test('installs into paths with spaces and smoke-tests before activation', (t) => {
    const fixture = createFixture(t);
    assertSuccess(install(fixture, writeArchive(fixture, 'first install')));
    const state = activeState(fixture);
    assert.ok(state.resolved.startsWith(`${fixture.installDir}${path.sep}`));
    assertVersion(fixture, '1.1.1');
    assert.equal(fs.readFileSync(fixture.smokeLog, 'utf8'), '\n', 'new current was activated before smoke test');
  });

  await t.test('same-checksum reinstall reuses the existing release', (t) => {
    const { fixture, bundle, before } = installBaseline(t);
    const sentinel = path.join(before.resolved, 'idempotency-sentinel');
    fs.writeFileSync(sentinel, 'keep this release\n');
    assertSuccess(install(fixture, bundle));
    assert.deepEqual(activeState(fixture), before);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep this release\n');
  });

  await t.test('installed launcher preserves CLI argument boundaries', (t) => {
    const { fixture } = installBaseline(t);
    const args = ['query', 'two words', '', '*?[abc]', 'a"quote', "it's literal", '$HOME', '--flag=value', 'line\nbreak'];
    const result = spawnSync(path.join(fixture.binDir, 'codegraph'), args, {
      encoding: 'utf8', timeout: 5_000,
    });
    assertSuccess(result);
    assert.equal(result.stdout, args.map((value) => `<${value}>\n`).join(''));
  });

  await t.test('installed launcher refuses the upstream upgrade command', (t) => {
    const { fixture } = installBaseline(t);
    const result = spawnSync(path.join(fixture.binDir, 'codegraph'), ['upgrade'], {
      encoding: 'utf8', timeout: 5_000,
    });
    assertFailure(result);
    assert.match(result.stderr, /install-portable\.sh/);
    assert.equal(result.stdout, '', 'upstream CLI must not execute upgrade');
  });

  await t.test('launcher follows a relative symlink chain', (t) => {
    const { fixture } = installBaseline(t);
    const aliasDir = path.join(fixture.root, 'relative links');
    fs.mkdirSync(aliasDir);
    fs.symlinkSync(path.relative(aliasDir, path.join(fixture.binDir, 'codegraph')), path.join(aliasDir, 'first'));
    fs.symlinkSync('first', path.join(aliasDir, 'second'));
    const result = spawnSync(path.join(aliasDir, 'second'), ['--version'], {
      encoding: 'utf8', timeout: 5_000,
    });
    assertSuccess(result);
    assert.equal(result.stdout.trim(), '1.1.1');
  });

  await t.test('upgrade only switches current after successful smoke test', (t) => {
    const { fixture, before } = installBaseline(t);
    fs.writeFileSync(fixture.smokeLog, '');
    const upgraded = writeArchive(fixture, 'upgrade', bundleEntries({ version: '1.1.2' }));
    assertSuccess(install(fixture, upgraded));
    const after = activeState(fixture);
    assert.notEqual(after.resolved, before.resolved, 'a different archive must not overwrite the active directory');
    assertVersion(fixture, '1.1.2');
    assert.equal(fs.readFileSync(fixture.smokeLog, 'utf8'), `${before.current}\n`);
  });

  await t.test('checksum mismatch preserves the active install and runs no candidate', (t) => {
    const { fixture, before } = installBaseline(t);
    fs.writeFileSync(fixture.smokeLog, '');
    const bundle = writeArchive(fixture, 'bad checksum', bundleEntries({ version: '1.1.2' }));
    assertFailure(install(fixture, { ...bundle, sha256: '0'.repeat(64) }));
    assertUnchanged(fixture, before);
    assert.equal(fs.readFileSync(fixture.smokeLog, 'utf8'), '');
  });

  await t.test('rejects a missing or malformed checksum', (t) => {
    const { fixture, bundle, before } = installBaseline(t);
    for (const sha256 of ['', '1234', `${bundle.sha256}junk`]) {
      assertFailure(install(fixture, { ...bundle, sha256 }));
      assertUnchanged(fixture, before);
    }
  });

  await t.test('does not replace an unrelated command in the destination', (t) => {
    const fixture = createFixture(t);
    fs.mkdirSync(fixture.binDir, { recursive: true });
    const command = path.join(fixture.binDir, 'codegraph');
    const original = '#!/bin/sh\necho unrelated-installation\n';
    fs.writeFileSync(command, original, { mode: 0o755 });
    assertFailure(install(fixture, writeArchive(fixture, 'command collision')));
    assert.ok(fs.lstatSync(command).isFile());
    assert.equal(fs.readFileSync(command, 'utf8'), original);
    assert.equal(fs.existsSync(path.join(fixture.installDir, 'current')), false);
  });

  await t.test('rejects relative install and bin paths', (t) => {
    const fixture = createFixture(t);
    const bundle = writeArchive(fixture, 'relative paths');
    for (const key of ['CODEGRAPH_INSTALL_DIR', 'CODEGRAPH_BIN_DIR']) {
      assertFailure(install(fixture, bundle, { [key]: 'relative destination' }));
      assert.equal(fs.existsSync(path.join(fixture.root, 'relative destination')), false);
    }
  });

  await t.test('invalid gzip/tar preserves the active install', (t) => {
    const { fixture, before } = installBaseline(t);
    for (const [name, bytes] of [
      ['not gzip', Buffer.from('this is not an archive\n')],
      ['not tar', gzipSync(Buffer.from('this is not a tar file\n'))],
    ]) {
      const archive = path.join(fixture.root, name);
      fs.writeFileSync(archive, bytes);
      assertFailure(install(fixture, { archive, sha256: createHash('sha256').update(bytes).digest('hex') }));
      assertUnchanged(fixture, before);
    }
  });

  for (const [name, member] of [
    ['parent traversal', { name: `${archivePrefix}/../../escape`, contents: 'unsafe\n' }],
    ['dot path component', { name: `${archivePrefix}/./ambiguous`, contents: 'unsafe\n' }],
    ['backslash path', { name: `${archivePrefix}/back\\slash`, contents: 'unsafe\n' }],
    ['absolute path', { name: '/codegraph-installer-must-not-write-here', contents: 'unsafe\n' }],
    ['wrong archive root', { name: 'unexpected-root/file', contents: 'unsafe\n' }],
    ['symbolic link', { name: `${archivePrefix}/symlink`, type: '2', linkname: '../../escape' }],
    ['hard link', { name: `${archivePrefix}/hardlink`, type: '1', linkname: `${archivePrefix}/node` }],
    ['FIFO', { name: `${archivePrefix}/pipe`, type: '6' }],
    ['character device', { name: `${archivePrefix}/device`, type: '3' }],
    ['block device', { name: `${archivePrefix}/block-device`, type: '4' }],
  ]) {
    await t.test(`rejects ${name} before extraction and preserves current`, (t) => {
      const { fixture, before } = installBaseline(t);
      fs.writeFileSync(fixture.smokeLog, '');
      const bundle = writeArchive(fixture, name, [...bundleEntries(), member]);
      assertFailure(install(fixture, bundle));
      assertUnchanged(fixture, before);
      assert.equal(fs.readFileSync(fixture.smokeLog, 'utf8'), '', 'unsafe archive reached smoke execution');
      assert.equal(fs.existsSync(path.join(fixture.root, 'escape')), false);
    });
  }

  for (const missing of ['node', 'bin/codegraph', 'lib/dist/bin/codegraph.js']) {
    await t.test(`rejects bundle missing ${missing}`, (t) => {
      const { fixture, before } = installBaseline(t);
      const entries = bundleEntries().filter((entry) => entry.name !== `${archivePrefix}/${missing}`);
      assertFailure(install(fixture, writeArchive(fixture, 'missing required file', entries)));
      assertUnchanged(fixture, before);
    });
  }

  for (const [name, options] of [
    ['bundled runtime', { nodeFailure: true }],
    ['launcher', { smokeFailure: true }],
  ]) {
    await t.test(`failed ${name} smoke test preserves the active install`, (t) => {
      const { fixture, before } = installBaseline(t);
      assertFailure(install(fixture, writeArchive(fixture, 'failed smoke', bundleEntries(options))));
      assertUnchanged(fixture, before);
    });
  }
});
