import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import type { ExtractionError } from '../src/types';
import type { QueryBuilder } from '../src/db/queries';
import {
  DECLARATION_MACRO_RECOVERY_SKIPPED_CODE,
  collectPersistedIndexDiagnostics,
  replaceWithDeclarationMacroRecoverySkipped,
} from '../src/extraction/diagnostics';

describe('base-only index completeness diagnostics', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports full index wall time through maintenance and lock release', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-index-duration-'));
    tempDirs.push(dir);
    const cg = CodeGraph.initSync(dir);
    const internal = cg as any;
    let now = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(internal.orchestrator, 'indexAll').mockImplementation(async () => {
      now = 110;
      return { success: true, filesIndexed: 1, filesSkipped: 0, filesErrored: 0,
        nodesCreated: 0, edgesCreated: 0, errors: [], durationMs: 10 };
    });
    const maintenance = internal.db.runMaintenance.bind(internal.db);
    vi.spyOn(internal.db, 'runMaintenance').mockImplementation(async () => {
      await maintenance();
      now = 200;
    });
    const release = internal.fileLock.release.bind(internal.fileLock);
    vi.spyOn(internal.fileLock, 'release').mockImplementation(() => {
      release();
      now = 250;
    });
    try {
      const result = await cg.indexAll();
      expect(internal.db.runMaintenance).toHaveBeenCalled();
      expect(result.durationMs).toBe(150);
    } finally {
      vi.restoreAllMocks();
      cg.close();
    }
  });

  it('replaces a whole-file parse failure with a precise degradation warning', () => {
    const original: ExtractionError = {
      severity: 'error',
      code: 'parse_error',
      filePath: 'src/macros.cpp',
      message: 'Parse timed out after 30000ms',
    };
    const errors = [original];

    const diagnostic = replaceWithDeclarationMacroRecoverySkipped(
      errors,
      original,
      'src/macros.cpp',
      false,
    );

    expect(errors).toEqual([diagnostic]);
    expect(diagnostic).toEqual(expect.objectContaining({
      severity: 'warning',
      code: DECLARATION_MACRO_RECOVERY_SKIPPED_CODE,
      filePath: 'src/macros.cpp',
      message: expect.stringContaining('Base AST symbols from this file were indexed'),
    }));
    expect(diagnostic.message).toContain('declarations generated only by macros may be missing');
  });

  it('persists the file-scoped degradation while aggregating ordinary file failures', () => {
    const original: ExtractionError = {
      severity: 'error',
      code: 'parse_error',
      filePath: 'src/macros.cpp',
      message: 'Worker exited with code 1',
    };
    const errors: ExtractionError[] = [
      original,
      {
        severity: 'error',
        code: 'read_error',
        filePath: 'src/unreadable.cpp',
        message: 'permission denied',
      },
      {
        severity: 'warning',
        code: 'synthesis_disabled',
        message: 'synthesis disabled',
      },
    ];
    replaceWithDeclarationMacroRecoverySkipped(
      errors,
      original,
      'src/macros.cpp',
      true,
    );

    const persisted = collectPersistedIndexDiagnostics(errors, 1);

    expect(persisted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: DECLARATION_MACRO_RECOVERY_SKIPPED_CODE,
        filePath: 'src/macros.cpp',
        message: expect.stringContaining('omitted comment-only lines'),
      }),
      expect.objectContaining({ code: 'synthesis_disabled' }),
      expect.objectContaining({ code: 'files_not_indexed' }),
    ]));
    expect(persisted).not.toContainEqual(
      expect.objectContaining({ code: 'read_error', filePath: 'src/unreadable.cpp' })
    );
  });

  it('marks a usable base-only result incomplete and persists its file path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-base-only-'));
    tempDirs.push(dir);
    const cg = CodeGraph.initSync(dir);
    const original: ExtractionError = {
      severity: 'error',
      code: 'parse_error',
      filePath: 'src/macros.cpp',
      message: 'Parse timed out after 30000ms',
    };
    const errors = [original];
    replaceWithDeclarationMacroRecoverySkipped(
      errors,
      original,
      'src/macros.cpp',
      false,
    );

    const orchestrator = (cg as unknown as {
      orchestrator: {
        indexAll: (...args: unknown[]) => Promise<unknown>;
      };
    }).orchestrator;
    const realIndexAll = orchestrator.indexAll;
    orchestrator.indexAll = async () => ({
      success: true,
      filesIndexed: 1,
      filesSkipped: 0,
      filesErrored: 0,
      nodesCreated: 1,
      edgesCreated: 0,
      errors,
      durationMs: 1,
    });

    try {
      const result = await cg.indexAll();
      expect(result.success).toBe(true);
      expect(result.filesErrored).toBe(0);
      expect(result.complete).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        code: DECLARATION_MACRO_RECOVERY_SKIPPED_CODE,
        severity: 'warning',
      }));
      expect(cg.getIndexCompleteness()).toEqual({
        status: 'incomplete',
        diagnostics: [expect.objectContaining({
          code: DECLARATION_MACRO_RECOVERY_SKIPPED_CODE,
          filePath: 'src/macros.cpp',
        })],
      });
    } finally {
      orchestrator.indexAll = realIndexAll;
      cg.close();
    }
  });

  it('automatically retries an unchanged base-only file during sync and clears incompleteness', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-base-only-sync-'));
    tempDirs.push(dir);
    const sourcePath = path.join(dir, 'recovery.cpp');
    fs.writeFileSync(sourcePath, [
      '#define DECLARE_RECORD(Name) struct Name { int generated_field; };',
      'DECLARE_RECORD(RecoveredRecord)',
    ].join('\n'));
    const cg = CodeGraph.initSync(dir, {
      config: { include: ['**/*.cpp'], exclude: [] },
    });

    try {
      await cg.indexAll();
      const queries = (cg as unknown as { queries: QueryBuilder }).queries;
      const tracked = queries.getFileByPath('recovery.cpp');
      expect(tracked).not.toBeNull();
      expect(cg.searchNodes('RecoveredRecord').length).toBeGreaterThan(0);

      const degradation: ExtractionError = {
        severity: 'warning',
        code: DECLARATION_MACRO_RECOVERY_SKIPPED_CODE,
        filePath: 'recovery.cpp',
        message: 'Declaration-macro recovery was skipped for this test file.',
      };
      // Simulate the reduced graph left by a base-only retry: the current
      // source hash is retained, while a macro-generated declaration is absent.
      queries.deleteNodesByFile('recovery.cpp');
      queries.upsertFile({ ...tracked!, nodeCount: 0, errors: [degradation] });
      queries.setMetadata('index_completeness', 'incomplete');
      queries.setMetadata('index_diagnostics', JSON.stringify([degradation]));
      expect(cg.searchNodes('RecoveredRecord')).toHaveLength(0);

      const result = await cg.sync();

      expect(result.complete).toBe(true);
      expect(result.filesModified).toBe(1);
      expect(result.changedFilePaths).toEqual(['recovery.cpp']);
      expect(cg.searchNodes('RecoveredRecord').length).toBeGreaterThan(0);
      expect(cg.searchNodes('generated_field').length).toBeGreaterThan(0);
      expect(queries.getFileByPath('recovery.cpp')?.errors ?? []).not.toContainEqual(
        expect.objectContaining({ code: DECLARATION_MACRO_RECOVERY_SKIPPED_CODE }),
      );
      expect(cg.getIndexCompleteness()).toEqual({
        status: 'complete',
        diagnostics: [],
      });

      const next = await cg.sync();
      expect(next.filesModified).toBe(0);
      expect(next.changedFilePaths).toBeUndefined();
    } finally {
      cg.close();
    }
  });

  it('lets a plain index replace an unchanged base-only file record', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-base-only-index-'));
    tempDirs.push(dir);
    fs.writeFileSync(
      path.join(dir, 'recovery.ts'),
      'export function recoveredByIndex() { return 7; }',
    );
    const cg = CodeGraph.initSync(dir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });

    try {
      await cg.indexAll();
      const queries = (cg as unknown as { queries: QueryBuilder }).queries;
      const tracked = queries.getFileByPath('recovery.ts');
      expect(tracked).not.toBeNull();
      const degradation: ExtractionError = {
        severity: 'warning',
        code: DECLARATION_MACRO_RECOVERY_SKIPPED_CODE,
        filePath: 'recovery.ts',
        message: 'Declaration-macro recovery was skipped for this test file.',
      };
      queries.upsertFile({ ...tracked!, errors: [degradation] });

      const result = await cg.indexAll();

      expect(result.complete).toBe(true);
      expect(queries.getFileByPath('recovery.ts')?.errors ?? []).not.toContainEqual(
        expect.objectContaining({ code: DECLARATION_MACRO_RECOVERY_SKIPPED_CODE }),
      );
    } finally {
      cg.close();
    }
  });

  it('preserves unrelated incomplete diagnostics after automatic recovery', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-base-only-preserve-'));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'recovery.ts'), 'export const recovered = true;');
    const cg = CodeGraph.initSync(dir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });

    try {
      await cg.indexAll();
      const queries = (cg as unknown as { queries: QueryBuilder }).queries;
      const tracked = queries.getFileByPath('recovery.ts');
      expect(tracked).not.toBeNull();
      const degradation: ExtractionError = {
        severity: 'warning',
        code: DECLARATION_MACRO_RECOVERY_SKIPPED_CODE,
        filePath: 'recovery.ts',
        message: 'Declaration-macro recovery was skipped for this test file.',
      };
      const unrelated: ExtractionError = {
        severity: 'error',
        code: 'synthesis_failed',
        message: 'Synthetic edge coverage is incomplete.',
      };
      queries.upsertFile({ ...tracked!, errors: [degradation] });
      queries.setMetadata('index_completeness', 'incomplete');
      queries.setMetadata(
        'index_diagnostics',
        JSON.stringify([degradation, unrelated]),
      );

      await cg.sync();

      expect(cg.getIndexCompleteness()).toEqual({
        status: 'incomplete',
        diagnostics: [unrelated],
      });
    } finally {
      cg.close();
    }
  });
});
