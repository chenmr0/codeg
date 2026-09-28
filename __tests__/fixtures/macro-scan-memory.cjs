// Separate --expose-gc process: measure current source, never a stale dist build.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');

require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(
  fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  },
).outputText, filename);
const { buildMacroContext } = require('../../src/extraction/macro-scan.ts');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-macro-heap-'));
const fileCount = 64; // Exceeds the scanner's 50-file batch; 64 MiB of input.
const sourceBytes = 1024 * 1024;
process.env.CODEGRAPH_RUST_MACROS = process.argv[2] === 'fallback' ? '1' : '0';
process.env.CODEGRAPH_RUST_MACROS_PATH = path.join(root, 'missing-helper');

function writeSources() {
  return Array.from({ length: fileCount }, (_, i) => {
    const tag = String(i).padStart(6, '0');
    // Every retained field is longer than V8's small-string copy threshold.
    const buffer = Buffer.alloc(sourceBytes, 120);
    buffer.write(`#define LONG_EMPTY_MACRO_${tag}\n` +
      `#define LONG_FUNCTION_MACRO_${tag}(long_argument_name, long_variadic_name...) ` +
      `target_function_${tag}(long_argument_name, long_variadic_name)\n//`);
    buffer[buffer.length - 1] = 10;
    const file = `${tag}.h`;
    fs.writeFileSync(path.join(root, file), buffer);
    return file;
  });
}

function heapUsed() {
  /reset/.exec('reset'); // Exclude RegExp's last-input slot from the measurement.
  global.gc();
  global.gc();
  return process.memoryUsage().heapUsed;
}

(async () => {
  try {
    const files = writeSources();
    const baseline = heapUsed();
    const context = await buildMacroContext(root, files);
    await new Promise(resolve => setImmediate(resolve));
    const retainedBytes = heapUsed() - baseline;
    // Consume every field AFTER measuring so the full context must stay alive.
    const outputHash = crypto.createHash('sha256').update(JSON.stringify({
      names: [...context.names], bodyless: [...context.bodyless], definitions: context.definitions,
    })).digest('hex');
    console.log(JSON.stringify({ retainedBytes, fileCount, sourceBytes, outputHash,
      names: context.names.size, bodyless: context.bodyless.size,
      definitions: context.definitions.length, metrics: context.metrics }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
