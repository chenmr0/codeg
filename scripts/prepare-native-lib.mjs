// Prepare bundled helpers and validate unstamped candidates on the actual host.
// Validators use temporary fixtures only: no compiler, download or project index.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { artifactApi, macroArtifactApi, checkExecutable, nativeSourceHash, macroSourceHash } from './rust-scan-release-lib.mjs';

export function prepareNativeArtifacts(root, {
  platform = process.platform, arch = process.arch, env = process.env,
  run = spawnSync, log = console.log, warn = console.warn,
} = {}) {
  if (arch !== 'x64' || !['linux', 'win32'].includes(platform)) return [];
  const results = [];
  for (const kind of ['scan', 'macros']) {
    const label = `rust-${kind}`;
    try {
      const check = kind === 'scan' ? artifactApi(root).checkRustScanArtifact
        : macroArtifactApi(root).checkRustMacroArtifact;
      const binary = path.join(root, `dist/native-${kind}`, `${platform}-${arch}`,
        `codegraph-${kind}${platform === 'win32' ? '.exe' : ''}`);
      const manifest = check(binary, platform, arch, undefined, false);
      checkExecutable(fs.readFileSync(binary), platform);
      const sourceHash = kind === 'scan' ? nativeSourceHash(root) : macroSourceHash(root);
      if (manifest.sourceHash !== sourceHash) throw new Error('stale-source-hash');
      if (platform !== 'win32') fs.chmodSync(binary, 0o755);
      let validated = false;
      try { check(binary, platform, arch); validated = true; }
      catch (error) { if (error.message !== 'binary-unverified') throw error; }
      if (!validated) {
        // Keep business-project settings out of the temporary release fixtures.
        const validatorEnv = Object.fromEntries(Object.entries(env)
          .filter(([key]) => !key.toUpperCase().startsWith('CODEGRAPH_')));
        validatorEnv.CODEGRAPH_ALL_LANGUAGES = '1';
        log(`[${label}] Validating bundled helper on ${platform}-${arch}...`);
        const result = run(process.execPath, [path.join(root, `scripts/validate-rust-${kind}.mjs`)], {
          cwd: root, env: validatorEnv, encoding: 'utf8', windowsHide: true,
          timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
        });
        if (result.error || result.status !== 0) {
          throw new Error(result.error?.message || result.stderr?.trim().slice(-4000)
            || `validator exited ${result.status} (${result.signal ?? 'no signal'})`);
        }
        // Only the real target validator may write a stamp. Exit code alone is
        // insufficient; recheck its platform, suite and exact executable bytes.
        check(binary, platform, arch);
        log(`[${label}] Target validation passed; automatic acceleration is available.`);
      } else {
        log(`[${label}] Bundled target validation verified; automatic acceleration is available.`);
      }
      results.push({ kind, ready: true });
    } catch (error) {
      warn(`[${label}] Native preparation failed; TypeScript fallback remains available: ${error.message}`);
      results.push({ kind, ready: false, reason: error.message });
    }
  }
  return results;
}
