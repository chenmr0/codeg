import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Node } from '../src/types';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
import { CppIncludeDirectory } from '../src/resolution/cpp-include-directory';
import { clearCppBindingEvidence, isCppBindingTargetAllowed } from '../src/resolution/cpp-binding-evidence';

// Frozen full-scan semantics from cpp-binding-evidence.ts at 751e3293.
// This deliberately does not use the new directory or its normalization helper.
function originalScan(files: string[], name: string, limit = 256) {
  const result = { files: [] as string[], complete: true };
  for (const indexedFile of files) {
    const candidate = path.posix.normalize(indexedFile.replace(/\\/g, '/'));
    if (candidate !== name && !candidate.endsWith(`/${name}`)) continue;
    if (result.files.length >= limit) {
      result.complete = false;
      break;
    }
    result.files.push(candidate);
  }
  return result;
}

describe('C/C++ include directory ordered lookup', () => {
  it('loads a snapshot once and preserves source order and normalized duplicates', () => {
    const files = ['z/api.h', 'a/./api.h', 'noise.cpp', 'a/api.h', 'c\\api.h'];
    const getFiles = vi.fn(() => files);
    const directory = new CppIncludeDirectory(getFiles);
    expect(getFiles).not.toHaveBeenCalled();
    expect(directory.find('api.h', 256)).toEqual({
      files: ['z/api.h', 'a/api.h', 'a/api.h', 'c/api.h'], complete: true,
    });
    expect(directory.find('a/api.h', 256)).toEqual(originalScan(files, 'a/api.h'));
    expect(directory.find('missing.h', 256)).toEqual({ files: [], complete: true });
    expect(getFiles).toHaveBeenCalledTimes(1);
  });

  it.each([255, 256, 257])('retains the first 256 matches and detects the next match (%s)', count => {
    const files = Array.from({ length: count }, (_, i) => `p${i}/api.h`);
    files.splice(3, 0, 'unrelated.h', 'api.hpp');
    const directory = new CppIncludeDirectory(() => files);
    const result = directory.find('api.h', 256);
    expect(result).toEqual(originalScan(files, 'api.h'));
    expect(result.files).toHaveLength(Math.min(count, 256));
    expect(result.complete).toBe(count <= 256);
  });

  it('checks matching count, not bucket size, before setting incomplete', () => {
    const files = Array.from({ length: 1000 }, (_, i) => `p${i}/api.h`);
    files.splice(510, 0, 'a/shared/api.h', 'shared/api.h');
    expect(new CppIncludeDirectory(() => files).find('shared/api.h', 2)).toEqual({
      files: ['a/shared/api.h', 'shared/api.h'], complete: true,
    });
  });

  it.each(['./api.h', '../api.h', 'folder/../api.h', 'folder\\api.h', '/api.h',
    'C:/root/api.h', 'C:\\root\\api.h', 'api.h/', '', '.', '..', '/', '//', 'µ/名字.h']) (
    'keeps the original include spelling %j', name => {
      const files = ['api.h', './api.h', '../api.h', 'folder/../api.h', 'folder/api.h',
        '/api.h', 'C:/root/api.h', 'C:\\root\\api.h', 'api.h/', '', '.', '..', '/', '//',
        'µ/名字.h', 'nested/µ/名字.h', 'api.h/child.h'];
      expect(new CppIncludeDirectory(() => files).find(name, 256)).toEqual(originalScan(files, name));
    },
  );

  it('matches the old scan for mixed paths, limits and directory budgets', () => {
    let seed = 0x51aacc29;
    const random = (size: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % size;
    };
    const spellings = ['api.h', 'other.h', 'deep/api.h', './api.h', '../api.h', 'deep\\api.h',
      '名字.h', '/absolute.h', '.', '', 'tail/'];
    for (let round = 0; round < 80; round++) {
      const files = Array.from({ length: 30 + random(40) }, () => {
        const stem = ['', 'root/', 'a/../', 'z\\'][random(4)]!;
        return stem + spellings[random(spellings.length)]!;
      });
      for (const budget of [0, 512, 8 * 1024 * 1024]) {
        const directory = new CppIncludeDirectory(() => files, budget);
        for (const name of spellings) {
          const limit = [0, 1, 3, 256][random(4)]!;
          expect(directory.find(name, limit)).toEqual(originalScan(files, name, limit));
        }
      }
    }
  });

  it('uses the old full scan after retention overflow without repeatedly rebuilding a partial directory', () => {
    const files = ['first/api.h', 'x'.repeat(2000) + '/large.h', 'last/api.h'];
    const getFiles = vi.fn(() => files);
    const directory = new CppIncludeDirectory(getFiles, 300);
    expect(directory.find('api.h', 256)).toEqual(originalScan(files, 'api.h'));
    expect(getFiles).toHaveBeenCalledTimes(1);
    expect(directory.find('large.h', 256)).toEqual(originalScan(files, 'large.h'));
    expect(getFiles).toHaveBeenCalledTimes(2);
    expect(directory.find('api.h', 1)).toEqual(originalScan(files, 'api.h', 1));
    expect(getFiles).toHaveBeenCalledTimes(3);
  });

  it('does not reuse mutable caller result arrays', () => {
    const directory = new CppIncludeDirectory(() => ['one/api.h', 'two/api.h']);
    directory.find('api.h', 256).files.reverse();
    expect(directory.find('api.h', 256).files).toEqual(['one/api.h', 'two/api.h']);
  });

  it('compares only the relevant final-segment bucket after the initial snapshot', () => {
    const files = Array.from({ length: 2000 }, (_, i) => `files/${i}.h`);
    files.push('first/needle.h', 'second/needle.h', 'needle.h');
    const directory = new CppIncludeDirectory(() => files);
    directory.find('missing.h', 256);
    const endsWith = vi.spyOn(String.prototype, 'endsWith');
    try {
      const result = directory.find('needle.h', 256);
      const calls = endsWith.mock.calls.length;
      expect(result.files).toEqual(['first/needle.h', 'second/needle.h', 'needle.h']);
      expect(calls).toBe(2);
    } finally {
      endsWith.mockRestore();
    }
  });
});

function bindingFixture(caller: string, initialFiles: Record<string, string>) {
  const files = { 'caller.cpp': caller, ...initialFiles };
  const node: Node = { id: 'private-helper', name: 'helper', qualifiedName: 'helper', kind: 'function',
    filePath: 'private.cpp', language: 'cpp', startLine: 1, endLine: 1, startColumn: 0, endColumn: 38,
    signature: 'static int helper() { return 1; }', isStatic: true, updatedAt: 0 };
  files[node.filePath] = node.signature!;
  const getAllFiles = vi.fn(() => Object.keys(files));
  const context: ResolutionContext = {
    getNodesInFile: file => file === node.filePath ? [node] : [],
    getNodesByName: name => name === node.name ? [node] : [],
    getNodesByQualifiedName: name => name === node.qualifiedName ? [node] : [],
    getNodesByKind: kind => kind === node.kind ? [node] : [],
    getNodesByLowerName: name => name === node.name.toLowerCase() ? [node] : [],
    readFile: file => files[file] ?? null,
    fileExists: file => file in files,
    getAllFiles,
    getProjectRoot: () => '/project',
    getImportMappings: () => [],
  };
  const ref: UnresolvedRef = { fromNodeId: 'caller', filePath: 'caller.cpp', language: 'cpp',
    referenceKind: 'calls', referenceName: 'helper', line: 20, column: 0 };
  return { files, node, context, ref, getAllFiles };
}

describe('include directory binding cache lifecycle', () => {
  it('reuses the directory across distinct include spellings', () => {
    const f = bindingFixture('#include <a.h>\n#include <b.h>\nint caller(){return helper();}', {
      'include/a.h': '', 'include/b.h': '',
    });
    expect(isCppBindingTargetAllowed(f.node, f.ref, f.context)).toBe(false);
    expect(f.getAllFiles).toHaveBeenCalledTimes(1);
  });

  it('does not enumerate the directory for a directly included file', () => {
    const f = bindingFixture('#include "private.cpp"\nint caller(){return helper();}', {});
    expect(isCppBindingTargetAllowed(f.node, f.ref, f.context)).toBe(true);
    expect(f.getAllFiles).not.toHaveBeenCalled();
  });

  it.each(['#if 0', '#ifdef OPTIONAL'])('preserves inactive/uncertain include decisions for %s', directive => {
    const f = bindingFixture(`${directive}\n#include <bridge.h>\n#endif\nint caller(){return helper();}`, {
      'include/bridge.h': '#include "../private.cpp"',
    });
    expect(isCppBindingTargetAllowed(f.node, f.ref, f.context)).toBe(directive !== '#if 0');
    expect(f.getAllFiles).toHaveBeenCalledTimes(directive === '#if 0' ? 0 : 1);
  });

  it('rebuilds after directory deletion, insertion or rename through evidence invalidation', () => {
    const f = bindingFixture('#include <bridge.h>\nint caller(){return helper();}', { 'include/bridge.h': '' });
    expect(isCppBindingTargetAllowed(f.node, f.ref, f.context)).toBe(false);
    delete f.files['include/bridge.h'];
    clearCppBindingEvidence(f.context);
    // Missing include keeps visibility unknown rather than proving absence.
    expect(isCppBindingTargetAllowed(f.node, f.ref, f.context)).toBe(true);
    f.files['new/bridge.h'] = '';
    clearCppBindingEvidence(f.context);
    expect(isCppBindingTargetAllowed(f.node, f.ref, f.context)).toBe(false);
    delete f.files['new/bridge.h'];
    f.files['new/renamed.h'] = '';
    f.files['caller.cpp'] = '#include <renamed.h>\nint caller(){return helper();}';
    clearCppBindingEvidence(f.context);
    expect(isCppBindingTargetAllowed(f.node, f.ref, f.context)).toBe(false);
    expect(f.getAllFiles).toHaveBeenCalledTimes(4);
  });

  it('keeps different resolution contexts isolated', () => {
    const first = bindingFixture('#include <bridge.h>\nint caller(){return helper();}', { 'include/bridge.h': '' });
    const second = bindingFixture('#include <bridge.h>\nint caller(){return helper();}', {});
    expect(isCppBindingTargetAllowed(first.node, first.ref, first.context)).toBe(false);
    expect(isCppBindingTargetAllowed(second.node, second.ref, second.context)).toBe(true);
    clearCppBindingEvidence(second.context);
    expect(isCppBindingTargetAllowed(first.node, first.ref, first.context)).toBe(false);
    expect(first.getAllFiles).toHaveBeenCalledTimes(1);
  });
});
