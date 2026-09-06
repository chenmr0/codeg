/** Release metadata gate for the standalone macro-context helper. */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

export const RUST_MACRO_PROTOCOL = 1;
export const RUST_MACRO_VALIDATION_SUITE = 'macro-parity-v1';
export const RUST_MACRO_TARGETS = {
  'win32-x64': { target: 'x86_64-pc-windows-msvc', executable: 'codegraph-macros.exe' },
  'linux-x64': { target: 'x86_64-unknown-linux-musl', executable: 'codegraph-macros' },
} as const;
export interface RustMacroManifest {
  schema: number; protocol: number; platform: string; arch: string; target: string;
  executable: string; packageVersion: string; sourceHash: string; sha256: string; profile: string;
  validation?: { suite: string; platform: string; arch: string; sha256: string; passed: boolean };
}
export function macroSha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export function rustMacroPackageVersion(): string {
  return (JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')) as { version: string }).version;
}
export function checkRustMacroArtifact(binary: string, platform: string = process.platform,
  arch: string = process.arch, version = rustMacroPackageVersion(), requireValidated = true): RustMacroManifest {
  const spec = RUST_MACRO_TARGETS[`${platform}-${arch}` as keyof typeof RUST_MACRO_TARGETS];
  if (!spec) throw new Error('unsupported-platform');
  if (!fs.existsSync(binary)) throw new Error('binary-missing');
  if (!fs.lstatSync(binary).isFile()) throw new Error('binary-type');
  const manifestPath = path.join(path.dirname(binary), 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('binary-unverified');
  let manifest: RustMacroManifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as RustMacroManifest; }
  catch { throw new Error('manifest-invalid'); }
  if (!manifest || manifest.schema !== 1 || manifest.protocol !== RUST_MACRO_PROTOCOL ||
      manifest.platform !== platform || manifest.arch !== arch || manifest.target !== spec.target ||
      manifest.executable !== path.basename(binary) || manifest.executable !== spec.executable ||
      manifest.packageVersion !== version || manifest.profile !== 'release' ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256 ?? '') || !/^[a-f0-9]{64}$/.test(manifest.sourceHash ?? '')) {
    throw new Error('manifest-mismatch');
  }
  if (macroSha256(fs.readFileSync(binary)) !== manifest.sha256) throw new Error('binary-checksum');
  const validation = manifest.validation;
  if (requireValidated && (!validation || validation.suite !== RUST_MACRO_VALIDATION_SUITE ||
      validation.platform !== platform || validation.arch !== arch || validation.sha256 !== manifest.sha256 ||
      validation.passed !== true)) throw new Error('binary-unverified');
  return manifest;
}
