/**
 * Reference Resolution Orchestrator
 *
 * Coordinates all reference resolution strategies.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Node, UnresolvedReference, Edge } from '../types';
import { QueryBuilder, SCOPED_REFERENCE_BATCH_SIZE, type PendingReferenceCursor } from '../db/queries';
import {
  UnresolvedRef,
  ResolvedRef,
  ResolutionResult,
  ResolutionContext,
  FrameworkResolver,
  ImportMapping,
} from './types';
import {
  matchReference,
  matchDottedCallChain,
  matchScopedCallChain,
  sameLanguageFamily,
  sameInstantiationLanguageFamily,
  crossesKnownFamily,
  isValidInstantiationTarget,
} from './name-matcher';
import { resolveViaImport, resolveJvmImport, extractImportMappings, extractReExports, loadCppIncludeDirs, isPhpIncludePathRef } from './import-resolver';
import { detectFrameworks } from './frameworks';
import {
  synthesizeCallbackEdges,
  synthesizeIncrementalCCppEdges,
} from './callback-synthesizer';
import { loadProjectAliases, type AliasMap } from './path-aliases';
import { loadGoModule, type GoModule } from './go-module';
import { loadWorkspacePackages, type WorkspacePackages } from './workspace-packages';
import { logDebug } from '../errors';
import type { ReExport } from './types';
import { LRUCache } from './lru-cache';
import { ResolutionTextCache } from './text-cache';
import { measureResolution, ResolutionDiagnostics } from './diagnostics';
import { IndexedNameLookup, syncNameLookupMode, type NameLookupMode } from './name-lookup';
import { canonicalFilePath, clearCanonicalCache } from '../utils';
import {
  ResolverPool,
  minRefsForResolverPool,
  type ResolverAdmissionResult,
} from './resolver-pool';

/** Node kinds that can declare supertypes (extends/implements). */
const SUPERTYPE_BEARING_KINDS = new Set<Node['kind']>([
  'class', 'struct', 'interface', 'trait', 'protocol', 'enum',
]);

/**
 * Languages whose chained static-factory/fluent calls defer to the conformance
 * second pass. Dotted-receiver languages resolve via matchDottedCallChain; the
 * `::`-receiver ones (Rust) via matchScopedCallChain.
 */
const CHAIN_LANGUAGES = new Set(['java', 'kotlin', 'csharp', 'swift', 'rust', 'go', 'scala', 'dart']);
const SCOPED_CHAIN_LANGUAGES = new Set(['rust']);

/** The extractor's chained-receiver encoding: `<inner>().<method>`. */
const CHAIN_SHAPE = /^(.+)\(\)\.(\w+)$/;

/**
 * Cache size limits. Each per-resolver cache is bounded so memory
 * stays flat on large codebases (20k+ files). Sizes were chosen to
 * cover the working set for typical resolution batches without
 * exceeding a few hundred MB worst-case. Override via the env var
 * `CODEGRAPH_RESOLVER_CACHE_SIZE` (single integer applied to all
 * caches) when tuning for very large or very small projects.
 */
const DEFAULT_CACHE_LIMIT = 5_000;
function resolveCacheLimit(): number {
  const raw = process.env.CODEGRAPH_RESOLVER_CACHE_SIZE;
  if (!raw) return DEFAULT_CACHE_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_CACHE_LIMIT;
}

// Re-export types
export * from './types';

// Pre-built Sets for O(1) built-in lookups (allocated once, shared across all instances)
const JS_BUILT_INS = new Set([
  'console', 'window', 'document', 'global', 'process',
  'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean',
  'Date', 'Math', 'JSON', 'RegExp', 'Error', 'Map', 'Set',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'fetch', 'require', 'module', 'exports', '__dirname', '__filename',
]);

const REACT_HOOKS = new Set([
  'useState', 'useEffect', 'useContext', 'useReducer', 'useCallback',
  'useMemo', 'useRef', 'useLayoutEffect', 'useImperativeHandle', 'useDebugValue',
]);

const PYTHON_BUILT_INS = new Set([
  'print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple',
  'open', 'input', 'type', 'isinstance', 'hasattr', 'getattr', 'setattr',
  'super', 'self', 'cls', 'None', 'True', 'False',
]);

const PYTHON_BUILT_IN_TYPES = new Set([
  'list', 'dict', 'set', 'tuple', 'str', 'int', 'float', 'bool',
  'bytes', 'bytearray', 'frozenset', 'object', 'super',
]);

const PYTHON_BUILT_IN_METHODS = new Set([
  'append', 'extend', 'insert', 'remove', 'pop', 'clear', 'sort', 'reverse', 'copy',
  'update', 'keys', 'values', 'items', 'get',
  'add', 'discard', 'union', 'intersection', 'difference',
  'split', 'join', 'strip', 'lstrip', 'rstrip', 'replace', 'lower', 'upper',
  'startswith', 'endswith', 'find', 'index', 'count', 'encode', 'decode',
  'format', 'isdigit', 'isalpha', 'isalnum',
  'read', 'write', 'readline', 'readlines', 'close', 'flush', 'seek',
]);

const GO_STDLIB_PACKAGES = new Set([
  'fmt', 'os', 'io', 'net', 'http', 'log', 'math', 'sort', 'sync',
  'time', 'path', 'bytes', 'strings', 'strconv', 'errors', 'context',
  'json', 'xml', 'csv', 'html', 'template', 'regexp', 'reflect',
  'runtime', 'testing', 'flag', 'bufio', 'crypto', 'encoding',
  'filepath', 'hash', 'mime', 'rand', 'signal', 'sql', 'syscall',
  'unicode', 'unsafe', 'atomic', 'binary', 'debug', 'exec', 'heap',
  'ring', 'scanner', 'tar', 'zip', 'gzip', 'zlib', 'tls', 'url',
  'user', 'pprof', 'trace', 'ast', 'build', 'parser', 'printer',
  'token', 'types', 'cgo', 'plugin', 'race', 'ioutil',
  // Kubernetes-common stdlib aliases
  'utilruntime', 'utilwait', 'utilnet',
]);

const GO_BUILT_INS = new Set([
  'make', 'new', 'len', 'cap', 'append', 'copy', 'delete', 'close',
  'panic', 'recover', 'print', 'println', 'complex', 'real', 'imag',
  'error', 'nil', 'true', 'false', 'iota',
  'int', 'int8', 'int16', 'int32', 'int64',
  'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
  'float32', 'float64', 'complex64', 'complex128',
  'string', 'bool', 'byte', 'rune', 'any',
]);

const PASCAL_UNIT_PREFIXES = [
  'System.', 'Winapi.', 'Vcl.', 'Fmx.', 'Data.', 'Datasnap.',
  'Soap.', 'Xml.', 'Web.', 'REST.', 'FireDAC.', 'IBX.',
  'IdHTTP', 'IdTCP', 'IdSSL',
];

const PASCAL_BUILT_INS = new Set([
  'System', 'SysUtils', 'Classes', 'Types', 'Variants', 'StrUtils',
  'Math', 'DateUtils', 'IOUtils', 'Generics.Collections', 'Generics.Defaults',
  'Rtti', 'TypInfo', 'SyncObjs', 'RegularExpressions',
  'SysInit', 'Windows', 'Messages', 'Graphics', 'Controls', 'Forms',
  'Dialogs', 'StdCtrls', 'ExtCtrls', 'ComCtrls', 'Menus', 'ActnList',
  'WriteLn', 'Write', 'ReadLn', 'Read', 'Inc', 'Dec', 'Ord', 'Chr',
  'Length', 'SetLength', 'High', 'Low', 'Assigned', 'FreeAndNil',
  'Format', 'IntToStr', 'StrToInt', 'FloatToStr', 'StrToFloat',
  'Trim', 'UpperCase', 'LowerCase', 'Pos', 'Copy', 'Delete', 'Insert',
  'Now', 'Date', 'Time', 'DateToStr', 'StrToDate',
  'Raise', 'Exit', 'Break', 'Continue', 'Abort',
  'True', 'False', 'nil', 'Self', 'Result',
  'Create', 'Destroy', 'Free',
  'TObject', 'TComponent', 'TPersistent', 'TInterfacedObject',
  'TList', 'TStringList', 'TStrings', 'TStream', 'TMemoryStream', 'TFileStream',
  'Exception', 'EAbort', 'EConvertError', 'EAccessViolation',
  'IInterface', 'IUnknown',
]);

const C_BUILT_INS = new Set([
  // Standard C library functions
  'printf', 'fprintf', 'sprintf', 'snprintf', 'scanf', 'fscanf', 'sscanf',
  'malloc', 'calloc', 'realloc', 'free',
  'memcpy', 'memmove', 'memset', 'memcmp', 'memchr',
  'strlen', 'strcpy', 'strncpy', 'strcat', 'strncat', 'strcmp', 'strncmp',
  'strstr', 'strchr', 'strrchr', 'strtok', 'strdup',
  'fopen', 'fclose', 'fread', 'fwrite', 'fgets', 'fputs', 'fputc', 'fgetc',
  'feof', 'ferror', 'fflush', 'fseek', 'ftell', 'rewind',
  'exit', 'abort', 'atexit', 'atoi', 'atol', 'atof', 'strtol', 'strtoul', 'strtod',
  'qsort', 'bsearch',
  'abs', 'labs', 'rand', 'srand',
  'sin', 'cos', 'tan', 'sqrt', 'pow', 'log', 'log10', 'exp', 'ceil', 'floor', 'fabs',
  'time', 'clock', 'difftime', 'mktime', 'localtime', 'gmtime', 'strftime', 'asctime',
  'assert', 'errno',
  'perror', 'remove', 'rename', 'tmpfile', 'tmpnam',
  'getenv', 'system',
  'signal', 'raise',
  'setjmp', 'longjmp',
  'va_start', 'va_end', 'va_arg', 'va_copy',
  'NULL', 'EOF', 'BUFSIZ', 'FILENAME_MAX', 'RAND_MAX', 'EXIT_SUCCESS', 'EXIT_FAILURE',
  'size_t', 'ptrdiff_t', 'wchar_t', 'intptr_t', 'uintptr_t',
  'int8_t', 'int16_t', 'int32_t', 'int64_t',
  'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
  'FILE',
  // POSIX additions commonly seen
  'stat', 'lstat', 'fstat', 'open', 'close', 'read', 'write', 'pipe',
  'fork', 'exec', 'waitpid', 'getpid', 'getppid', 'kill', 'sleep', 'usleep',
  'pthread_create', 'pthread_join', 'pthread_mutex_lock', 'pthread_mutex_unlock',
  'dlopen', 'dlsym', 'dlclose',
]);

const CPP_BUILT_INS = new Set([
  // iostream objects (often used without std:: prefix via using)
  'cout', 'cin', 'cerr', 'clog', 'endl', 'flush', 'ws',
  'std', // the namespace itself when used as std::something
  // Common C++ keywords that leak as references
  'nullptr', 'true', 'false', 'this', 'sizeof', 'alignof', 'typeid',
  'static_cast', 'dynamic_cast', 'reinterpret_cast', 'const_cast',
  'make_unique', 'make_shared', 'make_pair',
  'move', 'forward', 'swap',
]);

/**
 * Reference Resolver
 *
 * Orchestrates reference resolution using multiple strategies.
 */
export class ReferenceResolver {
  private projectRoot: string;
  private queries: QueryBuilder;
  private context: ResolutionContext;
  private frameworks: FrameworkResolver[] = [];
  private frameworkDiagnostics: import('./types').ResolutionDiagnostic[] = [];
  // Chained static-factory/fluent call refs the first pass couldn't resolve,
  // collected in-memory (the batched resolver deletes unresolved refs from the
  // DB, so they can't be re-read). Drained by resolveChainedCallsViaConformance
  // once implements/extends edges exist, to resolve methods on a supertype the
  // receiver conforms to (#750).
  private deferredChainRefs: UnresolvedRef[] = [];
  // Per-`.razor`/`.cshtml`-file `@using` namespace set (own directives + folder
  // `_Imports.razor`, cascading to the project root). Used to disambiguate a
  // markup type ref to the right C# namespace.
  private razorUsingsCache = new Map<string, string[]>();
  // All per-resolver caches are LRU-bounded. Previously these were
  // unbounded Maps that grew with every distinct lookup and OOM'd on
  // codebases with 20k+ files (see issue: unbounded cache growth).
  private nodeCache: LRUCache<string, Node[]>; // per-file node cache
  private fileCache: LRUCache<string, string | null>; // per-file content cache
  private readonly textCache = new ResolutionTextCache();
  private importMappingCache: LRUCache<string, ImportMapping[]>;
  private reExportCache: LRUCache<string, ReExport[]>;
  private nameCache: LRUCache<string, Node[]>; // name → nodes cache
  private lowerNameCache: LRUCache<string, Node[]>; // lower(name) → nodes cache
  private qualifiedNameCache: LRUCache<string, Node[]>; // qualified_name → nodes cache
  private methodMatchCache: LRUCache<string, Node[]>;
  private methodOwnerIndexCache: LRUCache<string, Map<string, Node[]>>;
  private nodesByKindCache = new Map<Node['kind'], Node[]>();
  private supertypeGeneration = 0;
  private supertypeInProgress = new Set<string>();
  private supertypeMemo = new Map<string, { generation: number; values: string[]; declared: boolean }>();
  private readonly equivalenceCachesEnabled =
    process.env.CODEGRAPH_NO_RESOLVE_EQUIVALENCE_CACHE !== '1';
  private knownNames: Set<string> | null = null; // all known symbol names for fast pre-filtering
  private indexedNames: IndexedNameLookup | null = null;
  private knownFiles: Set<string> | null = null;
  private cachesWarmed = false;
  // tsconfig/jsconfig path-alias map. `undefined` = not yet computed,
  // `null` = computed and absent. Treated as immutable for the
  // resolver's lifetime; callers re-create the resolver if config changes.
  private projectAliases: AliasMap | null | undefined = undefined;
  // go.mod module path. Same lazy/immutable convention as projectAliases.
  private goModule: GoModule | null | undefined = undefined;
  // Monorepo workspace member packages. Same lazy/immutable convention.
  private workspacePackages: WorkspacePackages | null | undefined = undefined;

  constructor(projectRoot: string, queries: QueryBuilder) {
    this.projectRoot = projectRoot;
    this.queries = queries;

    const limit = resolveCacheLimit();
    // The content cache is heavier (full file text), so we give it a
    // smaller budget than the metadata caches.
    const contentLimit = Math.max(64, Math.floor(limit / 5));
    this.nodeCache = new LRUCache(limit);
    this.fileCache = new LRUCache(contentLimit);
    this.importMappingCache = new LRUCache(limit);
    this.reExportCache = new LRUCache(limit);
    this.nameCache = new LRUCache(limit);
    this.lowerNameCache = new LRUCache(limit);
    this.qualifiedNameCache = new LRUCache(limit);
    this.methodMatchCache = new LRUCache(limit);
    this.methodOwnerIndexCache = new LRUCache(limit);

    this.context = this.createContext();
  }

  /**
   * Initialize the resolver (detect frameworks, etc.)
   */
  initialize(): void {
    this.frameworkDiagnostics = [];
    this.frameworks = detectFrameworks(this.context, (framework, error) => {
      this.frameworkDiagnostics.push({
        severity: 'error',
        code: 'framework_detection_failed',
        message: `Framework detection '${framework}' failed: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          `The index may be incomplete.`,
      });
    });
    this.clearCaches();
  }

  /**
   * Run each framework resolver's cross-file finalization pass and persist
   * the returned node updates. Idempotent — safe to call after every indexAll
   * and every incremental sync. Returns the number of nodes updated.
   *
   * Caches are cleared before/after so the post-extract pass sees fresh DB
   * state and downstream queries see the updated names.
   */
  runPostExtract(): number {
    let updated = 0;
    this.clearCaches();
    for (const fw of this.frameworks) {
      if (!fw.postExtract) continue;
      try {
        const nodes = fw.postExtract(this.context);
        for (const node of nodes) {
          this.queries.updateNode(node);
          updated++;
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.frameworkDiagnostics.push({
          severity: 'error',
          code: 'framework_post_extract_failed',
          message: `Framework post-processing '${fw.name}' failed: ${error}. ` +
            `The index may be incomplete.`,
        });
        logDebug(`Framework '${fw.name}' postExtract failed`, { error });
      }
    }
    if (updated > 0) this.clearCaches();
    return updated;
  }

  /**
   * Pre-build lightweight caches for resolution.
   * Node lookups are now handled by indexed SQLite queries instead of
   * loading all nodes into memory (which caused OOM on large codebases).
   * We cache the set of known symbol names for fast pre-filtering.
   */
  warmCaches(diagnostics?: ResolutionDiagnostics, nameLookup: NameLookupMode = 'full'): void {
    // Reuse a complete Set if already available. An indexed epoch must be
    // promoted before a later bulk call; it is never a partial knownNames Set.
    const indexed = nameLookup === 'indexed' && this.knownNames === null;
    const ready = this.cachesWarmed || (indexed && this.indexedNames !== null && this.knownFiles !== null);
    if (diagnostics) {
      diagnostics.cache = ready ? 'warm' : 'cold';
      diagnostics.knownFiles = this.knownFiles?.size ?? 0;
      diagnostics.knownNames = indexed ? 'not-loaded' : this.knownNames?.size ?? 0;
      diagnostics.nameLookup = indexed ? 'indexed' : 'full';
      diagnostics.nameCacheEntries = indexed ? this.indexedNames?.size ?? 0 : 0;
    }
    if (ready) return;

    // Only cache the set of known file paths (lightweight string set)
    if (this.knownFiles === null) {
      const files = measureResolution(diagnostics, 'fileNamesLoadMs', () => this.queries.getAllFilePaths());
      this.knownFiles = measureResolution(diagnostics, 'fileNamesSetMs', () => new Set(files));
    }
    if (diagnostics) diagnostics.knownFiles = this.knownFiles.size;

    if (indexed) {
      this.indexedNames ??= new IndexedNameLookup(name => this.queries.hasNodeName(name));
      return;
    }

    // Cache all distinct symbol names for fast pre-filtering (just strings, not full nodes)
    const names = measureResolution(diagnostics, 'symbolNamesLoadMs', () => this.queries.getAllNodeNames());
    this.knownNames = measureResolution(diagnostics, 'symbolNamesSetMs', () => new Set(names));
    if (diagnostics) diagnostics.knownNames = this.knownNames.size;

    this.indexedNames = null;
    this.cachesWarmed = true;
  }

  /**
   * Clear internal caches
   */
  clearCaches(): void {
    this.nodeCache.clear();
    this.fileCache.clear();
    this.textCache.clear();
    this.importMappingCache.clear();
    this.reExportCache.clear();
    this.nameCache.clear();
    this.lowerNameCache.clear();
    this.qualifiedNameCache.clear();
    this.methodMatchCache.clear();
    this.methodOwnerIndexCache.clear();
    this.nodesByKindCache.clear();
    this.supertypeMemo.clear();
    this.supertypeGeneration++;
    this.knownNames = null;
    this.indexedNames = null;
    this.knownFiles = null;
    this.cachesWarmed = false;
    // Drop the canonical-path (realpath) cache so a repointed symlink is
    // reflected on the next resolve pass rather than serving a stale canonical.
    clearCanonicalCache();
  }

  /**
   * Create the resolution context
   */
  private createContext(): ResolutionContext {
    return {
      getNodesInFile: (filePath: string) => {
        // Canonicalize so a path reaching the file via a symlink resolves to
        // the same canonical (realpath-relative) key the file was indexed under.
        // Main defense: framework resolvers and every file-level lookup funnel
        // through here, so they get canonical consistency for free.
        const c = canonicalFilePath(this.projectRoot, filePath);
        if (!this.nodeCache.has(c)) {
          this.nodeCache.set(c, this.queries.getNodesByFile(c));
        }
        return this.nodeCache.get(c)!;
      },

      getNodesByName: (name: string) => {
        const cached = this.nameCache.get(name);
        if (cached !== undefined) return cached;
        const result = this.queries.getNodesByName(name);
        this.nameCache.set(name, result);
        return result;
      },

      getMethodMatches: (typeName: string, methodName: string, language) => {
        if (!this.equivalenceCachesEnabled) {
          const want = `${typeName}::${methodName}`;
          return this.queries
            .getNodesByName(methodName)
            .filter(
              (candidate) =>
                candidate.kind === 'method' &&
                candidate.language === language &&
                (
                  candidate.qualifiedName === want ||
                  candidate.qualifiedName.endsWith(`::${want}`)
                )
            );
        }
        const cacheKey = `${language}\0${typeName}::${methodName}`;
        const cached = this.methodMatchCache.get(cacheKey);
        if (cached !== undefined) return cached;

        let candidates = this.nameCache.get(methodName);
        if (candidates === undefined) {
          candidates = this.queries.getNodesByName(methodName);
          this.nameCache.set(methodName, candidates);
        }

        const want = `${typeName}::${methodName}`;
        let matches: Node[];
        if (typeName.includes('::') || methodName.includes(':')) {
          // Preserve the exact legacy predicate for shapes that cannot use the
          // two-segment owner index.
          matches = [];
          for (const candidate of candidates) {
            if (candidate.kind !== 'method' || candidate.language !== language) continue;
            const qualifiedName = candidate.qualifiedName;
            if (
              qualifiedName === want ||
              qualifiedName.endsWith(`::${want}`)
            ) {
              matches.push(candidate);
            }
          }
        } else {
          const ownerIndexKey = `${language}\0${methodName}`;
          let ownerIndex = this.methodOwnerIndexCache.get(ownerIndexKey);
          if (!ownerIndex) {
            ownerIndex = new Map<string, Node[]>();
            for (const candidate of candidates) {
              if (candidate.kind !== 'method' || candidate.language !== language) continue;
              const qualifiedName = candidate.qualifiedName;
              const lastSeparator = qualifiedName.lastIndexOf('::');
              if (lastSeparator < 0) continue;
              const ownerSeparator = qualifiedName.lastIndexOf('::', lastSeparator - 1);
              const key =
                ownerSeparator < 0
                  ? qualifiedName
                  : qualifiedName.slice(ownerSeparator + 2);
              const bucket = ownerIndex.get(key);
              if (bucket) bucket.push(candidate);
              else ownerIndex.set(key, [candidate]);
            }
            this.methodOwnerIndexCache.set(ownerIndexKey, ownerIndex);
          }
          matches = ownerIndex.get(want) ?? [];
        }

        this.methodMatchCache.set(cacheKey, matches);
        return matches;
      },

      getNodesByQualifiedName: (qualifiedName: string) => {
        const cached = this.qualifiedNameCache.get(qualifiedName);
        if (cached !== undefined) return cached;
        const result = this.queries.getNodesByQualifiedNameExact(qualifiedName);
        this.qualifiedNameCache.set(qualifiedName, result);
        return result;
      },

      getNodesByKind: (kind: Node['kind']) => {
        if (!this.equivalenceCachesEnabled) {
          return this.queries.getNodesByKind(kind);
        }
        const cached = this.nodesByKindCache.get(kind);
        if (cached !== undefined) return cached;
        const result = this.queries.getNodesByKind(kind);
        this.nodesByKindCache.set(kind, result);
        return result;
      },

      fileExists: (filePath: string) => {
        // Canonicalize so a symlink path hits the canonical (realpath-relative)
        // entry in knownFiles; otherwise the disk fallback could say "true"
        // while no stored node matches that logical path (silent resolution miss).
        const c = canonicalFilePath(this.projectRoot, filePath);
        // Check pre-built known files set first (O(1))
        if (this.knownFiles) {
          if (this.knownFiles.has(c)) {
            return true;
          }
        }
        // Fall back to filesystem for files not yet indexed
        const fullPath = path.join(this.projectRoot, c);
        try {
          return fs.existsSync(fullPath);
        } catch (error) {
          logDebug('Error checking file existence', { filePath, error: String(error) });
          return false;
        }
      },

      readFile: (filePath: string) => {
        const c = canonicalFilePath(this.projectRoot, filePath);
        if (this.fileCache.has(c)) {
          return this.fileCache.get(c)!;
        }

        const fullPath = path.join(this.projectRoot, c);
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          this.fileCache.set(c, content);
          return content;
        } catch (error) {
          logDebug('Failed to read file for resolution', { filePath, error: String(error) });
          this.fileCache.set(c, null);
          return null;
        }
      },

      getFileLines: (filePath: string) => {
        // Always obtain the resolver's current content first. If the file
        // cache was evicted/refilled, a same-path edit cannot hit stale lines.
        const source = this.context.readFile(filePath);
        return source === null ? null : this.textCache.fileLines(source);
      },

      getNameWords: (name: string) => this.textCache.nameWords(name),

      getProjectRoot: () => this.projectRoot,

      getAllFiles: () => {
        return this.queries.getAllFilePaths();
      },

      listDirectories: (relativePath: string) => {
        const target = relativePath === '.' || relativePath === ''
          ? this.projectRoot
          : path.join(this.projectRoot, relativePath);
        try {
          return fs
            .readdirSync(target, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
        } catch (error) {
          logDebug('Failed to list directory for resolution', {
            relativePath,
            error: String(error),
          });
          return [];
        }
      },

      getNodesByLowerName: (lowerName: string) => {
        const cached = this.lowerNameCache.get(lowerName);
        if (cached !== undefined) return cached;
        const result = this.queries.getNodesByLowerName(lowerName);
        this.lowerNameCache.set(lowerName, result);
        return result;
      },

      getSupertypes: (typeName: string, language) => {
        const memoKey = `${language}\0${typeName}`;
        if (this.supertypeInProgress.has(memoKey)) return [];
        if (this.equivalenceCachesEnabled) {
          const memoized = this.supertypeMemo.get(memoKey);
          if (memoized?.generation === this.supertypeGeneration) {
            return memoized.values;
          }
        }
        // Union the `implements`/`extends` targets of every same-named type node.
        // Matching by simple name (not id) reconciles a type declared in one node
        // (`KF::Builder`) with conformance declared in a separate extension node
        // (`KF.Builder: KFOptionSetter`) — both have name `Builder`.
        const typeNodes = (language === 'cpp' && typeName.includes('::')
          ? this.context.getNodesByQualifiedName(typeName)
          : this.context.getNodesByName(typeName))
          .filter((n) => SUPERTYPE_BEARING_KINDS.has(n.kind) && n.language === language);
        if (typeNodes.length === 0) {
          if (!this.equivalenceCachesEnabled) return [];
          this.supertypeMemo.set(memoKey, {
            generation: this.supertypeGeneration,
            values: [],
            declared: false,
          });
          return [];
        }
        const supertypes = new Set<string>();
        let declared = false;
        this.supertypeInProgress.add(memoKey);
        try {
          for (const tn of typeNodes) {
            const edges = this.queries.getOutgoingEdges(tn.id, ['implements', 'extends']);
            declared ||= edges.length > 0;
            for (const edge of edges) {
              const target = this.queries.getNodeById(edge.target);
              if (target?.name && target.name !== typeName) supertypes.add(language === 'cpp' ? target.qualifiedName : target.name);
            }
            if (language === 'cpp') {
              // In a first/full pass the inheritance references are extracted but
              // their edges may not be persisted yet. Read that same pending
              // relation instead of making method resolution depend on batch order
              // (or on a previous sync having already populated the extends edge).
              const pendingBases = this.queries.getPendingSupertypes(tn.id);
              declared ||= pendingBases.length > 0;
              for (const pending of pendingBases) {
                const resolved = this.resolveOne({...pending, filePath:tn.filePath, language:tn.language});
                const target = resolved && this.queries.getNodeById(resolved.targetNodeId);
                if (target && SUPERTYPE_BEARING_KINDS.has(target.kind) && target.language === language
                  && target.name !== typeName) supertypes.add(target.qualifiedName);
              }
            }
          }
        } finally { this.supertypeInProgress.delete(memoKey); }
        const values = [...supertypes];
        if (this.equivalenceCachesEnabled) {
          this.supertypeMemo.set(memoKey, {
            generation: this.supertypeGeneration,
            values,
            declared,
          });
          if (this.supertypeMemo.size > 50_000) {
            this.supertypeMemo.clear();
            this.supertypeMemo.set(memoKey, {
              generation: this.supertypeGeneration,
              values,
              declared,
            });
          }
        }
        return values;
      },

      hasCppInheritance: (typeName: string) => {
        const key = `cpp\0${typeName}`;
        if (this.supertypeInProgress.has(key)) return true; // incomplete recursive evidence
        this.context.getSupertypes!(typeName, 'cpp');
        const memoized = this.supertypeMemo.get(key);
        if (this.equivalenceCachesEnabled && memoized?.generation === this.supertypeGeneration) return memoized.declared;
        // Debug cache-off mode must give the same answer, without retaining an
        // extra graph cache. Normally the preceding failed lookup already
        // supplied both resolved and pending bases to the existing memo.
        const types = typeName.includes('::') ? this.context.getNodesByQualifiedName(typeName) : this.context.getNodesByName(typeName);
        return types.some(n => n.language === 'cpp' && SUPERTYPE_BEARING_KINDS.has(n.kind) &&
          (this.queries.getOutgoingEdges(n.id, ['extends', 'implements']).length > 0 || this.queries.getPendingSupertypes(n.id).length > 0));
      },

      getImportMappings: (filePath: string, language) => {
        const cacheKey = filePath;
        const cached = this.importMappingCache.get(cacheKey);
        if (cached) return cached;

        const content = this.context.readFile(filePath);
        if (!content) {
          this.importMappingCache.set(cacheKey, []);
          return [];
        }

        const mappings = extractImportMappings(filePath, content, language);
        this.importMappingCache.set(cacheKey, mappings);
        return mappings;
      },

      getProjectAliases: () => {
        if (this.projectAliases === undefined) {
          this.projectAliases = loadProjectAliases(this.projectRoot);
        }
        return this.projectAliases;
      },

      getGoModule: () => {
        if (this.goModule === undefined) {
          this.goModule = loadGoModule(this.projectRoot);
        }
        return this.goModule;
      },

      getWorkspacePackages: () => {
        if (this.workspacePackages === undefined) {
          this.workspacePackages = loadWorkspacePackages(this.projectRoot);
        }
        return this.workspacePackages;
      },

      getReExports: (filePath: string, language) => {
        const c = canonicalFilePath(this.projectRoot, filePath);
        const cached = this.reExportCache.get(c);
        if (cached) return cached;
        const content = this.context.readFile(c);
        if (!content) {
          this.reExportCache.set(c, []);
          return [];
        }
        // Re-exports are a JS/TS-only construct, and what matters is the
        // BARREL file's own language — not the consuming reference's. A
        // `.svelte`/`.vue` consumer threads its own language down the
        // re-export chase, which would make extractReExports() bail on a
        // `.ts` index barrel and silently break the chain (#629). Re-key
        // the parse on the barrel's extension so the chase works no matter
        // what kind of file imports through it.
        const isJsFamily = /\.(?:d\.ts|[cm]?tsx?|[cm]?jsx?)$/i.test(c);
        const reExports = extractReExports(content, isJsFamily ? 'typescript' : language);
        this.reExportCache.set(c, reExports);
        return reExports;
      },

      getCppIncludeDirs: () => {
        return loadCppIncludeDirs(this.projectRoot);
      },
    };
  }

  /**
   * Resolve all unresolved references
   */
  resolveAll(
    unresolvedRefs: UnresolvedReference[],
    onProgress?: (current: number, total: number) => void,
    diagnostics?: ResolutionDiagnostics,
    nameLookup: NameLookupMode = 'full',
  ): ResolutionResult {
    // Public/bulk callers retain full prewarming. Explicit scoped sync passes
    // share bounded indexed probes until their cache epoch is invalidated.
    if (diagnostics) diagnostics.refs = unresolvedRefs.length;
    this.warmCaches(diagnostics, nameLookup);
    // Implements/extends edges may have advanced since the previous batch.
    // Reuse supertype answers only within this fixed-edge-state call.
    this.supertypeGeneration++;
    if (this.supertypeMemo.size > 50_000) this.supertypeMemo.clear();

    const resolved: ResolvedRef[] = [];
    const unresolved: UnresolvedRef[] = [];
    const byMethod: Record<string, number> = {};

    // Convert to our internal format, using denormalized fields when available
    const refs: UnresolvedRef[] = measureResolution(diagnostics, 'normalizeMs', () => unresolvedRefs.map((ref) => ({
      rowId: ref.rowId,
      fromNodeId: ref.fromNodeId,
      referenceName: ref.referenceName,
      referenceKind: ref.referenceKind,
      line: ref.line,
      column: ref.column,
      filePath: ref.filePath || this.getFilePathFromNodeId(ref.fromNodeId),
      language: ref.language || this.getLanguageFromNodeId(ref.fromNodeId),
    })));

    const total = refs.length;
    let lastReportedPercent = -1;

    let promotionMs = 0;
    const match = () => {
      for (let i = 0; i < refs.length; i++) {
        const reason = this.indexedNames?.promotionReason ?? 'none';
        if (reason !== 'none') {
          if (diagnostics) diagnostics.namePromotion = reason;
          const started = diagnostics ? performance.now() : 0;
          try { this.warmCaches(diagnostics, 'full'); }
          finally { if (diagnostics) promotionMs += performance.now() - started; }
        }
        const ref = refs[i]!; // Array index is guaranteed to be in bounds
        const result = this.resolveOne(ref);

        if (result) {
          resolved.push(result);
          byMethod[result.resolvedBy] = (byMethod[result.resolvedBy] || 0) + 1;
        } else {
          unresolved.push(ref);
        }

        // Report progress every 1% to avoid too many updates
        if (onProgress) {
          const currentPercent = Math.floor((i / total) * 100);
          if (currentPercent > lastReportedPercent) {
            lastReportedPercent = currentPercent;
            onProgress(i + 1, total);
          }
        }
      }

      // Final progress report
      if (onProgress && total > 0) {
        onProgress(total, total);
      }
    };
    try {
      // Capture the original lookup even if promotion drops it mid-pass.
      const lookup = this.indexedNames;
      measureResolution(diagnostics, 'matchMs', () => lookup
        ? lookup.capture(diagnostics, match) : match());
    } finally {
      // The full-name warmup already has its own timers; don't count it twice.
      if (diagnostics) diagnostics.timings.matchMs = Math.max(0, diagnostics.timings.matchMs - promotionMs);
    }
    if (diagnostics) {
      diagnostics.resolved = resolved.length;
      diagnostics.unresolved = unresolved.length;
    }

    return {
      resolved,
      unresolved,
      stats: {
        total: refs.length,
        resolved: resolved.length,
        unresolved: unresolved.length,
        byMethod,
      },
    };
  }

  /**
   * Resolve a worker-owned list without database side effects and drain the
   * deferred conformance queue produced by exactly this list.
   */
  resolveListForAdmission(refs: UnresolvedReference[]): ResolverAdmissionResult {
    const result = this.resolveAll(refs);
    return {
      resolved: result.resolved,
      unresolved: result.unresolved,
      deferredChain: this.deferredChainRefs.splice(0),
      byMethod: result.stats.byMethod,
    };
  }

  /** Re-admit worker-produced deferred refs in original input order. */
  appendDeferredFromWorkers(refs: UnresolvedRef[]): void {
    this.deferredChainRefs.push(...refs);
  }

  /** Exact membership, with the same false result when no lookup is prepared. */
  private hasKnownName(name: string): boolean {
    return this.knownNames ? this.knownNames.has(name) : this.indexedNames?.has(name) ?? false;
  }

  /** Preserve every pre-filter spelling rule; only membership storage varies. */
  private hasAnyPossibleMatch(name: string): boolean {
    if (!this.knownNames && !this.indexedNames) return true; // no pre-filter available

    // Direct name match
    if (this.hasKnownName(name)) return true;

    // For qualified names like "obj.method" or "Class::method", check the parts
    const dotIdx = name.indexOf('.');
    if (dotIdx > 0) {
      const receiver = name.substring(0, dotIdx);
      const member = name.substring(dotIdx + 1);
      if (this.hasKnownName(receiver) || this.hasKnownName(member)) return true;
      // Also check capitalized receiver (instance-method resolution)
      const capitalized = receiver.charAt(0).toUpperCase() + receiver.slice(1);
      if (this.hasKnownName(capitalized)) return true;
      // JVM FQN: `com.example.foo.Bar` — the only useful segment is the
      // last one (`Bar`); the earlier check finds `example.foo.Bar` which
      // never matches a node name.
      const lastDot = name.lastIndexOf('.');
      if (lastDot > dotIdx) {
        const tail = name.substring(lastDot + 1);
        if (tail && this.hasKnownName(tail)) return true;
      }
    }
    const colonIdx = name.indexOf('::');
    if (colonIdx > 0) {
      const receiver = name.substring(0, colonIdx);
      const member = name.substring(colonIdx + 2);
      if (this.hasKnownName(receiver) || this.hasKnownName(member)) return true;
      // Multi-segment path `a::b::c` (a Rust/C++ module call like
      // `database::profiles::find`) — the only segment that names a symbol is
      // the last (`c`); `member` above is `b::c`, which never matches a node
      // name, so without this the pre-filter drops the ref before the Rust path
      // resolver ever sees it. Mirror the dotted-name leaf check above.
      const lastColon = name.lastIndexOf('::');
      if (lastColon > colonIdx) {
        const tail = name.substring(lastColon + 2);
        if (tail && this.hasKnownName(tail)) return true;
      }
    }

    // For path-like references (e.g., "snippets/drawer-menu.liquid"), check the filename
    const slashIdx = name.lastIndexOf('/');
    if (slashIdx > 0) {
      const fileName = name.substring(slashIdx + 1);
      if (this.hasKnownName(fileName)) return true;
    }

    return false;
  }

  /**
   * Does `ref.referenceName` match an import declared in its containing
   * file? Used as a pre-filter escape so re-export chain resolution
   * still gets a chance when the name has no project-wide declaration.
   */
  private matchesAnyImport(ref: UnresolvedRef): boolean {
    const imports = this.context.getImportMappings(ref.filePath, ref.language);
    if (imports.length === 0) return false;
    for (const imp of imports) {
      if (
        imp.localName === ref.referenceName ||
        ref.referenceName.startsWith(imp.localName + '.')
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Resolve a single reference
   */
  resolveOne(ref: UnresolvedRef): ResolvedRef | null {
    // Skip built-in/external references
    if (this.isBuiltInOrExternal(ref)) {
      return null;
    }

    // Fast pre-filter: skip if no symbol with this name exists anywhere
    // AND the name doesn't match a local import. The import escape is
    // necessary because re-export rename chains (`import { login }
    // from './barrel'` where the barrel has `export { signIn as login }
    // from './auth'`) intentionally call a name that has no
    // declaration anywhere — only the renamed upstream symbol does.
    if (
      !this.hasAnyPossibleMatch(ref.referenceName) &&
      !this.matchesAnyImport(ref) &&
      !this.frameworks.some((f) => f.claimsReference?.(ref.referenceName))
    ) {
      return null;
    }

    // JVM FQN imports skip framework/name-matcher: `import com.example.Bar`
    // resolves directly through the qualifiedName index, which is unambiguous
    // even when several `Bar` classes exist in different packages.
    const jvmImport = resolveJvmImport(ref, this.context);
    if (jvmImport) return jvmImport;

    // Razor/Blazor: a markup or `@code` type ref resolves through the file's
    // `@using` namespaces (incl. folder `_Imports.razor`). This precisely
    // disambiguates a simple name that exists in several namespaces — e.g.
    // `CatalogBrand` resolving to `BlazorShared.Models::CatalogBrand` (the DTO,
    // which the `.razor` `@using`s) rather than the same-named domain entity.
    if (ref.language === 'razor') {
      const razorResult = this.resolveRazorUsing(ref);
      if (razorResult) return razorResult;
    }

    const candidates: ResolvedRef[] = [];

    // Strategy 1: Try framework-specific resolution. Cross-language bridges
    // are deliberately preserved (Drupal `routing.yml` → PHP controller, RN
    // JS → native `calls`) — `gateFrameworkLanguage` only drops a type/import
    // edge between two KNOWN families (see its doc), never a `calls` bridge or
    // a config↔code edge.
    for (const framework of this.frameworks) {
      const result = this.gateFrameworkLanguage(framework.resolve(ref, this.context), ref);
      if (result) {
        if (result.confidence >= 0.9) return result; // High confidence, return immediately
        candidates.push(result);
      }
    }

    // Strategy 2: Try import-based resolution
    const importResult = this.gateLanguage(resolveViaImport(ref, this.context), ref);
    if (importResult) {
      if (importResult.confidence >= 0.9) return importResult;
      candidates.push(importResult);
    }

    // PHP include/require paths resolve to files via import resolution only.
    // If that didn't find the file, do NOT fall back to the symbol
    // name-matcher — it would mis-connect e.g. "inc/db.php" to an unrelated
    // db.php elsewhere in the tree (a wrong edge is worse than none, #660).
    if (isPhpIncludePathRef(ref)) {
      return candidates.length > 0
        ? candidates.reduce((best, curr) =>
            curr.confidence > best.confidence ? curr : best
          )
        : null;
    }

    // Strategy 3: Try name matching
    const nameResult = this.gateLanguage(matchReference(ref, this.context), ref);
    if (nameResult) {
      candidates.push(nameResult);
    }

    if (candidates.length === 0) {
      // Defer a chained static-factory/fluent call the first pass couldn't
      // resolve — its method may live on a supertype the receiver conforms to,
      // resolvable once implements/extends edges exist (the conformance pass).
      if (
        ref.referenceKind === 'calls' &&
        CHAIN_LANGUAGES.has(ref.language) &&
        CHAIN_SHAPE.test(ref.referenceName)
      ) {
        this.deferredChainRefs.push(ref);
      }
      return null;
    }

    // Return highest confidence candidate
    return candidates.reduce((best, curr) =>
      curr.confidence > best.confidence ? curr : best
    );
  }

  /**
   * Create edges from resolved references
   */
  createEdges(resolved: ResolvedRef[]): Edge[] {
    return resolved.map((ref) => {
      let kind = ref.original.referenceKind;

      // Promote "extends" to "implements" when a class/struct targets an interface
      if (kind === 'extends') {
        const targetNode = this.queries.getNodeById(ref.targetNodeId);
        if (targetNode && (targetNode.kind === 'interface' || targetNode.kind === 'protocol')) {
          const sourceNode = this.queries.getNodeById(ref.original.fromNodeId);
          if (sourceNode && sourceNode.kind !== 'interface' && sourceNode.kind !== 'protocol') {
            kind = 'implements';
          }
        }
      }

      // Promote "calls" to "instantiates" when the resolved target is a
      // class/struct. Languages without a `new` keyword (Python, Ruby)
      // express instantiation as `Foo()` — extraction can't tell that
      // apart from a function call without symbol info, but resolution
      // can: if `Foo` resolves to a class, the call IS an instantiation.
      if (kind === 'calls') {
        const targetNode = this.queries.getNodeById(ref.targetNodeId);
        if (targetNode && (targetNode.kind === 'class' || targetNode.kind === 'struct')) {
          kind = 'instantiates';
        }
      }

      return {
        source: ref.original.fromNodeId,
        target: ref.targetNodeId,
        kind,
        line: ref.original.line,
        column: ref.original.column,
        metadata: {
          confidence: ref.confidence,
          resolvedBy: ref.resolvedBy,
          // Preserve the exact extracted reference. If the target file is
          // later deleted, sync can reconstruct the same reference without
          // losing C++ receiver/namespace context such as `ns::helper`.
          refName: ref.original.referenceName,
          ...(ref.original.referenceKind !== kind
            ? { refKind: ref.original.referenceKind }
            : {}),
        },
      };
    });
  }

  private static partitionCleanup(refs: UnresolvedRef[]): {
    rowIds: number[];
    legacyKeys: Array<{
      fromNodeId: string;
      referenceName: string;
      referenceKind: string;
    }>;
  } {
    const rowIds: number[] = [];
    const legacyKeys: Array<{
      fromNodeId: string;
      referenceName: string;
      referenceKind: string;
    }> = [];
    for (const ref of refs) {
      if (ref.rowId !== undefined) {
        rowIds.push(ref.rowId);
      } else {
        legacyKeys.push({
          fromNodeId: ref.fromNodeId,
          referenceName: ref.referenceName,
          referenceKind: ref.referenceKind,
        });
      }
    }
    return { rowIds, legacyKeys };
  }

  private static partitionFailedCleanup(refs: UnresolvedRef[]): {
    byRowId: Array<{ rowId: number; referenceName: string }>;
    legacyKeys: Array<{
      fromNodeId: string;
      referenceName: string;
      referenceKind: string;
    }>;
  } {
    const byRowId: Array<{ rowId: number; referenceName: string }> = [];
    const legacyKeys: Array<{
      fromNodeId: string;
      referenceName: string;
      referenceKind: string;
    }> = [];
    for (const ref of refs) {
      if (ref.rowId !== undefined) {
        byRowId.push({ rowId: ref.rowId, referenceName: ref.referenceName });
      } else {
        legacyKeys.push({
          fromNodeId: ref.fromNodeId,
          referenceName: ref.referenceName,
          referenceKind: ref.referenceKind,
        });
      }
    }
    return { byRowId, legacyKeys };
  }

  /**
   * Resolve and persist edges to database
   */
  resolveAndPersist(
    unresolvedRefs: UnresolvedReference[],
    onProgress?: (current: number, total: number) => void,
    diagnostics?: ResolutionDiagnostics,
    nameLookup: NameLookupMode = 'full',
    requireExactRowCleanup: boolean = false,
  ): ResolutionResult {
    if (requireExactRowCleanup && unresolvedRefs.some(ref =>
      !Number.isSafeInteger(ref.rowId) || ref.rowId! <= 0)) {
      throw new Error('Scoped reference cleanup requires database row IDs');
    }
    const result = this.resolveAll(unresolvedRefs, onProgress, diagnostics, nameLookup);
    let removedPending = 0;

    // Create edges from resolved references
    const edges = measureResolution(diagnostics, 'edgeBuildMs', () => this.createEdges(result.resolved));
    if (diagnostics) diagnostics.edges = edges.length;

    // Insert edges into database
    if (edges.length > 0) {
      measureResolution(diagnostics, 'edgeInsertMs', () => this.queries.insertEdges(edges));
    }

    // Clean up resolved refs from unresolved_refs table so metrics are accurate
    if (result.resolved.length > 0) {
      measureResolution(diagnostics, 'resolvedCleanupMs', () => {
        const cleanup = ReferenceResolver.partitionCleanup(
          result.resolved.map((ref) => ref.original)
        );
        removedPending += this.queries.deleteReferencesByRowIds(cleanup.rowIds);
        this.queries.deleteSpecificResolvedReferences(cleanup.legacyKeys);
      });
    }

    // A completed pass must also remove failures from the pending set. Keep
    // them parked for a later symbol-driven retry instead of deleting them.
    if (result.unresolved.length > 0) {
      measureResolution(diagnostics, 'failedCleanupMs', () => {
        const cleanup = ReferenceResolver.partitionFailedCleanup(result.unresolved);
        removedPending += this.queries.markReferencesFailedByRowIds(cleanup.byRowId);
        this.queries.markReferencesFailed(cleanup.legacyKeys);
      });
    }

    if (requireExactRowCleanup) {
      // Count actual writes, not a full pending-table COUNT per page. A seek
      // cursor must never hide a failed cleanup by advancing past its rows.
      measureResolution(diagnostics, 'failedCleanupMs', () => {
        if (removedPending !== unresolvedRefs.length) {
          throw new Error(`Scoped reference cleanup incomplete: consumed ${removedPending} of ${unresolvedRefs.length} rows`);
        }
      });
    }
    return result;
  }

  /**
   * Bound database reads AND resolution outputs for scoped sync. Keep one
   * page and scalar counters, sharing the existing cache epoch. Loading all
   * files before slicing would still retain millions of reference objects.
   */
  async resolveFilesAndPersist(
    filePaths: readonly string[],
    onProgress?: (current: number, total: number) => void,
    options: {
      diagnostics?: ResolutionDiagnostics;
      nameLookup?: NameLookupMode | 'sync';
      batchSize?: number;
    } = {},
  ): Promise<number> {
    const size = options.batchSize ?? SCOPED_REFERENCE_BATCH_SIZE;
    if (!Number.isSafeInteger(size) || size < 1 || size > SCOPED_REFERENCE_BATCH_SIZE) {
      throw new Error(`Reference batch size must be between 1 and ${SCOPED_REFERENCE_BATCH_SIZE}`);
    }
    const detail = options.diagnostics;
    const plan = measureResolution(detail, 'loadRefsMs',
      () => this.queries.planPendingReferencesByFiles(filePaths));
    if (detail) detail.plannedRefs = plan.total;
    const nameLookup = options.nameLookup === 'sync'
      ? syncNameLookupMode(plan.total) : options.nameLookup ?? 'full';
    let processed = 0;
    let lastPercent = -1;
    for (const chunk of plan.chunks) {
      let cursor: PendingReferenceCursor | undefined;
      let chunkProcessed = 0;
      while (chunkProcessed < chunk.total) {
        const batchDetail = detail ? new ResolutionDiagnostics(detail.scope) : undefined;
        try {
          const batch = measureResolution(batchDetail, 'loadRefsMs', () => {
            const refs = this.queries.getPendingReferenceFileBatch(chunk, cursor, size);
            const last = refs[refs.length - 1];
            if (!last || last.rowId === undefined || last.filePath === undefined ||
                (last.filePath === cursor?.filePath && last.rowId <= cursor.rowId) ||
                chunkProcessed + refs.length > chunk.total) {
              throw new Error('Scoped reference snapshot changed or cursor made no progress');
            }
            cursor = { filePath: last.filePath, rowId: last.rowId };
            return refs;
          });
          if (detail) {
            detail.batches++;
            detail.maxBatchRefs = Math.max(detail.maxBatchRefs, batch.length);
          }
          // Exact row-ID cleanup leaves the current/unvisited pages pending
          // on interruption. The caller promotes the journal only on success.
          this.resolveAndPersist(batch, onProgress ? (current) => {
            const value = processed + current;
            const percent = Math.floor(value / plan.total * 100);
            if (percent > lastPercent) {
              lastPercent = percent;
              onProgress(value, plan.total);
            }
          } : undefined, batchDetail, nameLookup, true);
          processed += batch.length;
          chunkProcessed += batch.length;
        } finally {
          if (detail && batchDetail) detail.add(batchDetail);
        }
        // Yield only between completed writes, with no open SQLite reader or
        // transaction. A one-page small sync needs no extra event-loop turn.
        if (processed < plan.total) await new Promise<void>(resolve => setImmediate(resolve));
      }
    }
    return processed;
  }

  /**
   * Cooperative, bounded counterpart used for failed-reference retries during
   * sync. Each chunk is fully persisted before yielding to the event loop.
   */
  async resolveAndPersistListYielding(
    refs: UnresolvedReference[],
    batchSize: number = 500
  ): Promise<ResolutionResult> {
    const safeBatchSize = Math.max(1, Math.floor(batchSize));
    const aggregate: ResolutionResult = {
      resolved: [],
      unresolved: [],
      stats: { total: 0, resolved: 0, unresolved: 0, byMethod: {} },
    };

    for (let offset = 0; offset < refs.length; offset += safeBatchSize) {
      const result = this.resolveAndPersist(refs.slice(offset, offset + safeBatchSize));
      aggregate.resolved.push(...result.resolved);
      aggregate.unresolved.push(...result.unresolved);
      aggregate.stats.total += result.stats.total;
      aggregate.stats.resolved += result.stats.resolved;
      aggregate.stats.unresolved += result.stats.unresolved;
      for (const [method, count] of Object.entries(result.stats.byMethod)) {
        aggregate.stats.byMethod[method] =
          (aggregate.stats.byMethod[method] ?? 0) + count;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    return aggregate;
  }

  /**
   * Rebuild only the C/C++ heuristic relationships invalidated by the files
   * replaced during incremental sync. The synthesizer uses indexed, scoped
   * lookups; it does not run the full callback/framework synthesis pipeline.
   */
  async synthesizeIncrementalCCpp(filePaths: readonly string[]): Promise<number> {
    this.clearCaches();
    try {
      return await synthesizeIncrementalCCppEdges(this.queries, filePaths);
    } finally {
      // Heuristic inserts are immediately visible to subsequent conformance
      // and impact queries; do not leave any pre-synthesis cache entries live.
      this.clearCaches();
    }
  }

  /**
   * Second resolution pass for chained static-factory / fluent calls whose
   * chained method is defined on a SUPERTYPE the receiver's type conforms to —
   * a protocol-extension / inherited / default-interface method (#750). The
   * first pass can't resolve these because `implements`/`extends` edges aren't
   * built yet; this runs AFTER edges are persisted, so `context.getSupertypes`
   * (and the conformance fallback in resolveMethodOnType) can walk them.
   *
   * Operates only on the leftover unresolved refs that have the `inner().method`
   * chain shape, for the dotted-chain languages — a small set — and is idempotent
   * (re-resolving an already-resolved ref is a no-op since it's been deleted).
   * Returns the number of newly-created edges.
   */
  resolveChainedCallsViaConformance(): number {
    const deferred = this.deferredChainRefs;
    this.deferredChainRefs = [];
    if (deferred.length === 0) return 0;

    // Read fresh edges (the main pass built the implements/extends edges after
    // these refs were deferred). matchDottedCallChain now resolves a method on a
    // supertype via context.getSupertypes -> resolveMethodOnType's conformance walk.
    this.clearCaches();
    const resolved: ResolvedRef[] = [];
    for (const ref of deferred) {
      // `::`-receiver languages (Rust) split on `::` (matchScopedCallChain);
      // dotted-receiver languages on `.` (matchDottedCallChain).
      const chainMatch = SCOPED_CHAIN_LANGUAGES.has(ref.language)
        ? matchScopedCallChain(ref, this.context)
        : matchDottedCallChain(ref, this.context);
      const match = this.gateLanguage(chainMatch, ref);
      if (match) resolved.push(match);
    }
    if (resolved.length === 0) return 0;

    const edges = this.createEdges(resolved);
    if (edges.length > 0) {
      this.queries.insertEdges(edges);
      this.clearCaches();
    }
    return edges.length;
  }

  /**
   * Resolve and persist in batches to keep memory bounded.
   * Processes unresolved references in chunks, persisting edges and cleaning
   * up resolved refs after each batch to avoid accumulating large arrays.
   */
  async resolveAndPersistBatched(
    onProgress?: (current: number, total: number) => void,
    batchSize: number = 5000,
    options?: {
      dbPath?: string;
      bulkEdgeLoad?: { begin: () => void; end: () => void | Promise<void> };
      bulkRefLoad?: { begin: () => void; end: () => void | Promise<void> };
      onSynthesisProgress?: (current: number, total: number) => void;
    }
  ): Promise<ResolutionResult> {
    this.warmCaches();

    const total = this.queries.getUnresolvedReferencesCount();
    let processed = 0;
    const aggregateStats = {
      total: 0,
      resolved: 0,
      unresolved: 0,
      byMethod: {} as Record<string, number>,
    };
    const resolutionStartedAt = Date.now();
    let sequentialBatches = 0;
    let parallelBatches = 0;

    // Large runs may resolve a fixed database batch on read-only workers. The
    // main thread remains the sole writer and admits worker results in row order.
    let pool: ResolverPool | null = null;
    let poolReady = false;
    if (options?.dbPath && total >= minRefsForResolverPool()) {
      pool = ResolverPool.tryCreate(options.dbPath, this.projectRoot);
      const startingPool = pool;
      if (startingPool) {
        void startingPool.ready().then(
          () => {
            if (pool === startingPool) poolReady = true;
          },
          () => {
            if (pool === startingPool) pool = null;
            void startingPool.destroy().catch(() => undefined);
          }
        );
      }
    }

    let bulkEdgesActive = false;
    let bulkRefsActive = false;
    if (total >= minRefsForResolverPool() && options?.bulkEdgeLoad) {
      // Mark active before begin(): a partially successful sequence of DDL
      // drops must still be repaired in finally if a later DROP throws.
      bulkEdgesActive = true;
      try {
        options.bulkEdgeLoad.begin();
      } catch {
        // end() in finally recreates any indexes that were partially dropped.
      }
    }
    if (total >= minRefsForResolverPool() && options?.bulkRefLoad) {
      bulkRefsActive = true;
      try {
        options.bulkRefLoad.begin();
      } catch {
        // end() in finally recreates any indexes that were partially dropped.
      }
    }

    let afterRowId = 0;
    try {
      while (true) {
        const batch = this.queries.getUnresolvedReferencesBatchAfter(afterRowId, batchSize);
        if (batch.length === 0) break;

        let result: ResolutionResult;
        if (pool && poolReady && ResolverPool.worthParallel(batch.length)) {
          try {
            const parallel = await pool.resolveBatch(batch);
            parallelBatches++;
            this.appendDeferredFromWorkers(parallel.deferredChain);
            result = {
              resolved: parallel.resolved,
              unresolved: parallel.unresolved,
              stats: {
                total: batch.length,
                resolved: parallel.resolved.length,
                unresolved: parallel.unresolved.length,
                byMethod: parallel.byMethod,
              },
            };
          } catch (error) {
            logDebug('Parallel resolution failed; retrying the batch sequentially', {
              error: error instanceof Error ? error.message : String(error),
            });
            const failedPool = pool;
            pool = null;
            poolReady = false;
            if (failedPool) await failedPool.destroy().catch(() => undefined);
            sequentialBatches++;
            result = this.resolveAll(batch);
          }
        } else {
          sequentialBatches++;
          result = this.resolveAll(batch);
        }

        // Persist edges immediately
        const edges = this.createEdges(result.resolved);
        if (edges.length > 0) {
          this.queries.insertEdges(edges);
        }

        // Delete exactly the rows attempted by this batch. Tuple cleanup is kept
        // only for hand-built references that did not originate in SQLite.
        let removedThisBatch = 0;
        const resolvedCleanup = ReferenceResolver.partitionCleanup(
          result.resolved.map((ref) => ref.original)
        );
        removedThisBatch += this.queries.deleteReferencesByRowIds(resolvedCleanup.rowIds);
        this.queries.deleteSpecificResolvedReferences(resolvedCleanup.legacyKeys);

        const unresolvedCleanup = ReferenceResolver.partitionFailedCleanup(result.unresolved);
        removedThisBatch += this.queries.markReferencesFailedByRowIds(
          unresolvedCleanup.byRowId
        );
        removedThisBatch += this.queries.markReferencesFailed(
          unresolvedCleanup.legacyKeys
        );

        // Aggregate stats
        aggregateStats.total += result.stats.total;
        aggregateStats.resolved += result.stats.resolved;
        aggregateStats.unresolved += result.stats.unresolved;
        for (const [method, count] of Object.entries(result.stats.byMethod)) {
          aggregateStats.byMethod[method] = (aggregateStats.byMethod[method] || 0) + count;
        }

        processed += batch.length;
        onProgress?.(processed, total);

        // Yield so progress UI can render between batches
        await new Promise(resolve => setImmediate(resolve));

        // Non-progress guard (defense-in-depth). Every SQLite-backed row in the
        // batch must leave the pending set. If none does, stop
        // instead of repeatedly admitting edges while walking newly appended rows.
        // An entirely unresolvable batch is still progress because those exact
        // source rows are parked as failed and keyset pagination advances.
        if (removedThisBatch === 0 && batch.some((ref) => ref.rowId !== undefined)) {
          break;
        }
        afterRowId = batch[batch.length - 1]?.rowId ?? afterRowId;
      }
    } finally {
      const activePool = pool;
      pool = null;
      if (activePool) await activePool.destroy().catch(() => undefined);
      try {
        if (bulkRefsActive) await options!.bulkRefLoad!.end();
      } finally {
        if (bulkEdgesActive) await options!.bulkEdgeLoad!.end();
      }
    }

    if (process.env.CODEGRAPH_SYNTH_TIMINGS) {
      console.error(
        `[phase-timing] reference-batches=${Date.now() - resolutionStartedAt}ms ` +
          `(parallel=${parallelBatches}, sequential=${sequentialBatches})`
      );
    }

    // Keep this boundary explicit: aggregate resolver work is often reported as
    // a sum across millions of refs, whereas init optimization needs wall time
    // separate from the whole-graph synthesis tail.
    const referenceBatchesMs = Date.now() - resolutionStartedAt;

    // Dynamic-edge synthesis: now that all base `calls` edges are persisted,
    // synthesize observer/callback dispatch edges (dispatcher → registered
    // callbacks) that static parsing leaves out. Best-effort — never fail the
    // index on it. See docs/design/callback-edge-synthesis.md.
    options?.onSynthesisProgress?.(0, 1);
    // Release resolution-only name/file sets and populated LRUs before the
    // post-100% synthesis tail. Any pass-specific lookup is rebuilt lazily.
    this.clearCaches();
    await new Promise(resolve => setImmediate(resolve));
    const synthesisStartedAt = Date.now();
    let synthesisPasses: ResolutionResult['synthesisPasses'];
    const diagnostics: import('./types').ResolutionDiagnostic[] =
      this.frameworkDiagnostics.splice(0);
    try {
      const synthesis = await synthesizeCallbackEdges(
        this.queries,
        this.context
      );
      aggregateStats.byMethod['callback-synthesis'] = synthesis.edgesAdded;
      synthesisPasses = synthesis.passes;
      diagnostics.push(...synthesis.diagnostics);
    } catch (error) {
      const message = `Dynamic-edge synthesis failed: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        `The index is incomplete.`;
      console.error(`[CodeGraph] ${message}`);
      diagnostics.push({
        severity: 'error',
        code: 'synthesis_failed',
        message,
      });
    }
    if (process.env.CODEGRAPH_SYNTH_TIMINGS) {
      console.error(
        `[phase-timing] callback-synthesis=${Date.now() - synthesisStartedAt}ms`
      );
    }
    options?.onSynthesisProgress?.(1, 1);

    return {
      resolved: [],
      unresolved: [],
      stats: {
        ...aggregateStats,
        parallelBatches,
        sequentialBatches,
      },
      timings: {
        referenceBatchesMs,
        synthesisMs: Date.now() - synthesisStartedAt,
      },
      synthesisPasses,
      diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
    };
  }

  /**
   * Get detected frameworks
   */
  getDetectedFrameworks(): string[] {
    return this.frameworks.map((f) => f.name);
  }

  /**
   * Check if reference is to a built-in or external symbol
   */
  private isBuiltInOrExternal(ref: UnresolvedRef): boolean {
    const name = ref.referenceName;
    const isJsTs = ref.language === 'typescript' || ref.language === 'javascript'
      || ref.language === 'tsx' || ref.language === 'jsx';

    // JavaScript/TypeScript built-ins
    if (isJsTs && JS_BUILT_INS.has(name)) {
      return true;
    }

    // Common JS/TS library calls (console.log, Math.floor, JSON.parse)
    if (isJsTs && (name.startsWith('console.') || name.startsWith('Math.') || name.startsWith('JSON.'))) {
      return true;
    }

    // React hooks from React itself
    if (isJsTs && REACT_HOOKS.has(name)) {
      return true;
    }

    // Python built-ins (bare calls only — dotted calls like console.print are method calls)
    if (ref.language === 'python' && PYTHON_BUILT_INS.has(name)) {
      return true;
    }

    // Python built-in method calls (e.g., list.extend, dict.update)
    if (ref.language === 'python') {
      const dotIdx = name.indexOf('.');
      if (dotIdx > 0) {
        const receiver = name.substring(0, dotIdx);
        const method = name.substring(dotIdx + 1);
        // Filter calls on built-in types (list.append, dict.update, etc.)
        if (PYTHON_BUILT_IN_TYPES.has(receiver)) {
          return true;
        }
        // Filter built-in methods on non-class receivers
        // (e.g., items.append where items is a local list variable)
        // But allow if the capitalized receiver matches a known codebase class
        if (PYTHON_BUILT_IN_METHODS.has(method)) {
          const capitalized = receiver.charAt(0).toUpperCase() + receiver.slice(1);
          if (!this.hasKnownName(capitalized)) {
            return true;
          }
        }
      }
      // A bare name colliding with a builtin method (index, get, update, count…)
      // is only a builtin when NOTHING in the codebase declares it. A declared
      // symbol with that exact name — e.g. a Flask/FastAPI view `def index()` or
      // `def get()` — is a real reference target. Mirrors the knownNames guard on
      // the dotted branch above; without it, every handler named after a builtin
      // method silently loses its route→handler edge.
      if (PYTHON_BUILT_IN_METHODS.has(name) && !this.hasKnownName(name)) {
        return true;
      }
    }

    // Go standard library packages — refs like "fmt.Println", "http.ListenAndServe", etc.
    if (ref.language === 'go') {
      const dotIdx = name.indexOf('.');
      if (dotIdx > 0) {
        const pkg = name.substring(0, dotIdx);
        if (GO_STDLIB_PACKAGES.has(pkg)) {
          return true;
        }
      }
      if (GO_BUILT_INS.has(name)) {
        return true;
      }
    }

    // Pascal/Delphi built-ins and standard library units
    if (ref.language === 'pascal') {
      if (PASCAL_UNIT_PREFIXES.some((p) => name.startsWith(p))) {
        return true;
      }
      if (PASCAL_BUILT_INS.has(name)) {
        return true;
      }
    }

    // C/C++ standard library symbols (printf, malloc, std::vector, etc.).
    // Names that collide with user-defined symbols are NOT filtered —
    // C and C++ projects routinely shadow stdlib names (custom allocators
    // define `malloc`/`free`, stream wrappers define `read`/`write`/`open`,
    // containers define `move`/`swap`, logging libs wrap `printf`). Killing
    // those resolutions makes the graph wrong, not cleaner. We only filter
    // when there's no user node with this name — then name-matching would
    // produce zero edges anyway and the filter just short-circuits work.
    if (ref.language === 'c' || ref.language === 'cpp') {
      // C++ std:: namespace prefix — safe to filter unconditionally,
      // since `std::foo` is never a user-defined qualified name in
      // tree-sitter output.
      if (name.startsWith('std::')) return true;
      if (C_BUILT_INS.has(name) || CPP_BUILT_INS.has(name)) {
        return !this.hasAnyPossibleMatch(name);
      }
    }

    return false;
  }

  /**
   * Get file path from node ID
   */
  private getFilePathFromNodeId(nodeId: string): string {
    const node = this.queries.getNodeById(nodeId);
    return node?.filePath || '';
  }

  /**
   * Get language from node ID
   */
  private getLanguageFromNodeId(nodeId: string): UnresolvedRef['language'] {
    const node = this.queries.getNodeById(nodeId);
    return node?.language || 'unknown';
  }

  /**
   * Drop an import/name-strategy resolution that crosses a language family.
   * Two regimes (mirrors `applyLanguageGate`'s candidate filter):
   *  - `references` (type usage): STRICT — a `Type.member` static read names a
   *    same-family type, never a coincidentally same-named symbol in another
   *    language. Drops any non-same-family target.
   *  - `imports` (import binding / `#include`): both-known — a C++ `#include
   *    "X.h"` must not resolve to a same-named ObjC header on another platform
   *    (basename collision), but a singleton-family / SFC language (`vue` →
   *    `.ts`) importing across is left alone.
   * Applies to the import (strategy 2) + name-match (strategy 3) results.
   */
  /**
   * Collect the `@using` namespaces in scope for a `.razor`/`.cshtml` file: its
   * own `@using` directives plus every `_Imports.razor` from the file's folder up
   * to the project root (Razor `_Imports` cascade). Cached per file.
   */
  private getRazorUsings(filePath: string): string[] {
    const cached = this.razorUsingsCache.get(filePath);
    if (cached) return cached;
    const usings = new Set<string>();
    const addFrom = (src: string | null): void => {
      if (!src) return;
      for (const m of src.matchAll(/^\s*@using\s+(?:static\s+)?([A-Za-z_][\w.]*)/gm)) usings.add(m[1]!);
    };
    addFrom(this.context.readFile(filePath));
    let dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
    // Walk up to the project root, reading each level's _Imports.razor.
    for (;;) {
      addFrom(this.context.readFile(dir ? `${dir}/_Imports.razor` : '_Imports.razor'));
      if (!dir) break;
      const slash = dir.lastIndexOf('/');
      dir = slash >= 0 ? dir.slice(0, slash) : '';
    }
    const arr = [...usings];
    this.razorUsingsCache.set(filePath, arr);
    return arr;
  }

  /**
   * Resolve a Razor/Blazor simple type ref through the file's `@using`
   * namespaces: `CatalogBrand` + `@using BlazorShared.Models` → the node whose
   * qualified name is `BlazorShared.Models::CatalogBrand`. Only resolves when the
   * `@using` set yields exactly ONE type (otherwise it stays ambiguous and falls
   * through to name-matching).
   */
  private resolveRazorUsing(ref: UnresolvedRef): ResolvedRef | null {
    if (ref.referenceName.includes('.') || ref.referenceName.includes('::')) return null;
    const usings = this.getRazorUsings(ref.filePath);
    if (usings.length === 0) return null;
    const found = new Map<string, Node>();
    for (const ns of usings) {
      for (const cand of this.context.getNodesByQualifiedName(`${ns}::${ref.referenceName}`)) {
        found.set(cand.id, cand);
      }
    }
    if (found.size !== 1) return null;
    const target = found.values().next().value!;
    return { original: ref, targetNodeId: target.id, confidence: 0.9, resolvedBy: 'import' };
  }

  private gateLanguage(result: ResolvedRef | null, ref: UnresolvedRef): ResolvedRef | null {
    if (!result) return result;
    const target = this.queries.getNodeById(result.targetNodeId);
    if (ref.referenceKind === 'instantiates' && target && !isValidInstantiationTarget(target, ref)) {
      return null;
    }
    const tgt = target?.language ?? this.getLanguageFromNodeId(result.targetNodeId);
    if (!tgt || !ref.language) return result;
    if (ref.referenceKind === 'references' && !sameLanguageFamily(tgt, ref.language)) return null;
    if (
      ref.referenceKind === 'instantiates' &&
      !sameInstantiationLanguageFamily(tgt, ref.language, ref.filePath)
    ) return null;
    if (ref.referenceKind === 'imports' && crossesKnownFamily(tgt, ref.language)) return null;
    return result;
  }

  /**
   * Drop a FRAMEWORK-strategy resolution that crosses two *known* language
   * families for a type-usage (`references`) or import-binding (`imports`)
   * edge. The framework strategy is intentionally ungated for cross-language
   * bridges, but those legitimate bridges are either `calls` edges (RN/Expo
   * JS → native) or config↔code edges whose config side (`yaml`/`blade`/…) is
   * not a known programming-language family. A `references`/`imports` edge
   * between two *known* families is always a coincidental name collision — the
   * React/Svelte/Vue PascalCase component resolvers name-match `getNodesByName`
   * without a language check, so a TS `<TestRunner>` ref happily matched a
   * Kotlin `class TestRunner`. Gating only the both-known-cross-family case
   * lets config bridges and `calls` bridges through untouched.
   */
  private gateFrameworkLanguage(result: ResolvedRef | null, ref: UnresolvedRef): ResolvedRef | null {
    if (!result) return result;
    if (ref.referenceKind === 'instantiates') return this.gateLanguage(result, ref);
    if (ref.referenceKind !== 'references' && ref.referenceKind !== 'imports') return result;
    const tgt = this.getLanguageFromNodeId(result.targetNodeId);
    if (tgt && ref.language && crossesKnownFamily(tgt, ref.language)) return null;
    return result;
  }
}

/**
 * Create a reference resolver instance
 */
export function createResolver(projectRoot: string, queries: QueryBuilder): ReferenceResolver {
  const resolver = new ReferenceResolver(projectRoot, queries);
  resolver.initialize();
  return resolver;
}
