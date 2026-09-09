#!/usr/bin/env node

/**
 * Reproducible fresh-initialization benchmark runner.
 *
 * Each project is indexed through an owned CODEGRAPH_DIR so the repository's
 * normal `.codegraph` index is never removed. A marker is required before the
 * runner will recursively delete its benchmark index directory.
 */

import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism, cpus, freemem, release, tmpdir, totalmem } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const INIT_BENCHMARK_SCHEMA_VERSION = 1;
export const INIT_BENCHMARK_MANIFEST_VERSION = 1;
export const BENCHMARK_INDEX_DIRECTORY = '.codegraph-init-benchmark';

const OWNER = 'codegraph-init-benchmark';
const MARKER_FILE = '.codegraph-benchmark-owner.json';
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const DEFAULT_CLI_PATH = path.join(REPOSITORY_ROOT, 'dist', 'bin', 'codegraph.js');
const TUNING_ENV_KEYS = new Set([
  'CODEGRAPH_PARSE_WORKERS',
  'CODEGRAPH_RESOLVE_WORKERS',
  'CODEGRAPH_PARALLEL_RESOLVE_MIN',
  'CODEGRAPH_RESOLVER_CACHE_SIZE',
  'CODEGRAPH_PARSE_TIMEOUT_MS',
  'CODEGRAPH_RESOLVE_TASK_TIMEOUT_MS',
  'CODEGRAPH_WAL_VALVE_MB',
  'CODEGRAPH_DEDUP_SYMLINKS',
  'CODEGRAPH_FORCE_PARSE',
  'CODEGRAPH_NO_FAST_INIT',
  'CODEGRAPH_NO_WAL_DEFER',
  'CODEGRAPH_NO_BATCH_WRITES',
  'CODEGRAPH_NO_STORE_BATCHING',
  'CODEGRAPH_NO_STORE_NODE_DEDUPE',
  'CODEGRAPH_NO_NATIVE_STORE_ROW_BATCH',
  'CODEGRAPH_NO_BULK_FTS',
  'CODEGRAPH_NO_PARSE_INDEX_DEFER',
  'CODEGRAPH_NO_RESOLVE_INDEX_DEFER',
  'CODEGRAPH_NO_PARALLEL_RESOLVE',
  'CODEGRAPH_NO_RESOLVE_EQUIVALENCE_CACHE',
  'CODEGRAPH_NO_STORE_WORKER',
  'CODEGRAPH_FORCE_WASM',
  'CODEGRAPH_NO_SYNTHESIS',
]);

function usage() {
  return [
    'Usage: node scripts/benchmark-init.mjs --manifest FILE [options]',
    '',
    'Options:',
    '  --root DIR       Override the manifest corpus root',
    '  --project NAME   Run only a named project (repeatable)',
    '  --runs N         Override measured runs per project (default: 3)',
    '  --warmups N      Override warm-up runs per project (default: 1)',
    '  --out DIR        Result directory (default: system temp)',
    '  --cli FILE       Built codegraph CLI path',
    '  --resume         Resume incomplete runs from --out checkpoint',
    '  --keep-index     Keep the last owned benchmark index per project',
    '  --help           Show this help',
  ].join('\n');
}

function positiveInteger(value, name, minimum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return parsed;
}

export function parseBenchmarkArgs(argv) {
  const result = { projects: [], keepIndex: false, resume: false, help: false };
  const valueOptions = new Map([
    ['--manifest', 'manifest'],
    ['--root', 'root'],
    ['--runs', 'runs'],
    ['--warmups', 'warmups'],
    ['--out', 'out'],
    ['--cli', 'cli'],
    ['--project', 'project'],
  ]);

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      result.help = true;
      continue;
    }
    if (argument === '--keep-index') {
      result.keepIndex = true;
      continue;
    }
    if (argument === '--resume') {
      result.resume = true;
      continue;
    }
    const key = valueOptions.get(argument);
    if (!key) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) {
      throw new Error(`${argument} requires a value`);
    }
    if (key === 'project') result.projects.push(value);
    else result[key] = value;
  }
  return result;
}

function safeName(value) {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/g, '-');
  if (!normalized || normalized === '.' || normalized === '..') {
    throw new Error(`Invalid project name: ${value}`);
  }
  return normalized;
}

function objectOrEmpty(value, label) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function validatedEnvironment(value, label) {
  const environment = objectOrEmpty(value, label);
  const result = {};
  for (const [key, raw] of Object.entries(environment)) {
    if (!TUNING_ENV_KEYS.has(key)) {
      throw new Error(`${label}.${key} is not an allowed CodeGraph tuning option`);
    }
    result[key] = String(raw);
  }
  return result;
}

function resolveManifestPath(base, value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(base, value);
}

export function loadBenchmarkManifest(manifestPath, options = {}) {
  const resolvedManifest = path.resolve(manifestPath);
  const manifestDirectory = path.dirname(resolvedManifest);
  const raw = JSON.parse(readFileSync(resolvedManifest, 'utf8'));
  if (raw.schemaVersion !== INIT_BENCHMARK_MANIFEST_VERSION) {
    throw new Error(
      `Unsupported benchmark manifest schemaVersion: ${String(raw.schemaVersion)}`,
    );
  }
  if (!Array.isArray(raw.projects) || raw.projects.length === 0) {
    throw new Error('Benchmark manifest must contain at least one project');
  }

  const defaults = objectOrEmpty(raw.defaults, 'defaults');
  const runs = positiveInteger(options.runs ?? defaults.runs ?? 3, '--runs', 1);
  const warmups = positiveInteger(
    options.warmups ?? defaults.warmups ?? 1,
    '--warmups',
    0,
  );
  const defaultEnvironment = validatedEnvironment(
    defaults.environment,
    'defaults.environment',
  );
  const rootValue = options.root ?? raw.root ?? '.';
  const corpusRoot = resolveManifestPath(manifestDirectory, rootValue);
  const selected = new Set(options.projects ?? []);
  const seenNames = new Set();
  const seenSafeNames = new Set();

  const projects = raw.projects
    .filter((project) => project?.enabled !== false)
    .filter((project) => selected.size === 0 || selected.has(project?.name))
    .map((project, index) => {
      if (!project || typeof project !== 'object' || Array.isArray(project)) {
        throw new Error(`projects[${index}] must be an object`);
      }
      if (typeof project.name !== 'string' || !project.name.trim()) {
        throw new Error(`projects[${index}].name must be a non-empty string`);
      }
      if (typeof project.path !== 'string' || !project.path.trim()) {
        throw new Error(`projects[${index}].path must be a non-empty string`);
      }
      if (seenNames.has(project.name)) {
        throw new Error(`Duplicate project name: ${project.name}`);
      }
      seenNames.add(project.name);
      const fileName = safeName(project.name);
      if (seenSafeNames.has(fileName)) {
        throw new Error(`Project names collide after filename normalization: ${fileName}`);
      }
      seenSafeNames.add(fileName);
      const projectPath = resolveManifestPath(corpusRoot, project.path);
      if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
        throw new Error(`Project directory does not exist: ${projectPath}`);
      }
      const languages = Array.isArray(project.languages)
        ? project.languages.map(String).filter(Boolean)
        : [];
      if (languages.length === 0) {
        throw new Error(`${project.name}.languages must contain at least one language`);
      }
      return {
        name: project.name,
        fileName,
        path: realpathSync(projectPath),
        languages,
        size: String(project.size ?? 'unspecified'),
        layout: String(project.layout ?? 'unspecified'),
        storage: String(project.storage ?? 'unspecified'),
        expectedRevision:
          typeof project.expectedRevision === 'string'
            ? project.expectedRevision.trim()
            : null,
        environment: {
          ...defaultEnvironment,
          ...validatedEnvironment(project.environment, `${project.name}.environment`),
        },
      };
    });

  if (projects.length === 0) {
    throw new Error('No enabled benchmark projects matched the selection');
  }
  if (selected.size > 0) {
    const missing = [...selected].filter((name) => !seenNames.has(name));
    if (missing.length > 0) throw new Error(`Unknown project name(s): ${missing.join(', ')}`);
  }
  return { manifestPath: resolvedManifest, corpusRoot, runs, warmups, projects };
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function git(projectPath, args) {
  const result = spawnSync('git', ['-C', projectPath, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function sourceState(project) {
  const revision = git(project.path, ['rev-parse', 'HEAD']);
  const branch = git(project.path, ['branch', '--show-current']);
  const dirtyOutput = git(project.path, [
    'status',
    '--porcelain',
    '--untracked-files=all',
  ]);
  const dirtyEntries = dirtyOutput === null
    ? null
    : dirtyOutput
        .split(/\r?\n/)
        .filter(Boolean)
        .filter((line) => {
          const file = line.slice(3).replaceAll('\\', '/');
          return (
            file !== '.codegraph' &&
            !file.startsWith('.codegraph/') &&
            file !== BENCHMARK_INDEX_DIRECTORY &&
            !file.startsWith(`${BENCHMARK_INDEX_DIRECTORY}/`)
          );
        });
  const dirty = dirtyEntries === null ? null : dirtyEntries.length > 0;
  if (
    project.expectedRevision &&
    (!revision || !revision.startsWith(project.expectedRevision))
  ) {
    throw new Error(
      `${project.name} revision ${revision ?? 'unknown'} does not match ` +
        `expectedRevision ${project.expectedRevision}`,
    );
  }
  if (project.expectedRevision && dirty !== false) {
    throw new Error(
      `${project.name} must have a clean worktree when expectedRevision is set`,
    );
  }
  return { revision, branch: branch || null, dirty };
}

function markerPath(projectPath) {
  return path.join(projectPath, BENCHMARK_INDEX_DIRECTORY, MARKER_FILE);
}

function assertOwnedIndex(projectPath) {
  const indexPath = path.join(projectPath, BENCHMARK_INDEX_DIRECTORY);
  const marker = markerPath(projectPath);
  const indexStats = lstatSync(indexPath);
  if (!indexStats.isDirectory() || indexStats.isSymbolicLink()) {
    throw new Error(`Refusing to remove a non-directory or linked path: ${indexPath}`);
  }
  let parsed;
  try {
    const markerStats = lstatSync(marker);
    if (!markerStats.isFile() || markerStats.isSymbolicLink()) {
      throw new Error('invalid marker file');
    }
    parsed = JSON.parse(readFileSync(marker, 'utf8'));
  } catch {
    throw new Error(
      `Refusing to remove unowned benchmark index directory: ${indexPath}`,
    );
  }
  if (parsed.owner !== OWNER || parsed.schemaVersion !== 1) {
    throw new Error(`Refusing to remove benchmark directory with an invalid marker: ${indexPath}`);
  }
  return indexPath;
}

function removeOwnedIndex(projectPath) {
  const indexPath = path.join(projectPath, BENCHMARK_INDEX_DIRECTORY);
  if (!existsSync(indexPath)) return;
  assertOwnedIndex(projectPath);
  rmSync(indexPath, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 200,
  });
}

function prepareOwnedIndex(projectPath) {
  removeOwnedIndex(projectPath);
  const indexPath = path.join(projectPath, BENCHMARK_INDEX_DIRECTORY);
  mkdirSync(indexPath, { recursive: false });
  writeFileSync(
    markerPath(projectPath),
    `${JSON.stringify({ owner: OWNER, schemaVersion: 1 }, null, 2)}\n`,
    'utf8',
  );
}

function writeTextAtomic(outputPath, content) {
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporary = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, outputPath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function writeJsonAtomic(outputPath, value) {
  writeTextAtomic(outputPath, `${JSON.stringify(value, null, 2)}\n`);
}

function resolveCheckpointArtifact(outputDirectory, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('Checkpoint contains an invalid artifact path');
  }
  const resolved = path.resolve(outputDirectory, relativePath);
  const relative = path.relative(outputDirectory, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Checkpoint artifact escapes output directory: ${relativePath}`);
  }
  return resolved;
}

function loadResumeCheckpoint(checkpointPath, { manifest, cliPath, outputDirectory }) {
  if (!existsSync(checkpointPath)) {
    throw new Error(`Cannot resume without checkpoint: ${checkpointPath}`);
  }
  const report = JSON.parse(readFileSync(checkpointPath, 'utf8'));
  if (report.schemaVersion !== INIT_BENCHMARK_SCHEMA_VERSION) {
    throw new Error(`Unsupported benchmark checkpoint schema: ${report.schemaVersion}`);
  }
  if (!samePath(report.manifestPath, manifest.manifestPath)) {
    throw new Error('Checkpoint manifest does not match --manifest');
  }
  if (!samePath(report.cliPath, cliPath)) {
    throw new Error('Checkpoint CLI does not match --cli');
  }
  if (!samePath(report.outputDirectory, outputDirectory)) {
    throw new Error('Checkpoint output directory does not match --out');
  }
  if (
    report.runner?.runsPerProject !== manifest.runs ||
    report.runner?.warmupsPerProject !== manifest.warmups
  ) {
    throw new Error('Checkpoint run counts do not match the requested manifest');
  }
  if (!Array.isArray(report.projects) || report.projects.length > manifest.projects.length) {
    throw new Error('Checkpoint contains an invalid project list');
  }

  for (const [projectIndex, projectResult] of report.projects.entries()) {
    const project = manifest.projects[projectIndex];
    if (
      projectResult.name !== project.name ||
      !samePath(projectResult.path, project.path)
    ) {
      throw new Error(`Checkpoint project ${projectResult.name} does not match manifest order`);
    }
    if (!Array.isArray(projectResult.warmups) || !Array.isArray(projectResult.runs)) {
      throw new Error(`Checkpoint project ${project.name} has invalid run lists`);
    }
    if (
      projectResult.warmups.length > manifest.warmups ||
      projectResult.runs.length > manifest.runs
    ) {
      throw new Error(`Checkpoint project ${project.name} has too many completed runs`);
    }
    for (const [kind, entries] of [
      ['warmup', projectResult.warmups],
      ['measured', projectResult.runs],
    ]) {
      for (const [runIndex, entry] of entries.entries()) {
        if (entry.kind !== kind || entry.ordinal !== runIndex + 1) {
          throw new Error(`Checkpoint project ${project.name} has invalid ${kind} ordinals`);
        }
        const profilePath = resolveCheckpointArtifact(outputDirectory, entry.profilePath);
        const profile = readProfile(profilePath, project.path);
        if (profile.output.graphFingerprint !== entry.output?.graphFingerprint) {
          throw new Error(`Checkpoint profile changed for ${project.name} ${kind} ${entry.ordinal}`);
        }
      }
    }
  }
  return report;
}

function relativeOutputPath(outputDirectory, filePath) {
  return path.relative(outputDirectory, filePath).split(path.sep).join('/');
}

function runEnvironment(overrides) {
  const environment = { ...process.env };
  for (const key of TUNING_ENV_KEYS) delete environment[key];
  Object.assign(environment, overrides, {
    CI: '1',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    CODEGRAPH_NO_DAEMON: '1',
    CODEGRAPH_DIR: BENCHMARK_INDEX_DIRECTORY,
  });
  return environment;
}

function readProfile(profilePath, projectPath) {
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  if (profile.schemaVersion !== 1) {
    throw new Error(`Unsupported init profile schema in ${profilePath}`);
  }
  if (!samePath(profile.projectRoot, projectPath)) {
    throw new Error(
      `Profile projectRoot mismatch: expected ${projectPath}, got ${profile.projectRoot}`,
    );
  }
  if (!profile.output?.graphFingerprint) {
    throw new Error(`Profile does not contain a graph fingerprint: ${profilePath}`);
  }
  return profile;
}

function executeRun({ project, cliPath, outputDirectory, ordinal, kind, keepIndex }) {
  const tag = `${project.fileName}-${kind}-${ordinal}`;
  const profilePath = path.join(outputDirectory, 'profiles', `${tag}.json`);
  const logPath = path.join(outputDirectory, 'logs', `${tag}.log`);
  prepareOwnedIndex(project.path);
  let profile;
  try {
    const logDescriptor = openSync(logPath, 'w');
    const started = performance.now();
    let completed;
    try {
      completed = spawnSync(
        process.execPath,
        [cliPath, 'init', project.path, '--profile', profilePath],
        {
          env: runEnvironment(project.environment),
          stdio: ['ignore', logDescriptor, logDescriptor],
          windowsHide: true,
        },
      );
    } finally {
      closeSync(logDescriptor);
    }
    const wallMs = Math.round((performance.now() - started) * 1000) / 1000;
    if (completed.error || completed.status !== 0) {
      const tail = readFileSync(logPath, 'utf8').slice(-5000);
      throw new Error(
        `${tag} failed with status ${String(completed.status)}: ` +
          `${completed.error?.message ?? 'codegraph init failed'}\n${tail}`,
      );
    }
    profile = readProfile(profilePath, project.path);
    return {
      kind,
      ordinal,
      wallMs,
      profilePath: relativeOutputPath(outputDirectory, profilePath),
      logPath: relativeOutputPath(outputDirectory, logPath),
      startedAt: profile.startedAt,
      finishedAt: profile.finishedAt,
      environment: profile.environment,
      configuration: profile.configuration,
      input: profile.input,
      timings: profile.timings,
      output: profile.output,
      resources: profile.resources,
      extractionScheduling: profile.extractionScheduling,
      writer: profile.writer,
      resolution: profile.resolution,
      synthesis: profile.synthesis,
    };
  } finally {
    if (!keepIndex) removeOwnedIndex(project.path);
  }
}

function rounded(value) {
  return Math.round(value * 1000) / 1000;
}

export function summarizeNumbers(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
  const p90 = sorted[Math.max(0, Math.ceil(sorted.length * 0.9) - 1)];
  return {
    min: rounded(sorted[0]),
    median: rounded(median),
    p90: rounded(p90),
    max: rounded(sorted[sorted.length - 1]),
    mean: rounded(values.reduce((sum, value) => sum + value, 0) / values.length),
  };
}

function phaseSummary(runs) {
  const names = new Set(runs.flatMap((run) => Object.keys(run.timings.phases ?? {})));
  return Object.fromEntries(
    [...names]
      .sort()
      .map((name) => [
        name,
        summarizeNumbers(
          runs
            .map((run) => run.timings.phases?.[name])
            .filter((value) => typeof value === 'number'),
        ),
      ]),
  );
}

const WRITER_STAT_NAMES = [
  'bundlesSent',
  'messagesSent',
  'sourceBytes',
  'nodesSent',
  'edgesSent',
  'unresolvedRefsSent',
  'maxOutstandingBundles',
  'walBackpressureCount',
  'windowWaitCount',
  'windowWaitMs',
  'transactions',
  'transactionMs',
  'rowAggregationMs',
  'duplicateNodeRowsElided',
  'nodeWriteMs',
  'edgeWriteMs',
  'unresolvedRefWriteMs',
  'fileWriteMs',
  'filesStored',
  'nodesStored',
  'edgesStored',
  'unresolvedRefsStored',
];

function writerSummary(runs) {
  const writers = runs.map((run) => run.writer).filter(Boolean);
  if (writers.length !== runs.length) return null;
  return Object.fromEntries(
    WRITER_STAT_NAMES.map((name) => [
      name,
      summarizeNumbers(writers.map((writer) => writer[name])),
    ]),
  );
}

const RESOLUTION_METRICS = [
  'totalReferences',
  'resolvedReferences',
  'unresolvedReferences',
  'parallelBatches',
  'sequentialBatches',
  'cacheWarmMs',
  'resolverPoolReadyMs',
  'parallelResolverCacheWarmMs',
  'cppImportCacheHits',
  'cppImportCacheMisses',
];

function resolutionSummary(runs) {
  const resolutions = runs.map((run) => run.resolution).filter(Boolean);
  if (resolutions.length !== runs.length) return null;
  const entries = [];
  for (const name of RESOLUTION_METRICS) {
    const values = resolutions.map((resolution) => resolution[name]);
    if (values.every((value) => typeof value === 'number')) {
      entries.push([name, summarizeNumbers(values)]);
    }
  }
  return Object.fromEntries(entries);
}

const EXTRACTION_SCHEDULING_METRICS = [
  ['batches', (scheduling) => scheduling.batches],
  ['filesObserved', (scheduling) => scheduling.filesObserved],
  ['filesFailed', (scheduling) => scheduling.filesFailed],
  ['barrierSlackMs', (scheduling) => scheduling.barrierSlackMs],
  ['batchWallP50Ms', (scheduling) => scheduling.batchWallMs.p50Ms],
  ['batchWallP95Ms', (scheduling) => scheduling.batchWallMs.p95Ms],
  ['batchWallP99Ms', (scheduling) => scheduling.batchWallMs.p99Ms],
  ['batchWallMaxMs', (scheduling) => scheduling.batchWallMs.maxMs],
  ['fileTurnaroundP50Ms', (scheduling) => scheduling.fileTurnaroundMs.p50Ms],
  ['fileTurnaroundP95Ms', (scheduling) => scheduling.fileTurnaroundMs.p95Ms],
  ['fileTurnaroundP99Ms', (scheduling) => scheduling.fileTurnaroundMs.p99Ms],
  ['fileTurnaroundMaxMs', (scheduling) => scheduling.fileTurnaroundMs.maxMs],
  ['extractorDurationP50Ms', (scheduling) => scheduling.extractorDurationMs.p50Ms],
  ['extractorDurationP95Ms', (scheduling) => scheduling.extractorDurationMs.p95Ms],
  ['extractorDurationP99Ms', (scheduling) => scheduling.extractorDurationMs.p99Ms],
  ['extractorDurationMaxMs', (scheduling) => scheduling.extractorDurationMs.maxMs],
  ['poolStateSamples', (scheduling) => scheduling.poolStateSamples],
  ['maxQueueDepth', (scheduling) => scheduling.maxQueueDepth],
  ['maxInflightWorkers', (scheduling) => scheduling.maxInflightWorkers],
  ['maxIdleWorkers', (scheduling) => scheduling.maxIdleWorkers],
  ['maxPendingWorkers', (scheduling) => scheduling.maxPendingWorkers],
  ['maxLiveWorkers', (scheduling) => scheduling.maxLiveWorkers],
  ['windowStateSamples', (scheduling) => scheduling.windowStateSamples],
  ['maxWindowTasks', (scheduling) => scheduling.maxWindowTasks],
  ['maxWindowCompletedTasks', (scheduling) =>
    scheduling.maxWindowCompletedTasks],
  ['maxWindowSourceBytes', (scheduling) =>
    scheduling.maxWindowSourceBytes],
  ['maxWindowResultRows', (scheduling) =>
    scheduling.maxWindowResultRows],
];

function extractionSchedulingSummary(runs) {
  const scheduling = runs
    .map((run) => run.extractionScheduling)
    .filter(Boolean);
  if (scheduling.length !== runs.length) return null;
  const entries = [];
  for (const [name, select] of EXTRACTION_SCHEDULING_METRICS) {
    const values = scheduling.map(select);
    if (values.every((value) => typeof value === 'number')) {
      entries.push([name, summarizeNumbers(values)]);
    }
  }
  return Object.fromEntries(entries);
}

function stableInputSignature(input) {
  const sortedRecord = (record) => Object.fromEntries(
    Object.entries(record ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  );
  return JSON.stringify({
    sourceFilesDiscovered: input.sourceFilesDiscovered,
    sourceFilesRead: input.sourceFilesRead,
    sourceBytes: input.sourceBytes,
    filesByLanguage: sortedRecord(input.filesByLanguage),
    bytesByLanguage: sortedRecord(input.bytesByLanguage),
    macroFilesScanned: input.macroFilesScanned,
    macroBytesScanned: input.macroBytesScanned,
    macroFilesParsed: input.macroFilesParsed,
    macroBytesParsed: input.macroBytesParsed,
  });
}

export function summarizeProjectRuns(runs) {
  if (runs.length === 0) throw new Error('Cannot summarize zero benchmark runs');
  const fingerprints = runs.map((run) => run.output.graphFingerprint);
  const inputs = runs.map((run) => stableInputSignature(run.input));
  const input = runs[0].input;
  const indexing = summarizeNumbers(runs.map((run) => run.timings.indexingMs));
  return {
    valid:
      runs.every((run) => run.output.success) &&
      runs.every((run) => run.output.complete !== false) &&
      new Set(fingerprints).size === 1 &&
      new Set(inputs).size === 1,
    allSuccessful: runs.every((run) => run.output.success),
    allComplete: runs.every((run) => run.output.complete !== false),
    graphFingerprintsMatch: new Set(fingerprints).size === 1,
    inputSignaturesMatch: new Set(inputs).size === 1,
    graphFingerprint: fingerprints[0],
    wallMs: summarizeNumbers(runs.map((run) => run.wallMs)),
    indexingMs: indexing,
    profileOverheadMs: summarizeNumbers(
      runs.map((run) => run.timings.profileOverheadMs),
    ),
    cpuMs: summarizeNumbers(
      runs.map((run) => run.resources.cpuUserMs + run.resources.cpuSystemMs),
    ),
    processMaxRssBytes: summarizeNumbers(
      runs.map((run) => run.resources.processMaxRssBytes),
    ),
    throughput: {
      filesPerSecond: rounded(
        input.sourceFilesRead / Math.max(0.001, indexing.median / 1000),
      ),
      mebibytesPerSecond: rounded(
        (input.sourceBytes / 1024 / 1024) /
          Math.max(0.001, indexing.median / 1000),
      ),
    },
    phases: phaseSummary(runs),
    resolution: resolutionSummary(runs),
    extractionScheduling: extractionSchedulingSummary(runs),
    writer: writerSummary(runs),
  };
}

function markdownCell(value) {
  return String(value ?? 'n/a').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function formatDuration(milliseconds) {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1000).toFixed(2)} s`;
}

function formatMebibytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function createMarkdownReport(report) {
  const lines = [
    '# CodeGraph init benchmark',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    `Overall validity: **${report.overall.valid ? 'PASS' : 'FAIL'}**`,
    '',
    '| Project | Languages | Size | Files | Input | Median init | p90 init | Max RSS | Stable graph | Source |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |',
  ];
  for (const project of report.projects) {
    const input = project.runs[0].input;
    const summary = project.summary;
    const source = project.source.revision
      ? `${project.source.revision.slice(0, 12)}${project.source.dirty ? ' (dirty)' : ''}`
      : 'non-git';
    lines.push(
      `| ${markdownCell(project.name)} | ${markdownCell(project.languages.join(', '))} | ` +
        `${markdownCell(project.size)} | ${input.sourceFilesRead} | ` +
        `${formatMebibytes(input.sourceBytes)} | ${formatDuration(summary.indexingMs.median)} | ` +
        `${formatDuration(summary.indexingMs.p90)} | ` +
        `${formatMebibytes(summary.processMaxRssBytes.max)} | ` +
        `${summary.graphFingerprintsMatch ? 'yes' : 'NO'} | ${markdownCell(source)} |`,
    );
  }

  for (const project of report.projects) {
    lines.push('', `## ${project.name}`, '');
    lines.push(
      `Fingerprint: \`${project.summary.graphFingerprint}\``,
      '',
      '| Phase | Median | p90 |',
      '| --- | ---: | ---: |',
    );
    const phases = Object.entries(project.summary.phases)
      .sort((left, right) => right[1].median - left[1].median);
    for (const [name, values] of phases) {
      lines.push(
        `| ${markdownCell(name)} | ${formatDuration(values.median)} | ` +
          `${formatDuration(values.p90)} |`,
      );
    }
    if (project.summary.resolution) {
      lines.push(
        '',
        '### Reference resolution',
        '',
        '| Metric | Median | p90 |',
        '| --- | ---: | ---: |',
      );
      for (const [name, values] of Object.entries(project.summary.resolution)) {
        const isDuration = name.endsWith('Ms');
        lines.push(
          `| ${markdownCell(name)} | ` +
            `${isDuration ? formatDuration(values.median) : values.median} | ` +
            `${isDuration ? formatDuration(values.p90) : values.p90} |`,
        );
      }
    }
    if (project.summary.extractionScheduling) {
      lines.push(
        '',
        '### Extraction scheduling',
        '',
        '| Metric | Median | p90 |',
        '| --- | ---: | ---: |',
      );
      for (const [name, values] of Object.entries(
        project.summary.extractionScheduling
      )) {
        const isDuration = name.endsWith('Ms');
        lines.push(
          `| ${markdownCell(name)} | ` +
            `${isDuration ? formatDuration(values.median) : values.median} | ` +
            `${isDuration ? formatDuration(values.p90) : values.p90} |`,
        );
      }
    }
    if (project.summary.writer) {
      lines.push(
        '',
        '### Writer',
        '',
        '| Metric | Median | p90 |',
        '| --- | ---: | ---: |',
      );
      for (const [name, values] of Object.entries(project.summary.writer)) {
        const isDuration = name.endsWith('Ms');
        lines.push(
          `| ${markdownCell(name)} | ` +
            `${isDuration ? formatDuration(values.median) : values.median} | ` +
            `${isDuration ? formatDuration(values.p90) : values.p90} |`,
        );
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseBenchmarkArgs(argv);
  if (options.help) {
    console.log(usage());
    return null;
  }
  if (!options.manifest) throw new Error(`--manifest is required\n\n${usage()}`);
  const cliPath = path.resolve(options.cli ?? DEFAULT_CLI_PATH);
  if (!existsSync(cliPath)) {
    throw new Error(`Built CLI does not exist: ${cliPath}. Run npm run build first.`);
  }
  const manifest = loadBenchmarkManifest(options.manifest, {
    root: options.root,
    runs: options.runs,
    warmups: options.warmups,
    projects: options.projects,
  });
  const outputDirectory = path.resolve(
    options.out ?? path.join(tmpdir(), `codegraph-init-benchmark-${Date.now()}`),
  );
  if (options.resume && !options.out) {
    throw new Error('--resume requires an explicit --out directory');
  }
  mkdirSync(path.join(outputDirectory, 'logs'), { recursive: true });
  mkdirSync(path.join(outputDirectory, 'profiles'), { recursive: true });

  const checkpointPath = path.join(outputDirectory, 'init-benchmark-checkpoint.json');
  let report;
  if (options.resume) {
    report = loadResumeCheckpoint(checkpointPath, {
      manifest,
      cliPath,
      outputDirectory,
    });
    report.generatedAt = new Date().toISOString();
    report.resumedAt = report.generatedAt;
    report.overall = { valid: false, projectCount: manifest.projects.length };
    console.log(`[resume] loaded ${checkpointPath}`);
  } else {
    report = {
      schemaVersion: INIT_BENCHMARK_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      manifestPath: manifest.manifestPath,
      cliPath,
      outputDirectory,
      runner: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        osRelease: release(),
        cpuModel: cpus()[0]?.model ?? 'unknown',
        logicalCpuCount: cpus().length,
        availableParallelism: availableParallelism(),
        totalMemoryBytes: totalmem(),
        freeMemoryBytesAtStart: freemem(),
        runsPerProject: manifest.runs,
        warmupsPerProject: manifest.warmups,
        benchmarkIndexDirectory: BENCHMARK_INDEX_DIRECTORY,
      },
      projects: [],
      overall: { valid: false, projectCount: manifest.projects.length },
    };
  }

  for (const [projectIndex, project] of manifest.projects.entries()) {
    const source = sourceState(project);
    console.log(
      `[${project.name}] ${source.revision?.slice(0, 12) ?? 'non-git'} ` +
        `${source.dirty ? '(dirty)' : ''}`.trimEnd(),
    );
    let projectResult = report.projects[projectIndex];
    if (projectResult) {
      if (
        projectResult.source?.revision !== source.revision ||
        projectResult.source?.dirty !== source.dirty
      ) {
        throw new Error(`Cannot resume ${project.name}: source state changed`);
      }
      projectResult.summary = null;
      removeOwnedIndex(project.path);
      console.log(
        `[${project.name}] resume after ${projectResult.warmups.length} warm-up and ` +
          `${projectResult.runs.length} measured run(s)`,
      );
    } else {
      projectResult = {
        name: project.name,
        path: project.path,
        languages: project.languages,
        size: project.size,
        layout: project.layout,
        storage: project.storage,
        expectedRevision: project.expectedRevision,
        source,
        environment: project.environment,
        warmups: [],
        runs: [],
        summary: null,
      };
      report.projects.push(projectResult);
    }

    for (
      let ordinal = projectResult.warmups.length + 1;
      ordinal <= manifest.warmups;
      ordinal++
    ) {
      console.log(`[${project.name}] warm-up ${ordinal}/${manifest.warmups}`);
      projectResult.warmups.push(
        executeRun({
          project,
          cliPath,
          outputDirectory,
          ordinal,
          kind: 'warmup',
          keepIndex: false,
        }),
      );
      writeJsonAtomic(checkpointPath, report);
    }
    for (
      let ordinal = projectResult.runs.length + 1;
      ordinal <= manifest.runs;
      ordinal++
    ) {
      console.log(`[${project.name}] measured ${ordinal}/${manifest.runs}`);
      const run = executeRun({
        project,
        cliPath,
        outputDirectory,
        ordinal,
        kind: 'measured',
        keepIndex: options.keepIndex && ordinal === manifest.runs,
      });
      projectResult.runs.push(run);
      console.log(
        `[${project.name}] ${formatDuration(run.timings.indexingMs)}, ` +
          `${run.input.sourceFilesRead} files, ` +
          `${run.output.graphFingerprint.slice(0, 19)}`,
      );
      writeJsonAtomic(checkpointPath, report);
    }
    projectResult.summary = summarizeProjectRuns(projectResult.runs);
    writeJsonAtomic(checkpointPath, report);
  }

  report.overall = {
    valid: report.projects.every((project) => project.summary.valid),
    projectCount: report.projects.length,
    allGraphsStable: report.projects.every(
      (project) => project.summary.graphFingerprintsMatch,
    ),
    allInputsStable: report.projects.every(
      (project) => project.summary.inputSignaturesMatch,
    ),
    allSuccessful: report.projects.every((project) => project.summary.allSuccessful),
    allComplete: report.projects.every((project) => project.summary.allComplete),
    reproducibleSources: report.projects.every(
      (project) => project.source.revision && project.source.dirty === false,
    ),
  };

  const jsonPath = path.join(outputDirectory, 'init-benchmark-report.json');
  const markdownPath = path.join(outputDirectory, 'init-benchmark-report.md');
  writeJsonAtomic(jsonPath, report);
  writeTextAtomic(markdownPath, createMarkdownReport(report));
  console.log(`RESULT_JSON ${jsonPath}`);
  console.log(`RESULT_MARKDOWN ${markdownPath}`);
  if (!report.overall.valid) process.exitCode = 2;
  return report;
}

if (process.argv[1] && samePath(process.argv[1], SCRIPT_PATH)) {
  main().catch((error) => {
    console.error(`[init-benchmark] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
