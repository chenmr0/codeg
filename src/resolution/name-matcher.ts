/**
 * Name Matcher
 *
 * Handles symbol name matching for reference resolution.
 */

import { Node } from '../types';
import { UnresolvedRef, ResolvedRef, ResolutionContext } from './types';
import { canonicalFilePath } from '../utils';
import { splitNameWords } from './text-cache';
import { stripCommentsForRegex } from './strip-comments';
import { resolveImportPath } from './import-resolver';
import * as path from 'node:path';
import { cppDeclaratorRegex as buildDeclaratorRegex, lastDeclarationBefore } from './cpp-receiver-index';
import { cppCallableSignatureKey, filterCppCallCandidates, isCppCallArityAllowed } from './cpp-call-admission';
import { filterCppBindingCandidates } from './cpp-binding-evidence';
import { cppRecoveredCallerOwner, cppFieldReceiverType } from './cpp-receiver-lookup';
import { maskCStyleCommentsAndLiterals } from '../extraction/grammars';

/**
 * Try to resolve a path-like reference (e.g., "snippets/drawer-menu.liquid")
 * by matching the filename against file nodes.
 */
export function matchByFilePath(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  if (ref.referenceKind === 'instantiates') return null;

  // Path-like (`a/b.liquid`) OR a bare filename ending in a short extension
  // (`Foo.h` — an Objective-C `#import "Foo.h"`, resolved to the header by
  // basename). A bare ref WITHOUT an extension is a symbol name, not a file, so
  // leave it to the symbol-matching strategies.
  if (!ref.referenceName.includes('/') && !/\.[A-Za-z][A-Za-z0-9]{0,3}$/.test(ref.referenceName)) {
    return null;
  }

  // Canonicalize so a reference reaching a file through a symlink (same-basename
  // or otherwise) matches the file's canonical (realpath-relative) path/name.
  // When realpath resolves, fileName becomes the canonical basename so
  // getNodesByName finds the (canonical-named) file; when it doesn't (a bare
  // name not root-relative), this degrades to the normalized logical name —
  // identical to the prior behavior.
  const refPath = canonicalFilePath(context.getProjectRoot(), ref.referenceName);

  // Extract the filename from the path
  const fileName = refPath.split('/').pop();
  if (!fileName) return null;

  // Search for file nodes with this name
  const candidates = context.getNodesByName(fileName);
  const fileNodes = candidates.filter(n => n.kind === 'file');

  if (fileNodes.length === 0) return null;

  // Prefer exact path match on qualified_name
  const exactMatch = fileNodes.find(n => n.qualifiedName === refPath || n.filePath === refPath);
  if (exactMatch) {
    return {
      original: ref,
      targetNodeId: exactMatch.id,
      confidence: 0.95,
      resolvedBy: 'file-path',
    };
  }

  // Fall back to suffix match (e.g., ref="snippets/foo.liquid" matches
  // "src/snippets/foo.liquid"). When several files share the basename — a
  // `#include "RNCAsyncStorage.h"` with a same-named header on another platform
  // (windows/code/ vs apple/) — prefer the one in the includer's own directory,
  // then by directory proximity / same language family. A C/C++ include (and any
  // bare-filename import) resolves relative to the including file, not to an
  // arbitrary same-named header elsewhere in the tree.
  const suffixMatches = fileNodes.filter(
    n => n.qualifiedName.endsWith(refPath) || n.filePath.endsWith(refPath)
  );
  if (suffixMatches.length > 0) {
    return {
      original: ref,
      targetNodeId: pickClosestFileNode(suffixMatches, ref).id,
      confidence: 0.85,
      resolvedBy: 'file-path',
    };
  }

  // If only one file node with this name, use it with lower confidence
  if (fileNodes.length === 1) {
    return {
      original: ref,
      targetNodeId: fileNodes[0]!.id,
      confidence: 0.7,
      resolvedBy: 'file-path',
    };
  }

  return null;
}

/**
 * Among several file nodes that all match a bare include/import by basename,
 * pick the one closest to the referencing file: same directory first, then by
 * directory-tree proximity, with the same language family as a tiebreak. A
 * C/C++ `#include "X.h"` (and any bare-filename import) resolves relative to the
 * including file — not to an arbitrary same-named header on another platform.
 */
function pickClosestFileNode(candidates: Node[], ref: UnresolvedRef): Node {
  const dirOf = (p: string): string => {
    const i = p.lastIndexOf('/');
    return i >= 0 ? p.slice(0, i) : '';
  };
  const refDir = dirOf(ref.filePath);
  const sameDir = candidates.filter((c) => dirOf(c.filePath) === refDir);
  const pool = sameDir.length > 0 ? sameDir : candidates;
  let best = pool[0]!;
  let bestScore = -Infinity;
  for (const c of pool) {
    const score =
      computePathProximity(ref.filePath, c.filePath) +
      (sameLanguageFamily(c.language, ref.language) ? 5 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

/**
 * Language families that share a type system / runtime, so a same-language-only
 * reference may still resolve across them (a Kotlin `Foo.BAR` can name a Java
 * `Foo`). Anything not listed forms its own singleton family.
 */
const LANGUAGE_FAMILY: Record<string, string> = {
  java: 'jvm', kotlin: 'jvm', scala: 'jvm',
  swift: 'apple', objc: 'apple',
  typescript: 'web', tsx: 'web', javascript: 'web', jsx: 'web',
  c: 'c', cpp: 'c',
  // Razor/Blazor markup names C# types — same family so `@model Foo` /
  // `<MyComponent/>` resolve to their `.cs` class through the cross-family gate.
  csharp: 'dotnet', razor: 'dotnet',
};
export function sameLanguageFamily(a: string, b: string): boolean {
  if (a === b) return true;
  const fa = LANGUAGE_FAMILY[a];
  return fa !== undefined && fa === LANGUAGE_FAMILY[b];
}

/**
 * Construction compatibility is normally the same as the shared language
 * family, with one directional exception: an Objective-C++ (`.mm`) source is
 * tagged `objc` by the grammar but can directly construct C and C++ types.
 * Plain Objective-C (`.m`) cannot, and both share the `objc` tag, so the
 * exception is gated on the source file path ending in `.mm`. A missing path
 * is treated conservatively (no exception). This preserves real ObjC++ interop
 * without broadly merging the Apple and C/C++ language families.
 */
export function sameInstantiationLanguageFamily(
  targetLanguage: string,
  sourceLanguage: string,
  sourceFilePath?: string,
): boolean {
  return sameLanguageFamily(targetLanguage, sourceLanguage) || (
    sourceLanguage === 'objc' &&
    (targetLanguage === 'c' || targetLanguage === 'cpp') &&
    !!sourceFilePath &&
    sourceFilePath.toLowerCase().endsWith('.mm')
  );
}
/**
 * True when `lang` belongs to a known multi-language family (jvm/apple/web/c).
 * Languages not listed (php, python, go, ruby, rust, dart, …) and config
 * formats (yaml/xml/blade) form their own singleton families and return
 * `false` — used to leave config↔code framework bridges (whose config side is
 * never a known programming-language family) out of the cross-family gate.
 */
export function isKnownLanguageFamily(lang: string): boolean {
  return LANGUAGE_FAMILY[lang] !== undefined;
}
/**
 * True when `a` and `b` are two DIFFERENT *known* language families — the
 * signature of a coincidental cross-language name collision (a TS `import
 * React` matching a Swift `import React`, a C++ `#include "X.h"` matching a
 * same-named ObjC header on another platform). The both-*known* test is
 * deliberately weaker than {@link sameLanguageFamily}'s negation: a
 * single-file-component language that carries its own tag (`vue`/`svelte`)
 * importing a `.ts` module, or any singleton-family language (php/go/ruby/…),
 * returns `false` here and is left alone.
 */
export function crossesKnownFamily(a: string, b: string): boolean {
  return isKnownLanguageFamily(a) && isKnownLanguageFamily(b) && !sameLanguageFamily(a, b);
}
/**
 * Drop cross-language candidates from a name lookup. Two regimes:
 *  - `references` / `instantiates` (type-usage/construction): a type named in
 *    language X resolves to a SAME-family type, never a coincidentally
 *    same-named symbol in another language (the Android `BatteryManager`
 *    system class vs a JS one). Strict compatible-family filter — including
 *    the Objective-C++-to-C/C++ construction exception — prevents unrelated
 *    cross-language collisions while retaining direct language interop.
 *  - `imports` (import binding): an `import`/`#include` never crosses two
 *    KNOWN families (TS `import React` ↮ Swift `import React`). Weaker
 *    both-known filter so `.vue`/`.svelte` (own tag) importing `.ts` survives.
 */
function applyLanguageGate(candidates: Node[], ref: UnresolvedRef): Node[] {
  if (ref.referenceKind === 'references') {
    return candidates.filter((c) => sameLanguageFamily(c.language, ref.language));
  }
  if (ref.referenceKind === 'instantiates') {
    return candidates.filter((c) =>
      sameInstantiationLanguageFamily(c.language, ref.language, ref.filePath));
  }
  if (ref.referenceKind === 'imports') {
    return candidates.filter((c) => !crossesKnownFamily(c.language, ref.language));
  }
  return candidates;
}

/**
 * Whether a symbol can be the target of an explicit construction expression.
 *
 * Keep this a semantic allow-list rather than a score bonus: `new Widget()`
 * must never resolve to a same-named method, field, variable, or import merely
 * because that symbol happens to be closer to the call site. The allowed kinds
 * are language-aware (see the switch below): class/struct are universally
 * constructible; type_alias only in C/C++ (alias-chain resolution to an
 * underlying constructible type is a follow-up); interface only in Java
 * (anonymous implementations like `new Runnable() { ... }`); trait only in
 * Scala; enum_member only in Rust (struct-style variants share struct
 * construction syntax); protocol is rejected by default.
 */
export function isValidInstantiationTarget(candidate: Node, ref: UnresolvedRef): boolean {
  // Language-aware allow-list: a construction expression may only target a type
  // whose kind is constructible in the *source* language. class/struct are
  // universally constructible; the rest are gated to the language(s) with a
  // real construction syntax for that kind, so a same-named Swift `protocol`,
  // Rust `trait`, or TS `interface`/`type_alias` no longer swallows a call that
  // should resolve to a class. C/C++ `type_alias` is kept for now (resolving an
  // alias chain to an underlying constructible type is a follow-up).
  switch (candidate.kind) {
    case 'class':
    case 'struct':
      return true;
    case 'type_alias':
      return ref.language === 'c' || ref.language === 'cpp';
    case 'interface':
      return ref.language === 'java';
    case 'trait':
      return ref.language === 'scala';
    case 'enum_member':
      return ref.language === 'rust';
    // `protocol` has no standalone construction syntax worth keeping without
    // explicit evidence per language; reject by default.
    default:
      return false;
  }
}

function isCppInheritance(ref: UnresolvedRef): boolean {
  return (ref.language === 'c' || ref.language === 'cpp') &&
    (ref.referenceKind === 'extends' || ref.referenceKind === 'implements');
}

function applyTargetKindGate(candidates: Node[], ref: UnresolvedRef): Node[] {
  if (isCppInheritance(ref)) {
    return candidates.filter(n => n.kind === 'class' || n.kind === 'struct' || n.kind === 'type_alias');
  }
  if (ref.referenceKind !== 'instantiates') return candidates;
  return candidates.filter((candidate) => isValidInstantiationTarget(candidate, ref));
}

function applyReferenceGates(candidates: Node[], ref: UnresolvedRef): Node[] {
  return applyTargetKindGate(applyLanguageGate(candidates, ref), ref);
}

function cppOwner(node: Node): string {
  const cut = node.qualifiedName.lastIndexOf('::');
  return cut < 0 ? '' : node.qualifiedName.slice(0, cut);
}

function cppCallerOwner(ref: UnresolvedRef, context: ResolutionContext): string {
  const source = context.getNodesInFile(ref.filePath).find(n => n.id === ref.fromNodeId);
  return source?.kind === 'method' ? cppOwner(source) : '';
}

function cppDirectMethods(type: string, method: string, ref: UnresolvedRef, context: ResolutionContext): Node[] {
  const want = `${type}::${method}`;
  // Shared .h files can retain the C extraction tag even when they declare
  // C++ members. Query both indexes, while still requiring a real method node.
  const nodes = context.getMethodMatches
    ? (['cpp', 'c'] as const).flatMap(language => context.getMethodMatches!(type, method, language))
    : context.getNodesByName(method);
  return filterCppBindingCandidates(nodes.filter(n => n.kind === 'method' && sameLanguageFamily(n.language, ref.language) &&
    (n.qualifiedName === want || n.qualifiedName.endsWith('::' + want))), ref, context);
}

/** using Base::name imports a hidden overload set; inheritance alone does not. */
function cppUsingBase(type: string, base: string, method: string, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const owners = context.getNodesByName(cppLastSegment(type)).filter(n =>
    ['class', 'struct'].includes(n.kind) && sameLanguageFamily(n.language, ref.language) &&
    (n.qualifiedName === type || n.qualifiedName.endsWith('::' + type)));
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp('\\busing\\s+(?:::)?' + escape(base) + '\\s*::\\s*' + escape(method) + '\\s*;');
  return owners.some(owner => {
    const lines = context.getFileLines?.(owner.filePath) ?? context.readFile(owner.filePath)?.split(/\r?\n/);
    if (!lines || owner.endLine - owner.startLine > 512) return false;
    const code = maskCStyleCommentsAndLiterals(lines.slice(owner.startLine - 1, owner.endLine).join('\n')).slice(owner.startColumn);
    const open = code.indexOf('{');
    if (open < 0) return false;
    let depth = 1;
    for (let i = open + 1; i < code.length && depth > 0; i++) {
      // Only a declaration immediately in this class imports its overloads.
      // Nested classes/functions and conditional directives are not evidence.
      if (depth === 1 && code[i] === '#') return false;
      if (depth === 1 && code[i] === 'u' && pattern.exec(code.slice(i))?.index === 0) return true;
      if (code[i] === '{') depth++;
      else if (code[i] === '}') depth--;
    }
    return false;
  });
}

function cppMethodsOnType(type: string, method: string, ref: UnresolvedRef, context: ResolutionContext,
  depth = 0, seen = new Set<string>()): Node[] {
  if (depth > 4 || seen.has(type) || /[<>]/.test(type)) return [];
  const owners = context.getNodesByName(cppLastSegment(type)).filter(n =>
    ['class', 'struct'].includes(n.kind) && sameLanguageFamily(n.language, ref.language) &&
    (n.qualifiedName === type || n.qualifiedName.endsWith('::' + type)));
  if (owners.some(owner => owner.typeParameters?.length)) return [];
  seen.add(type);
  const own = cppDirectMethods(type, method, ref, context);
  const hiddenByData = context.getNodesByName(method).some(n => sameLanguageFamily(n.language, ref.language) && n.kind !== 'method'
    && (cppOwner(n) === type || cppOwner(n).endsWith('::' + type)));
  // Data members and nested type names hide base functions too. Until the
  // field's callable type is proved, keep its call unresolved, never bind Base.
  if (hiddenByData) return [];
  const matches = [...filterCppCallCandidates(own, ref, context)];
  for (const base of context.getSupertypes?.(type, ref.language) ?? []) {
    if (own.length && !cppUsingBase(type, base, method, ref, context)) continue;
    matches.push(...cppMethodsOnType(base, method, ref, context, depth + 1, new Set(seen)));
  }
  return [...new Map(matches.map(n => [n.id, n])).values()];
}

function cppUniqueMethod(matches: Node[]): Node | null {
  if (matches.length === 1) return matches[0]!;
  if (!matches.length) return null;
  const keys = matches.map(cppCallableSignatureKey);
  if (keys.some(key => key === null) || new Set(keys).size !== 1) return null;
  return matches.find(n => !n.isDeclaration) ?? matches[0]!;
}

/**
 * Share receiver/owner evidence only within one synchronous candidate filter.
 * Laziness preserves the arity and exact-qualified short circuits. In particular,
 * an unknown receiver or an empty method set is reused too, but never survives
 * this invocation (another reference or resolution epoch must recompute it).
 */
function createCppCallTargetPredicate(ref: UnresolvedRef, context: ResolutionContext): (candidate: Node) => boolean {
  let allowedMethods: Set<string> | undefined;
  let owner: string | undefined;
  let explicitThis: boolean | undefined;
  let hasDirectMethods: boolean | undefined;
  const methodsOnType = (type: string, method: string): Set<string> => {
    if (allowedMethods === undefined) {
      allowedMethods = new Set(type ? cppMethodsOnType(type, method, ref, context).map(n => n.id) : []);
    }
    return allowedMethods;
  };
  return candidate => {
    if ((ref.language !== 'cpp' && ref.language !== 'c') || ref.referenceKind !== 'calls') return true;
    if (!isCppCallArityAllowed(candidate, ref, context)) return false;
    // C structure fields can contain callbacks; they are not C++ methods.
    if (ref.language !== 'cpp') return true;
    const dotted = /^(.+)\.([A-Za-z_]\w*)$/.exec(ref.referenceName);
    if (dotted) {
      if (allowedMethods === undefined) {
        const receiver = dotted[1]!, method = dotted[2]!;
        const chain = /^(.*)\(\)$/.exec(receiver);
        const type = receiver === 'this' ? cppCallerOwner(ref, context)
          : chain ? resolveCppCallResultType(chain[1]!, ref, context) : inferCppReceiverType(receiver, ref, context);
        methodsOnType(type ?? '', method);
      }
      return allowedMethods!.has(candidate.id);
    }
    const qualified = /^(?:::)?(.+)::([A-Za-z_]\w*)$/.exec(ref.referenceName);
    if (qualified) {
      const want = ref.referenceName.replace(/^::/, '');
      if (candidate.qualifiedName === want || candidate.qualifiedName.endsWith('::' + want)) return true;
      return candidate.kind === 'method' && methodsOnType(qualified[1]!, qualified[2]!).has(candidate.id);
    }
    if (!/^\w+$/.test(ref.referenceName)) return true;
    owner ??= cppCallerOwner(ref, context);
    if (explicitThis === undefined) {
      const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1];
      explicitThis = !!line && (/^this\s*->/.test(line.slice(ref.column)) || /\bthis\s*->\s*$/.test(line.slice(0, ref.column)));
    }
    if (candidate.kind === 'method') return !!owner && methodsOnType(owner, ref.referenceName).has(candidate.id);
    if (explicitThis) return false;
    // A declared member hides a same-named free function, including when none of
    // the member overloads accepts this arity. Other bare free helpers survive.
    if (!owner) return true;
    hasDirectMethods ??= cppDirectMethods(owner, ref.referenceName, ref, context).length > 0;
    return !hasDirectMethods;
  };
}

/** The receiver/owner is authoritative even for a target selected by another strategy. */
export function isCppCallTargetAllowed(candidate: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  // Independent final admission deliberately gets fresh evidence, not the set
  // used while a name-matching strategy filtered its candidates.
  return createCppCallTargetPredicate(ref, context)(candidate);
}

/** Bare identifiers cannot name unrelated class members, even in the same file. */
function applyCppMemberScopeGate(candidates: Node[], ref: UnresolvedRef, context: ResolutionContext): Node[] {
  if (ref.language === 'cpp' && ref.referenceKind === 'calls') {
    return candidates.filter(createCppCallTargetPredicate(ref, context));
  }
  if ((ref.language !== 'c' && ref.language !== 'cpp') || !/^\w+$/.test(ref.referenceName)
    || !candidates.some(n => (n.kind === 'field' || n.kind === 'method') && n.filePath !== ref.filePath)) return candidates;
  const source = context.getNodesInFile(ref.filePath).find(n => n.id === ref.fromNodeId);
  const qualified = source?.qualifiedName ?? '';
  const owner = qualified.includes('::') ? qualified.slice(0, qualified.lastIndexOf('::')) : '';
  let bases: Set<string> | undefined;
  const inherited = (candidateOwner: string): boolean => {
    if (!owner || !context.getSupertypes) return false;
    if (!bases) {
      bases = new Set<string>();
      let frontier = [owner];
      for (let depth = 0; depth < 4 && frontier.length; depth++) {
        const next: string[] = [];
        for (const type of frontier) for (const base of context.getSupertypes(type, ref.language)) {
          if (!bases.has(base)) { bases.add(base); next.push(base); }
        }
        frontier = next;
      }
    }
    return bases.has(candidateOwner);
  };
  return candidates.filter(candidate => {
    if ((candidate.kind !== 'field' && candidate.kind !== 'method') || candidate.filePath === ref.filePath) return true;
    const cut = candidate.qualifiedName.lastIndexOf('::');
    if (cut < 0) return false;
    const candidateOwner = candidate.qualifiedName.slice(0, cut);
    return (!!qualified && qualified.startsWith(candidateOwner + '::')) || inherited(candidateOwner);
  });
}

function applyCppCandidateGates(candidates: Node[], ref: UnresolvedRef, context: ResolutionContext): Node[] {
  return applyCppMemberScopeGate(filterCppCallCandidates(filterCppBindingCandidates(candidates, ref, context), ref, context), ref, context);
}

/**
 * Try to resolve a reference by exact name match
 */
export function matchByExactName(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  const candidates = applyCppCandidateGates(applyReferenceGates(context.getNodesByName(ref.referenceName), ref), ref, context);

  if (candidates.length === 0) {
    return null;
  }
  if (ref.language === 'cpp' && ref.referenceKind === 'calls' && candidates.length > 1 &&
      candidates.every(n => n.kind === 'method') && !cppUniqueMethod(candidates)) return null;

  // If only one match, use it — but penalize cross-language matches
  if (candidates.length === 1) {
    const isCrossLanguage = candidates[0]!.language !== ref.language;
    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      confidence: isCrossLanguage ? 0.5 : 0.9,
      resolvedBy: 'exact-match',
    };
  }

  // Multiple matches - try to narrow down
  const bestMatch = findBestMatch(ref, candidates, context);
  if (bestMatch) {
    // Lower confidence when the match is from a distant/unrelated module
    const proximity = computePathProximity(ref.filePath, bestMatch.filePath);
    const confidence = proximity >= 30 ? 0.7 : 0.4;
    return {
      original: ref,
      targetNodeId: bestMatch.id,
      confidence,
      resolvedBy: 'exact-match',
    };
  }

  return null;
}

/**
 * Try to resolve by qualified name
 */
export function matchByQualifiedName(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // Check if the reference name looks qualified (contains :: or .)
  if (!ref.referenceName.includes('::') && !ref.referenceName.includes('.')) {
    return null;
  }

  const qualifiedCandidates = applyCppCandidateGates(context.getNodesByQualifiedName(ref.referenceName), ref, context);
  const candidates = ref.referenceKind === 'instantiates' || isCppInheritance(ref)
    ? applyReferenceGates(qualifiedCandidates, ref)
    : qualifiedCandidates;

  if (candidates.length === 1) {
    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      confidence: 0.95,
      resolvedBy: 'qualified-name',
    };
  }

  // Try partial qualified name match
  const parts = ref.referenceName.split(/[:.]/);
  const lastName = parts[parts.length - 1];
  if (lastName) {
    const namedCandidates = applyCppCandidateGates(context.getNodesByName(lastName), ref, context);
    const partialCandidates = ref.referenceKind === 'instantiates' || isCppInheritance(ref)
      ? applyReferenceGates(namedCandidates, ref)
      : namedCandidates;
    if (ref.language === 'cpp' && ref.referenceKind === 'calls' && partialCandidates.length > 1 &&
        partialCandidates.every(n => n.kind === 'method') && !cppUniqueMethod(partialCandidates)) return null;
    for (const candidate of partialCandidates) {
      if (candidate.qualifiedName.endsWith(ref.referenceName)) {
        return {
          original: ref,
          targetNodeId: candidate.id,
          confidence: 0.85,
          resolvedBy: 'qualified-name',
        };
      }
    }
  }

  return null;
}

function resolveMethodOnType(
  typeName: string,
  methodName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  confidence: number,
  resolvedBy: ResolvedRef['resolvedBy'],
  /**
   * Optional FQN that identifies WHICH class declaration `typeName`
   * refers to in the caller's file. When multiple candidates share
   * the same qualifiedName (`FooConverter::convert` in both
   * `dao/converter/` and `service/converter/`), the FQN's
   * file-path-suffix picks the right one — the disambiguation
   * signal Java imports carry but the call site doesn't (#314).
   */
  preferredFqn?: string,
  /** Recursion guard for the supertype/conformance walk. */
  depth = 0,
): ResolvedRef | null {
  if (ref.language === 'cpp') {
    const target = cppUniqueMethod(cppMethodsOnType(typeName, methodName, ref, context));
    return target ? { original: ref, targetNodeId: target.id, confidence, resolvedBy } : null;
  }
  // Look up methods by name and match by qualifiedName ending in
  // `<typeName>::<methodName>`. This works whether the method is defined
  // in-class (`class Foo { int bar() { ... } }`) or out-of-line in a separate
  // file (`int Foo::bar() { ... }` in foo.cpp while class Foo is in foo.hpp).
  // The previous same-file approach missed the latter — the typical C++ layout.
  let matches: Node[];
  if (context.getMethodMatches) {
    matches = context.getMethodMatches(typeName, methodName, ref.language);
  } else {
    const methodCandidates = context.getNodesByName(methodName);
    const want = `${typeName}::${methodName}`;
    matches = [];
    for (const m of methodCandidates) {
      if (m.kind !== 'method') continue;
      if (m.language !== ref.language) continue;
      const qn = m.qualifiedName;
      if (qn === want || qn.endsWith(`::${want}`)) {
        matches.push(m);
      }
    }
  }
  if (matches.length === 0) {
    // Conformance fallback: the method may be defined on a supertype `typeName`
    // extends, or on a protocol / trait it conforms to (e.g. a Swift protocol-
    // extension method, a C# default-interface or extension method, a Kotlin
    // extension on a supertype). Walk supertypes transitively (depth-capped) via
    // the resolved implements/extends edges — empty in the first resolution pass,
    // populated in the conformance pass. Still VALIDATED (the method must exist on
    // a supertype), so a wrong inference produces no edge.
    if (depth < 4 && context.getSupertypes) {
      for (const supertype of context.getSupertypes(typeName, ref.language)) {
        const via = resolveMethodOnType(
          supertype, methodName, ref, context, confidence, resolvedBy, preferredFqn, depth + 1,
        );
        if (via) return via;
      }
    }
    return null;
  }

  if (matches.length > 1 && preferredFqn) {
    const ext = ref.language === 'kotlin' ? '.kt' : '.java';
    const fqnPath = preferredFqn.replace(/\./g, '/') + ext;
    const chosen = matches.find((m) => {
      const fp = m.filePath.replace(/\\/g, '/');
      return fp.endsWith(fqnPath) || fp.endsWith('/' + fqnPath);
    });
    if (chosen) {
      return {
        original: ref,
        targetNodeId: chosen.id,
        confidence,
        resolvedBy,
      };
    }
  }

  return {
    original: ref,
    targetNodeId: matches[0]!.id,
    confidence,
    resolvedBy,
  };
}

// C++ keywords/control-flow tokens that can appear right before a receiver
// (e.g. `return ptr->m()`) and must NOT be treated as a type.
const CPP_NON_TYPE_TOKENS = new Set([
  'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
  'break', 'continue', 'goto', 'throw', 'new', 'delete', 'co_await', 'co_yield',
  'co_return', 'static_cast', 'const_cast', 'dynamic_cast', 'reinterpret_cast',
  'sizeof', 'alignof', 'typeid', 'and', 'or', 'not', 'xor',
]);

function normalizeCppTypeName(typeName: string, preserveGlobal = false): string | null {
  const normalized = typeName
    .replace(/\b(const|volatile|mutable|typename|class|struct)\b/g, ' ')
    .replace(/[&*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return null;
  const parts = normalized.split(/::/).filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last) return null;
  if (CPP_NON_TYPE_TOKENS.has(last)) return null;
  // Namespace qualification is evidence, while a dependent template receiver
  // is not the same type as the template's unqualified primary spelling.
  return /^(?:::)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/.test(normalized) ? preserveGlobal ? normalized : normalized.replace(/^::/, '') : null;
}

// Large sources use compact declaration evidence. Small sources and external
// contexts retain the same backward scan and forward header fallback.
function inferCppReceiverType(
  receiverName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  depth = 0,
): string | null {
  const indexed = context.getCppReceiverDeclarations?.(ref.filePath, receiverName);
  const lines = indexed ? null : context.getFileLines
    ? context.getFileLines(ref.filePath)
    : context.readFile(ref.filePath)?.split(/\r?\n/);
  if (!indexed && (!lines || lines.length === 0 || (lines.length === 1 && lines[0] === ''))) return null;
  const lineCount = indexed?.lineCount ?? lines!.length;
  if (indexed && lineCount === 1 && indexed.lineText(0) === '') return null;
  const callLineIndex = Math.max(0, Math.min(lineCount - 1, ref.line - 1));
  const escapedReceiver = receiverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const receiverPattern = new RegExp(`\\b${escapedReceiver}\\b`);
  const declaratorRegex = buildDeclaratorRegex(escapedReceiver);
  const caller = context.getNodesInFile(ref.filePath).find(n => n.id === ref.fromNodeId);
  const firstLine = caller ? Math.max(0, caller.startLine - 1) : 0;

  // Only source-spelled evidence is reused. In particular, an auto initializer
  // is evaluated against the CURRENT graph, even when its line is cached.
  const start = indexed ? lastDeclarationBefore(indexed.declarations, callLineIndex) : callLineIndex;
  for (let i = start; i >= 0; i--) {
    const declaration = indexed?.declarations[i];
    const row = declaration?.line ?? i;
    if (row < firstLine) break;
    const fullLine = indexed ? indexed.lineText(row) : lines![row];
    const line = row === callLineIndex ? fullLine?.slice(0, ref.column) : fullLine;
    if (!line || (!indexed && !receiverPattern.test(line))) continue;

    const declarations = [...line.matchAll(new RegExp(declaratorRegex.source, 'g'))];
    for (const match of declarations.reverse()) {
      const rawType = match[1]!;
      // A use such as `return value` is not a newer declaration/shadowing.
      // Continue within this same line before looking at preceding lines.
      if (rawType.split(/\W+/).some(token => CPP_NON_TYPE_TOKENS.has(token))) continue;
      const normalized = normalizeCppTypeName(rawType);
      if (normalized === 'auto') {
        // `auto x = Foo::instance();` — the declared type is deduced; recover it
        // from the initializer (call return type / construction) (#645).
        return inferCppAutoInitializerType(line, receiverName, ref, context, depth);
      } else if (normalized) {
        return normalized;
      }
      return null;
    }
  }

  // A same-named field in a neighbouring class/header is not receiver evidence.
  let owner = caller?.kind === 'method' ? cppOwner(caller) : '';
  if (!owner) return null;
  const namedFields = context.getNodesByName(receiverName).filter(n =>
    sameLanguageFamily(n.language, ref.language) && n.kind === 'field');
  if (!namedFields.some(n => cppOwner(n) === owner)) owner = cppRecoveredCallerOwner(caller!, context) ?? owner;
  if (!owner) return null;
  const fields = filterCppBindingCandidates(namedFields.filter(n => cppOwner(n) === owner), ref, context);
  const types = fields.map(n => {
    const signature = n.signature ?? '', declaration = declaratorRegex.exec(signature);
    const global = declaration && signature.slice(0, declaration.index).trimEnd().endsWith('::');
    const type = normalizeCppTypeName((global ? '::' : '') + (declaration?.[1] ?? ''), true);
    if (!type) return null;
    const qualified = cppFieldReceiverType(n, type, context);
    return qualified === undefined ? (!type.includes('::') ? type : null) : qualified;
  });
  return types.length && !types.includes(null) && new Set(types).size === 1 ? types[0]! : null;
}

/**
 * Last `::`-separated segment of a (possibly namespace-qualified) C++ name.
 */
function cppLastSegment(name: string): string {
  const parts = name.split('::').filter(Boolean);
  return parts[parts.length - 1] ?? name;
}

/**
 * Return type captured at extraction for `Class::method` (or a free function),
 * read off the indexed node's `returnType` — used by the C++ (#645) and PHP
 * (#608) chained-call resolvers. Language-filtered. Null when not indexed or no
 * return type was recorded (a `void`/primitive return).
 */
function lookupCalleeReturnType(
  callee: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): string | null {
  let method = callee;
  let cls: string | null = null;
  if (callee.includes('::')) {
    const parts = callee.split('::').filter(Boolean);
    method = parts[parts.length - 1] ?? callee;
    cls = parts.slice(0, -1).join('::');
  }
  const candidates = filterCppBindingCandidates(context.getNodesByName(method).filter(
    (n) =>
      (n.kind === 'method' || n.kind === 'function') &&
      ((ref.language === 'cpp' || ref.language === 'c') ? sameLanguageFamily(n.language, ref.language) : n.language === ref.language) &&
      !!n.returnType,
  ), ref, context);
  if (cls) {
    const want = `${cls}::${method}`;
    // The call site may name the class with MORE namespace qualification than
    // the stored node (`details::registry::instance` at the call vs
    // `registry::instance` on the node — the receiver type only carries the
    // immediate class), or LESS. Accept an exact match or either being a
    // namespace-suffix of the other; the shared `::<class>::<method>` tail keeps
    // it specific.
    const matches = candidates.filter(
      (n) =>
        n.qualifiedName === want ||
        n.qualifiedName.endsWith(`::${want}`) ||
        want.endsWith(`::${n.qualifiedName}`),
    );
    if (ref.language !== 'cpp' && ref.language !== 'c') return matches[0]?.returnType ?? null;
    const results = new Set(matches.map(n => n.returnType));
    return results.size === 1 ? [...results][0]! : null;
  }
  if (ref.language !== 'cpp' && ref.language !== 'c') return candidates.find(n => n.kind === 'function')?.returnType ?? null;
  const results = new Set(candidates.filter(n => n.kind === 'function').map(n => n.returnType));
  return results.size === 1 ? [...results][0]! : null;
}

/** Does the graph contain a class/struct named `name`'s last segment? */
function cppClassExists(name: string, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const last = cppLastSegment(name);
  return context
    .getNodesByName(last)
    .some((n) => (n.kind === 'class' || n.kind === 'struct') && sameLanguageFamily(n.language, ref.language) &&
      (!name.includes('::') || n.qualifiedName === name || n.qualifiedName.endsWith('::' + name)));
}

/**
 * Infer the class produced by a C++ call/construction expression, using return
 * types captured at extraction (#645). Handles, in order:
 *   - `make_unique<T>()` / `make_shared<T>()`        → T
 *   - single-level member call `recv.method()`       → recv's type, then method's return
 *   - `Class::method()` / free `func()`              → the callee's recorded return type
 *   - direct construction `Type()` / `ns::Type()`    → Type
 * Returns null when undeterminable. Callers MUST still validate the outer method
 * exists on the result before creating an edge, so a wrong guess stays silent.
 */
function resolveCppCallResultType(
  inner: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  depth = 0,
): string | null {
  if (depth > 3) return null; // guard against pathological mutual recursion
  const expr = inner.trim();

  const make = expr.match(/(?:^|::)(?:make_unique|make_shared)\s*<\s*([A-Za-z_][\w:]*)/);
  if (make) return make[1] ?? null;

  // Single-level member call `recv.method` (the `manager.view().render()` shape).
  const dotIdx = expr.lastIndexOf('.');
  if (dotIdx > 0) {
    const recv = expr.slice(0, dotIdx);
    const method = expr.slice(dotIdx + 1);
    if (recv.includes('.') || recv.includes('(') || recv.includes('::')) return null; // single level only
    const recvType = inferCppReceiverType(recv, ref, context, depth + 1);
    if (!recvType) return null;
    return lookupCalleeReturnType(`${recvType}::${method}`, ref, context);
  }

  const ret = lookupCalleeReturnType(expr, ref, context);
  if (ret) return ret;

  // Direct construction — the callee itself names a class/struct.
  if (cppClassExists(expr, ref, context)) return expr;

  return null;
}

/**
 * Recover the type of an `auto`-declared local from its initializer on the
 * declaration line — `auto x = Foo::instance();`, `auto w = make_unique<W>();`,
 * `auto p = new W();`, `auto w = Widget();` (#645).
 */
function inferCppAutoInitializerType(
  line: string,
  receiverName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  depth: number,
): string | null {
  const escaped = receiverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = line.match(new RegExp(`\\b${escaped}\\b\\s*=\\s*([^;]+)`));
  if (!m || !m[1]) return null;
  const init = m[1].trim();

  const neu = init.match(/^new\s+([A-Za-z_][\w:]*)/);
  if (neu && neu[1]) return neu[1];

  // A call or construction: `Foo(...)`, `A::b(...)`, `make_unique<T>(...)`.
  const call = init.match(/^([A-Za-z_][\w:]*(?:\s*<[^>;]*>)?)\s*\(/);
  if (call && call[1]) return resolveCppCallResultType(call[1].replace(/\s+/g, ''), ref, context, depth + 1);

  return null;
}

/**
 * Resolve a C++ chained call whose receiver is itself a call — encoded by the
 * extractor as `<innerCallee>().<method>` (#645). The receiver's type is what
 * the inner call returns; the outer method is then resolved and VALIDATED on it
 * (resolveMethodOnType requires `cls::method` to exist), so a wrong inference
 * produces no edge rather than a wrong one.
 */
export function matchCppCallChain(
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null {
  const m = ref.referenceName.match(/^(.+)\(\)\.(\w+)$/);
  if (!m || !m[1] || !m[2]) return null;
  const cls = resolveCppCallResultType(m[1], ref, context);
  if (!cls) return null;
  return resolveMethodOnType(cls, m[2], ref, context, 0.85, 'instance-method');
}

/**
 * Resolve a `::`-scoped factory chain whose receiver is a scoped/static call —
 * PHP `Cls::for($x)->method()` (#608, the per-credential Laravel client idiom) or
 * Rust `Foo::new().bar()` (an associated-function call) — both encoded by the
 * extractor as `Cls::factory().method`. The receiver's type is what `Cls::factory`
 * returns: a `self` marker (PHP `: self`/`: static`, Rust `-> Self`) resolves to
 * the factory's own type, a concrete return type to that type. The outer method is
 * then resolved and VALIDATED on it (resolveMethodOnType requires the method to
 * exist on the type or a supertype it conforms to), so a wrong inference yields no
 * edge rather than a wrong one. Shared by the `::`-receiver languages (PHP, Rust).
 */
export function matchScopedCallChain(
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null {
  const m = ref.referenceName.match(/^(.+)\(\)\.(\w+)$/);
  if (!m || !m[1] || !m[2]) return null;
  const inner = m[1];
  const method = m[2];
  if (!inner.includes('::')) return null; // only static-factory (`Cls::method`) chains
  const factoryClass = inner.slice(0, inner.lastIndexOf('::'));
  const ret = lookupCalleeReturnType(inner, ref, context);
  if (!ret) return null;
  // `self` (the extractor's marker for self/static/$this) → the factory's class.
  const resolvedClass = ret === 'self' ? factoryClass : ret;
  return resolveMethodOnType(resolvedClass, method, ref, context, 0.85, 'instance-method');
}

/**
 * Languages where an unprefixed capitalized call `Foo(args)` constructs the
 * class (so a `Foo(args).method()` receiver's type is `Foo`). Java/C# need `new`,
 * so a bare `Foo()` there is a method call, not construction — excluded. Scala's
 * `Foo(args)` is a case-class / companion `apply`, which conventionally returns
 * `Foo` — and resolveMethodOnType validates, so a non-conventional `apply` that
 * returns another type simply yields no edge rather than a wrong one.
 */
const CONSTRUCTS_VIA_BARE_CALL = new Set(['kotlin', 'swift', 'scala', 'dart']);

/**
 * Resolve a dotted chained call whose receiver is a static factory / fluent call —
 * `Foo.getInstance().bar()`, encoded by the extractor as `Foo.getInstance().bar`
 * (#645/#608 mechanism). The receiver's type is what `Foo.getInstance` returns
 * (its declared return type); the outer method is then resolved and VALIDATED on
 * it (resolveMethodOnType requires `Type::method` to exist), so a wrong inference
 * yields no edge rather than a wrong one (e.g. a same-named `bar()` on an
 * unrelated class is never matched). Shared by the dot-notation languages
 * (Java, Kotlin, C#, Swift) — same receiver shape, same `Class::method` qualified names.
 */
export function matchDottedCallChain(
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null {
  const m = ref.referenceName.match(/^(.+)\(\)\.(\w+)$/);
  if (!m || !m[1] || !m[2]) return null;
  const inner = m[1]; // `Foo.getInstance`
  const method = m[2]; // `bar`
  const lastDot = inner.lastIndexOf('.');

  if (lastDot <= 0) {
    // Go: bare package-level factory FUNCTION `New().method()` — the receiver's
    // type is what `New` returns; resolve the method on that.
    if (ref.language === 'go') {
      const ret = lookupCalleeReturnType(inner, ref, context);
      if (ret) {
        return resolveMethodOnType(ret, method, ref, context, 0.85, 'instance-method', importedFqnOf(ret, ref, context));
      }
      // `inner` isn't a function with a captured return type — typically a
      // package-level VARIABLE holding a function value (e.g. gin's `engine()`),
      // whose type we can't recover. Fall back to bare-name resolution of the
      // method so we don't DROP an edge the un-re-encoded bare path would have
      // found. (When `inner` IS a real factory function but the method doesn't
      // exist on its return type, `ret` is truthy and we returned no edge above —
      // the absent-method safety guarantee is preserved.)
      //
      // CRITICAL: resolve the TARGET via a synthetic bare-name ref, but return the
      // match tied to the ORIGINAL `ref` (referenceName `inner().method`). The
      // batched resolver (resolveAndPersistBatched) reads unresolved rows from
      // offset 0 every pass and relies on deleteSpecificResolvedReferences —
      // keyed on referenceName — to clear each resolved row so the batch empties.
      // If we propagated the synthetic ref's bare `method` as `.original`, the
      // delete would never match the stored `inner().method` row, the batch would
      // never drain, and the loop would re-resolve + re-insert forever (a runaway
      // that grew gin's graph to 5M edges / 1.4 GB before this fix).
      const bareRef = { ...ref, referenceName: method };
      const bareMatch = matchByExactName(bareRef, context) ?? matchFuzzy(bareRef, context);
      return bareMatch ? { ...bareMatch, original: ref } : null;
    }
    // Constructor receiver `Foo(args).method()` (encoded `Foo().method`): a bare,
    // capitalized inner is a class construction, so the receiver's type is the
    // class itself — resolve the method on it. Only in languages where an
    // unprefixed capitalized call constructs the class (Kotlin, Swift); in Java/C#
    // a bare `Foo()` is a method call (constructors need `new`), so we must not
    // assume construction. A lowercase bare inner is a top-level `factory().method()`
    // whose type we can't recover — bail.
    if (!CONSTRUCTS_VIA_BARE_CALL.has(ref.language) || !/^[A-Z]/.test(inner)) return null;
    return resolveMethodOnType(inner, method, ref, context, 0.85, 'instance-method', importedFqnOf(inner, ref, context));
  }

  // Factory/fluent receiver `Receiver.factory(args).method()`: the receiver's
  // type is what `Receiver.factory` returns (its declared return type).
  const factoryClass = inner.slice(0, lastDot).split('.').pop(); // simple class name
  const factoryMethod = inner.slice(lastDot + 1);
  if (!factoryClass || !factoryMethod) return null;
  const ret = lookupCalleeReturnType(`${factoryClass}::${factoryMethod}`, ref, context);
  if (!ret) return null;
  return resolveMethodOnType(ret, method, ref, context, 0.85, 'instance-method', importedFqnOf(ret, ref, context));
}

/**
 * When several classes share a simple type name, the caller file's import of
 * that type is the only signal that names WHICH one (#314). Returns the imported
 * FQN for `typeName` in the ref's file, or undefined.
 */
function importedFqnOf(
  typeName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): string | undefined {
  const imports = context.getImportMappings(ref.filePath, ref.language);
  return imports.find((i) => i.localName === typeName)?.source;
}

/**
 * Java/Kotlin: infer a receiver's declared type by walking field declarations
 * in the class enclosing the call site. The field's `signature` is already in
 * the form "<TypeName> <fieldName>" (set by tree-sitter.ts extractField), so we
 * pull the type from there. Handles Spring `@Resource UserBO userbo;` /
 * `@Autowired private UserService userService;` where the receiver field name
 * doesn't match the class name by Java naming convention.
 *
 * Returns the bare type name (generics stripped, dotted package stripped) or
 * null when no matching field is in the enclosing class.
 */
function inferJavaFieldReceiverType(
  receiverName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): string | null {
  const inFile = context.getNodesInFile(ref.filePath);
  if (inFile.length === 0) return null;

  // Find the class enclosing the call line (tightest match by latest start).
  let enclosing: Node | null = null;
  for (const n of inFile) {
    if (n.kind !== 'class' && n.kind !== 'interface') continue;
    if (n.language !== ref.language) continue;
    const end = n.endLine ?? n.startLine;
    if (n.startLine <= ref.line && end >= ref.line) {
      if (!enclosing || n.startLine >= enclosing.startLine) enclosing = n;
    }
  }
  if (!enclosing) return null;

  const enclosingEnd = enclosing.endLine ?? enclosing.startLine;
  const field = inFile.find(
    (n) =>
      n.kind === 'field' &&
      n.name === receiverName &&
      n.language === ref.language &&
      n.startLine >= enclosing.startLine &&
      (n.endLine ?? n.startLine) <= enclosingEnd,
  );
  if (!field || !field.signature) return null;

  // Signature shape: "<TypeName> <fieldName>" (extractField). Pull the type,
  // strip generics + dotted package, drop array/varargs markers.
  const beforeName = field.signature.slice(
    0,
    field.signature.lastIndexOf(field.name),
  );
  const typeRaw = beforeName.trim();
  if (!typeRaw) return null;

  const typeNoGenerics = typeRaw.replace(/<[^>]*>/g, '').trim();
  const typeNoArray = typeNoGenerics.replace(/\[\s*\]/g, '').replace(/\.\.\.$/, '').trim();
  const parts = typeNoArray.split(/[.\s]+/).filter(Boolean);
  const lastPart = parts[parts.length - 1];
  if (!lastPart) return null;
  if (!/^[A-Z]/.test(lastPart)) return null; // primitives / lowercase → skip
  return lastPart;
}



/** Go strings, runes and raw struct tags cannot supply type declarations.
 * Preserve newlines so source positions remain comparable with indexed ranges. */
function goTypeEvidenceCode(source: string): string {
  const code = stripCommentsForRegex(source, 'go');
  const out = code.split('');
  for (let i = 0; i < code.length; i++) {
    const quote = code[i];
    if (quote !== '"' && quote !== "'" && quote !== String.fromCharCode(96)) continue;
    const start = i++;
    for (; i < code.length; i++) {
      if (quote !== String.fromCharCode(96) && code[i] === '\\') { i++; continue; }
      if (code[i] === quote) break;
    }
    for (let j = start; j <= i && j < out.length; j++) {
      if (out[j] !== '\n' && out[j] !== '\r') out[j] = ' ';
    }
  }
  return out.join('');
}

/** The Go subset of upstream v1.6.2's source-based local receiver inference.
 * Keep the bounded enclosing-function scan and the three upstream declaration
 * shapes; leave every existing C/C++ receiver path untouched. */
function inferGoLocalReceiverType(receiver: string, ref: UnresolvedRef, context: ResolutionContext): string | null {
  if (!/^[A-Za-z_]\w*$/.test(receiver)) return null;
  const scope = context.getNodesInFile(ref.filePath)
    .filter(n => n.language === 'go' && (n.kind === 'function' || n.kind === 'method')
      && n.startLine <= ref.line && n.endLine >= ref.line)
    .sort((a, b) => b.startLine - a.startLine)[0];
  if (!scope) return null;
  const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/);
  if (!lines) return null;
  const source = goTypeEvidenceCode(lines.slice(scope.startLine - 1, ref.line).join('\n'));
  const r = receiver.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp('\\b' + r + '\\b\\s*:=\\s*&?([A-Za-z_][\\w.]*)\\s*{'),
    new RegExp('\\bvar\\s+' + r + '\\s+\\*?([A-Za-z_][\\w.]*)'),
    new RegExp('\\b' + r + '[ \\t]+\\*?([A-Za-z_][\\w.]*)'),
  ];
  const bounded = source.split('\n');
  const evidence = new Set<string>();
  const binding = new RegExp('\\b' + r + '\\b\\s*(?::=|=(?!=))', 'g');
  for (const line of bounded) {
    if (line.length > 10_000) continue;
    const known = patterns.flatMap(pattern => [...line.matchAll(new RegExp(pattern.source, 'g'))]);
    for (const match of known) if (match[1]) evidence.add(match[1]);
    // Inspect every binding on the line: an inner block can be written on the
    // same line as its enclosing function, and unknown assignments are opaque.
    for (const match of line.matchAll(binding)) {
      if (!known.some(k => k.index! <= match.index! && k.index! + k[0].length >= match.index! + match[0].length)) return null;
    }
  }
  return evidence.size === 1 ? [...evidence][0]! : null;
}


/** Go type names are package-scoped. Preserve the imported package instead of
 * dropping its qualifier and selecting a same-named type in another package. */
function goDeclaredType(raw: string, file: string, context: ResolutionContext): { name: string; directory: string } | null {
  const parts = raw.split('.');
  const name = parts.at(-1)!;
  if (parts.length === 1) return { name, directory: path.posix.dirname(file.replace(/\\/g, '/')) };
  if (parts.length !== 2) return null;
  const mod = context.getGoModule?.();
  const imp = context.getImportMappings(file, 'go').find(i => i.localName === parts[0]);
  if (!mod || !imp || !(imp.source === mod.modulePath || imp.source.startsWith(mod.modulePath + '/'))) return null;
  const suffix = imp.source.slice(mod.modulePath.length).replace(/^\//, '');
  const directory = path.relative(context.getProjectRoot(), path.resolve(mod.rootDir, suffix)).replace(/\\/g, '/') || '.';
  return { name, directory };
}

/** Go builtin/primitive field types that can never carry a project method. */
const GO_BUILTIN_FIELD_TYPES = new Set([
  'string', 'bool', 'byte', 'rune', 'error', 'any',
  'int', 'int8', 'int16', 'int32', 'int64',
  'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
  'float32', 'float64', 'complex64', 'complex128',
  'chan', 'map', 'func', 'struct', 'interface',
]);

/**
 * Resolve a Go 2-hop field-chain call `base.field.Method(...)` (#1276):
 * `target.conn.Exec("insert")` where `func (target *Target) Write()` and
 * `type Target struct { conn *sql.DB }`. Two inference hops, both read from
 * source the same way #1108 does:
 *   1. `base`'s type from the enclosing scope (method receiver, typed
 *      parameter, or local declaration) via inferLocalReceiverType;
 *   2. `field`'s declared type from the struct's own declaration lines.
 * The method is then resolved AND VALIDATED on the field's type. A field
 * whose type has no project node (`sql.DB`, any external dependency) yields
 * null — the caller treats this branch as exclusive for chained Go
 * receivers, so the ref stays unresolved instead of name-guessing.
 */
function matchGoFieldChainCall(
  receiverChain: string,
  methodName: string,
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  const segs = receiverChain.split('.');
  if (segs.length !== 2 || !segs[0] || !segs[1]) return null;
  const [base, field] = segs;

  const baseType = inferGoLocalReceiverType(base!, ref, context);
  if (!baseType) return null;

  const fieldEsc = field!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fieldTypeRe = new RegExp(`\\b${fieldEsc}\\s+\\*?\\[?\\]?([A-Za-z_][\\w.]*)`);

  const baseDeclaration = goDeclaredType(baseType, ref.filePath, context);
  if (!baseDeclaration) return null;
  const structs = context.getNodesByName(baseDeclaration.name).filter(
    n => (n.kind === 'struct' || n.kind === 'class') && n.language === 'go'
      && path.posix.dirname(n.filePath.replace(/\\/g, '/')) === baseDeclaration.directory
  );
  // Duplicate declarations (for example alternative build tags) need evidence;
  // neither file order nor a same-name fallback can choose safely.
  if (structs.length !== 1) return null;
  for (const s of structs) {
    const source = context.readFile(s.filePath);
    if (!source) continue;
    // Only the struct's own declaration lines — a same-named identifier
    // elsewhere in the file can't donate a type. Matched LINE BY LINE with
    // comments stripped: chi's `Mux` has a doc comment reading "the tree
    // router" right above `tree *node`, and a whole-block match captured
    // `router` from the prose instead of `node` from the field.
    const declarationSource = source.split('\n').slice(Math.max(0, s.startLine - 1), s.endLine).join('\n');
    const declLines = goTypeEvidenceCode(declarationSource).split('\n');
    for (const rawLine of declLines) {
      const line = rawLine.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      const m = line.match(fieldTypeRe);
      if (!m || !m[1]) continue;
      const rawType = m[1];
      const declaration = goDeclaredType(rawType, s.filePath, context);
      if (!declaration || GO_BUILTIN_FIELD_TYPES.has(declaration.name)) continue;
      const want = declaration.name + '::' + methodName;
      const methods = context.getNodesByName(methodName).filter(n =>
        n.language === 'go' && n.kind === 'method'
        && (n.qualifiedName === want || n.qualifiedName.endsWith('::' + want))
        && path.posix.dirname(n.filePath.replace(/\\/g, '/')) === declaration.directory);
      if (methods.length === 1) {
        return { original: ref, targetNodeId: methods[0]!.id, confidence: 0.85, resolvedBy: 'instance-method' };
      }
      // Known field/package but absent or ambiguous target: keep it unresolved.
      return null;
    }
  }
  return null;
}

/**
 * Try to resolve by method name on a class/object
 */
export function matchMethodCall(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  if (ref.referenceKind === 'instantiates') return null;

  // Parse method call patterns like "obj.method" or "Class::method". The method
  // part allows trailing `:` keywords so Objective-C selectors resolve
  // (`SDImageCache.storeImage:`, `obj.setX:y:`); colons never appear in other
  // languages' method refs, so this is a no-op for them.
  // The receiver allows dots (`builder.Services.AddCoreServices`) so a CHAINED
  // call resolves by its last segment — Strategy 3 below name-matches the method
  // (with its existing single-candidate / receiver-overlap guards). Without this
  // a multi-dot extension-method call (C# DI `builder.Services.AddCoreServices()`,
  // `Guard.Against.X()`) matched no pattern and never resolved.
  const dotMatch = ref.referenceName.match(/^([\w.]+)\.(\w+:?(?:\w+:)*)$/);
  const colonMatch = ref.referenceName.match(ref.language === 'cpp'
    ? /^(\w+(?:::\w+)*)::(\w+)$/ : /^(\w+)::(\w+)$/);

  const match = dotMatch || colonMatch;
  if (!match) {
    return null;
  }

  const [, objectOrClass, methodName] = match;

  if (ref.language === 'cpp') {
    if (colonMatch) return resolveMethodOnType(objectOrClass!, methodName!, ref, context, 0.85, 'qualified-name');
    const inferredType = objectOrClass === 'this' ? cppCallerOwner(ref, context)
      : inferCppReceiverType(objectOrClass!, ref, context);
    // Unknown and known-but-unmatched receivers never become types through
    // capitalization, word overlap, or a unique project-wide method name.
    return inferredType ? resolveMethodOnType(inferredType, methodName!, ref, context, 0.9, 'instance-method') : null;
  }

  // Java/Kotlin: receiver may be a field whose name doesn't match the type by
  // Java naming convention (`userbo` → class `UserBO`, abbreviated). Look up
  // the field in the enclosing class to get its declared type, then resolve
  // the method on that type. Covers Spring `@Resource`/`@Autowired` field
  // injection where the field type is the concrete bean class.
  if ((ref.language === 'java' || ref.language === 'kotlin') && dotMatch) {
    const inferredType = inferJavaFieldReceiverType(objectOrClass!, ref, context);
    if (inferredType) {
      // When two classes share the same simple name, the caller file's
      // import is the only signal that names WHICH one — pass the
      // imported FQN so resolveMethodOnType can disambiguate (#314).
      const imports = context.getImportMappings(ref.filePath, ref.language);
      const importedFqn = imports.find((i) => i.localName === inferredType)?.source;
      const typedMatch = resolveMethodOnType(
        inferredType,
        methodName!,
        ref,
        context,
        0.9,
        'instance-method',
        importedFqn,
      );
      if (typedMatch) {
        return typedMatch;
      }
    }
  }

  // Strategy 1: Direct class name match (existing logic)
  const classCandidates = context.getNodesByName(objectOrClass!);

  for (const classNode of classCandidates) {
    if (classNode.kind === 'class' || classNode.kind === 'struct' || classNode.kind === 'interface') {
      // Skip cross-language class matches
      if (classNode.language !== ref.language) continue;

      const nodesInFile = context.getNodesInFile(classNode.filePath);
      const methodNode = nodesInFile.find(
        (n) =>
          n.kind === 'method' &&
          n.name === methodName &&
          n.qualifiedName.includes(classNode.name)
      );

      if (methodNode) {
        return {
          original: ref,
          targetNodeId: methodNode.id,
          confidence: 0.85,
          resolvedBy: 'qualified-name',
        };
      }
    }
  }

  // Strategy 2: Instance variable receiver - try capitalized form to find class
  // e.g., "permissionEngine" → look for classes containing "PermissionEngine"
  const capitalizedReceiver = objectOrClass!.charAt(0).toUpperCase() + objectOrClass!.slice(1);
  if (capitalizedReceiver !== objectOrClass) {
    const fuzzyClassCandidates = context.getNodesByName(capitalizedReceiver);
    for (const classNode of fuzzyClassCandidates) {
      if (classNode.kind === 'class' || classNode.kind === 'struct' || classNode.kind === 'interface') {
        // Skip cross-language class matches
        if (classNode.language !== ref.language) continue;

        const nodesInFile = context.getNodesInFile(classNode.filePath);
        const methodNode = nodesInFile.find(
          (n) =>
            n.kind === 'method' &&
            n.name === methodName &&
            n.qualifiedName.includes(classNode.name)
        );

        if (methodNode) {
          return {
            original: ref,
            targetNodeId: methodNode.id,
            confidence: 0.8,
            resolvedBy: 'instance-method',
          };
        }
      }
    }
  }

  // Strategy 3: Find methods by name across the codebase, match by receiver
  // name similarity with the containing class. Handles abbreviated variable
  // names like permissionEngine → PermissionRuleEngine.
  if (methodName) {
    const methodCandidates = context.getNodesByName(methodName!);
    let methodCount = 0;
    let sameLanguageCount = 0;
    let singleSameLanguage: Node | undefined;
    // Count without allocating two filtered arrays for every reference. The
    // scoring pass below keeps the exact original candidate order.
    for (const candidate of methodCandidates) {
      if (candidate.kind !== 'method' || candidate.name !== methodName) continue;
      methodCount++;
      if (candidate.language === ref.language) {
        sameLanguageCount++;
        singleSameLanguage = candidate;
      }
    }
    const targetCount = sameLanguageCount || methodCount;

    // If only one same-language method with this name exists, use it
    if (sameLanguageCount === 1) {
      return {
        original: ref,
        targetNodeId: singleSameLanguage!.id,
        confidence: 0.7,
        resolvedBy: 'instance-method',
      };
    }

    // Multiple methods: score by receiver name word overlap with class name
    if (targetCount > 1) {
      const receiverWords = context.getLowerNameWords?.(objectOrClass!) ??
        (context.getNameWords?.(objectOrClass!) ?? splitNameWords(objectOrClass!)).map(word => word.toLowerCase());
      const maxScore = receiverWords.length + (sameLanguageCount > 0 ? 1 : 0);
      if (maxScore < 2) return null;
      let bestMatch: Node | undefined;
      let bestScore = 0;

      for (const method of methodCandidates) {
        if (method.kind !== 'method' || method.name !== methodName ||
            (sameLanguageCount > 0 && method.language !== ref.language)) continue;
        const classWords = context.getLowerNameWords?.(method.qualifiedName) ??
          (context.getNameWords?.(method.qualifiedName) ?? splitNameWords(method.qualifiedName)).map(word => word.toLowerCase());
        let score = 0;
        // Duplicate receiver words each contribute, but a class word matches
        // only once per receiver word, exactly as filter(...some(...)) did.
        for (const word of receiverWords) {
          if (classWords.includes(word)) score++;
        }
        // Bonus for same language
        if (method.language === ref.language) score += 1;
        if (score > bestScore) {
          bestScore = score;
          bestMatch = method;
          // No later candidate can beat this score; ties keep the first match.
          if (score === maxScore) break;
        }
      }

      if (bestMatch && bestScore >= 2) {
        return {
          original: ref,
          targetNodeId: bestMatch.id,
          confidence: 0.65,
          resolvedBy: 'instance-method',
        };
      }
    }
  }

  return null;
}

/**
 * Compute directory proximity between two file paths.
 * Returns a score based on the number of shared directory segments.
 * Higher score = closer in directory tree.
 */
function computePathProximity(filePath1: string, filePath2: string): number {
  const dir1 = filePath1.split('/').slice(0, -1);
  const dir2 = filePath2.split('/').slice(0, -1);

  let shared = 0;
  for (let i = 0; i < Math.min(dir1.length, dir2.length); i++) {
    if (dir1[i] === dir2[i]) {
      shared++;
    } else {
      break;
    }
  }

  // Each shared directory segment contributes 15 points, capped at 80
  return Math.min(shared * 15, 80);
}

/**
 * Find the best matching node when there are multiple candidates
 */
function findBestMatch(
  ref: UnresolvedRef,
  candidates: Node[],
  _context: ResolutionContext
): Node | null {
  // Prioritization rules:
  // 1. Same file > different file
  // 2. Directory proximity (same module/package > different module)
  // 3. Same language > different language
  // 4. Functions/methods > classes/types (for call references)
  // 5. Exported > non-exported

  let bestScore = -1;
  let bestNode: Node | null = null;

  for (const candidate of candidates) {
    let score = 0;

    // Same file bonus
    if (candidate.filePath === ref.filePath) {
      score += 100;
    }

    // Directory proximity bonus — strongly prefer same module/package
    score += computePathProximity(ref.filePath, candidate.filePath);

    // Language matching: strongly prefer same language, penalize cross-language
    if (candidate.language === ref.language) {
      score += 50;
    } else {
      score -= 80;
    }

    // For call references, prefer functions/methods
    if (ref.referenceKind === 'calls') {
      if (candidate.kind === 'function' || candidate.kind === 'method') {
        score += 25;
      }
    }

    // For instantiation references (`new Foo()`), prefer class-like
    // targets — without this, a function named `Foo` in another module
    // could outscore the actual class.
    if (ref.referenceKind === 'instantiates' && isValidInstantiationTarget(candidate, ref)) {
      score += 25;
    }

    // For decorator references (`@Foo`), prefer functions. Class
    // decorators (Python `@SomeClass`, Java annotation interfaces)
    // also resolve here, hence the smaller class bonus.
    if (ref.referenceKind === 'decorates') {
      if (candidate.kind === 'function' || candidate.kind === 'method') {
        score += 25;
      } else if (candidate.kind === 'class' || candidate.kind === 'interface') {
        score += 15;
      }
    }

    // Exported bonus
    if (candidate.isExported) {
      score += 10;
    }

    // Closer line number (within same file)
    if (candidate.filePath === ref.filePath && candidate.startLine) {
      const distance = Math.abs(candidate.startLine - ref.line);
      score += Math.max(0, 20 - distance / 10);
    }

    if (score > bestScore) {
      bestScore = score;
      bestNode = candidate;
    }
  }

  return bestNode;
}

/**
 * Fuzzy match - last resort with lower confidence
 */
export function matchFuzzy(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  const lowerName = ref.referenceName.toLowerCase();

  // Use pre-built lowercase index for O(1) lookup instead of scanning all nodes
  const candidates = context.getNodesByLowerName(lowerName);

  // Calls fuzzily match callable symbols. Explicit construction instead uses
  // the same hard semantic target gate as exact/qualified matching, including
  // structs and type aliases that the historical callable list omitted.
  const callableKinds = new Set(['function', 'method', 'class']);
  const kindCandidates = ref.referenceKind === 'instantiates' || isCppInheritance(ref)
    ? applyTargetKindGate(candidates, ref)
    : candidates.filter((n) => callableKinds.has(n.kind));
  const callableCandidates = applyCppCandidateGates(applyLanguageGate(kindCandidates, ref), ref, context);

  // Prefer same-language matches
  const sameLanguageCandidates = callableCandidates.filter(n => n.language === ref.language);
  const finalCandidates = sameLanguageCandidates.length > 0 ? sameLanguageCandidates : callableCandidates;

  if (finalCandidates.length === 1) {
    const isCrossLanguage = finalCandidates[0]!.language !== ref.language;
    return {
      original: ref,
      targetNodeId: finalCandidates[0]!.id,
      confidence: isCrossLanguage ? 0.3 : 0.5,
      resolvedBy: 'fuzzy',
    };
  }

  return null;
}


const TS_JS_FIELD_LANGUAGES = new Set(['typescript', 'tsx', 'javascript', 'jsx']);

/** Strings cannot prove a field declaration. Keep offsets/newlines for indexed ranges. */
function tsFieldEvidenceCode(source: string): string {
  const text = stripCommentsForRegex(source, 'typescript');
  const out = text.split('');
  for (let i = 0; i < text.length; i++) {
    const quote = text[i];
    if (quote !== "'" && quote !== '"' && quote !== String.fromCharCode(96)) continue;
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i++] === quote) break;
    }
    for (let j = start; j < i && j < out.length; j++) {
      if (out[j] !== '\n' && out[j] !== '\r') out[j] = ' ';
    }
    i--;
  }
  return out.join('');
}

function tsIndexedSource(node: Node, lines: readonly string[]): string {
  const selected = lines.slice(node.startLine - 1, node.endLine);
  if (!selected.length) return '';
  const last = selected.length - 1;
  selected[last] = selected[last]!.slice(0, node.endColumn);
  selected[0] = selected[0]!.slice(node.startColumn);
  return selected.join('\n');
}

/** Top-level separators only: generic arguments and defaults may contain commas. */
function tsFieldParameters(parameters: string): string[] {
  const parts: string[] = [];
  let start = 0, depth = 0;
  for (let i = 0; i < parameters.length; i++) {
    const c = parameters[i]!;
    if ('([{<'.includes(c)) depth++;
    else if (')]}'.includes(c) || (c === '>' && parameters[i - 1] !== '=')) depth--;
    else if (c === ',' && depth === 0) { parts.push(parameters.slice(start, i)); start = i + 1; }
  }
  parts.push(parameters.slice(start));
  return parts;
}

/** A union, array, function type or value-level expression does not name one receiver type. */
function tsSingleFieldType(raw: string): string | null {
  const value = raw.trim().replace(/^readonly\s+/, '');
  const match = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?:\s*<[\s\S]*>)?$/.exec(value);
  if (!match || /^(?:any|unknown|never|void|string|number|boolean|object|null|undefined|bigint|symbol|this)$/.test(match[1]!)) return null;
  return match[1]!;
}

/** Read only actual class property nodes or constructor parameter properties;
 * a same-named local object/member inside a method is not this.field's type.
 * This is the declaration-evidence boundary behind upstream #1496. */
function tsThisFieldType(cls: Node, field: string, context: ResolutionContext): string | null {
  const source = context.readFile(cls.filePath);
  if (!source) return null;
  const lines = tsFieldEvidenceCode(source).split('\n');
  const prefix = cls.qualifiedName + '::';
  const members = context.getNodesInFile(cls.filePath).filter(n =>
    n.qualifiedName.startsWith(prefix) && n.qualifiedName.slice(prefix.length).indexOf('::') === -1);
  const properties = members.filter(n => n.kind === 'property' && n.name === field);
  const constructors = members.filter(n => n.kind === 'method' && n.name === 'constructor');
  const declared: Array<string | null> = [];
  for (const property of properties) {
    const signature = property.signature?.trim();
    if (signature && signature.endsWith(' ' + field)) {
      declared.push(tsSingleFieldType(signature.slice(0, -field.length).trim()));
    }
  }
  const constructorBodies: string[] = [];
  for (const constructor of constructors) {
    const code = tsIndexedSource(constructor, lines);
    const opening = /\bconstructor\s*\(/.exec(code);
    if (!opening) continue;
    const start = opening.index + opening[0].length;
    let depth = 1, end = start;
    for (; end < code.length && depth > 0; end++) {
      if (code[end] === '(') depth++;
      else if (code[end] === ')') depth--;
    }
    if (depth !== 0) continue;
    for (const parameter of tsFieldParameters(code.slice(start, end - 1))) {
      const match = /^\s*(?:(?:public|private|protected|readonly|override)\s+)+([A-Za-z_$][\w$]*)[?!]?\s*:\s*([\s\S]+)$/.exec(parameter);
      if (match?.[1] === field) declared.push(tsSingleFieldType(match[2]!.split('=')[0]!));
    }
    constructorBodies.push(code.slice(end));
  }
  if (declared.length) {
    const types = new Set(declared);
    return !types.has(null) && types.size === 1 ? [...types][0]! : null;
  }

  // JS/unannotated TS: require an explicit new initializer, not a guessed
  // factory return type. Conflicting or opaque assignments stay unresolved.
  const escaped = field.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');
  const initialized: Array<string | null> = [];
  const initializerType = (text: string): string | null => {
    const match = /^\s*new\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?:\s*<[^;=]*>)?\s*\(/.exec(text);
    return match?.[1] ?? null;
  };
  for (const property of properties) {
    const code = tsIndexedSource(property, lines);
    const match = new RegExp('^(?:(?:public|private|protected|readonly|static|declare|override)\\s+)*' + escaped + '\\s*[?!]?\\s*=\\s*([\\s\\S]*)$').exec(code.trim());
    if (match) initialized.push(initializerType(match[1]!));
  }
  for (const body of constructorBodies) {
    const pattern = new RegExp('\\bthis\\s*\\.\\s*' + escaped + '\\s*=\\s*', 'g');
    for (const match of body.matchAll(pattern)) initialized.push(initializerType(body.slice(match.index! + match[0].length)));
  }
  const types = new Set(initialized);
  return !types.has(null) && types.size === 1 ? [...types][0]! : null;
}

function matchTsThisFieldCall(
  field: string,
  method: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null {
  const caller = context.getNodesInFile(ref.filePath).find(n => n.id === ref.fromNodeId);
  if (!caller) return null;
  const sep = caller.qualifiedName.lastIndexOf('::');
  if (sep <= 0) return null;
  const ownerName = caller.qualifiedName.slice(0, sep);
  const owners = context.getNodesInFile(ref.filePath).filter(n =>
    (n.kind === 'class' || n.kind === 'component') && n.qualifiedName === ownerName &&
    sameLanguageFamily(n.language, ref.language) && n.startLine <= ref.line && n.endLine >= ref.line);
  if (owners.length !== 1) return null;
  const type = tsThisFieldType(owners[0]!, field, context);
  if (!type) return null;

  // Validate each target against its declared owner. Ambiguous types/methods
  // cannot fall back to the nearby wrapper or another same-named method.
  const visit = (typeName: string, sourceFile: string, depth: number, seen: Set<string>): Node | null => {
    if (depth > 4 || seen.has(typeName)) return null;
    seen.add(typeName);
    const parts = typeName.split('.');
    const leaf = parts.at(-1)!;
    const bindings = context.getImportMappings(sourceFile, ref.language).filter(i => i.localName === parts[0]);
    if (bindings.length > 1) return null;
    const binding = bindings[0];
    const bindingPath = binding
      ? binding.resolvedPath ?? resolveImportPath(binding.source, sourceFile, ref.language, context)
      : null;
    if (binding && !bindingPath) return null; // an external/unknown module is not a local namesake
    const targetName = binding && parts.length === 1 && !binding.isDefault ? binding.exportedName : leaf;
    let types = binding?.isDefault && parts.length === 1
      ? context.getNodesInFile(bindingPath!).filter(n => n.isExported)
      : context.getNodesByName(targetName);
    types = types.filter(n =>
      (n.kind === 'class' || n.kind === 'interface' || n.kind === 'component') &&
      sameLanguageFamily(n.language, ref.language));
    if (binding) {
      if (parts.length > 1 && !binding.isNamespace) return null;
      types = types.filter(n => n.filePath === bindingPath);
    } else if (parts.length > 1) {
      const qualified = parts.join('::');
      types = types.filter(n => n.filePath === sourceFile &&
        (n.qualifiedName === qualified || n.qualifiedName.endsWith('::' + qualified)));
    } else {
      // Without an import binding, only a declaration in this file proves
      // the receiver type; a project-wide namesake may be another module.
      types = types.filter(n => n.filePath === sourceFile);
    }
    if (types.length !== 1) return null;
    const owner = types[0]!;
    const matches = context.getNodesByName(method).filter(n =>
      n.kind === 'method' && n.filePath === owner.filePath &&
      n.qualifiedName === owner.qualifiedName + '::' + method &&
      sameLanguageFamily(n.language, ref.language));
    if (matches.length) return matches.length === 1 ? matches[0]! : null;
    const inherited = (context.getSupertypes?.(leaf, owner.language) ?? [])
      .map(base => visit(base, owner.filePath, depth + 1, new Set(seen))).filter((n): n is Node => !!n);
    const unique = new Map(inherited.map(n => [n.id, n]));
    return unique.size === 1 ? [...unique.values()][0]! : null;
  };
  const target = visit(type, ref.filePath, 0, new Set());
  return target ? { original: ref, targetNodeId: target.id, confidence: 0.85, resolvedBy: 'instance-method' } : null;
}

/**
 * Match all strategies in order of confidence
 */
export function matchReference(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // C/C++ imports are #include paths, not symbol bindings. A missing header
  // must stay unresolved: exact/fuzzy lookup can otherwise select the include's
  // own import node and persist a "successful" edge that survives restoration.
  // Keep the existing file-path fallback (include-directory/suffix matches),
  // and leave symbol imports in all other languages on their normal path.
  if (ref.referenceKind === 'imports' && (ref.language === 'c' || ref.language === 'cpp')) {
    return matchByFilePath(ref, context);
  }
  // Try strategies in order of confidence
  let result: ResolvedRef | null;

  // Construction expressions name types. Do not run file/receiver/call-chain
  // strategies: a qualified `new A::B()` must not resolve to method `A::B`.
  if (ref.referenceKind === 'instantiates' || isCppInheritance(ref)) {
    result = matchByQualifiedName(ref, context);
    if (result) return result;
    result = matchByExactName(ref, context);
    if (result) return result;
    return matchFuzzy(ref, context);
  }

  // Explicit TS/JS field receivers are authoritative, like the Go field
  // chain below. Unknown/external/ambiguous fields must remain unresolved.
  if (TS_JS_FIELD_LANGUAGES.has(ref.language) && ref.referenceKind === 'calls') {
    const fieldCall = /^this\.(#?[A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(ref.referenceName);
    if (fieldCall) return matchTsThisFieldCall(fieldCall[1]!, fieldCall[2]!, ref, context);
  }

  // Go field chains are authoritative receiver evidence. If the field type
  // is unknown/external, do not let a later fuzzy/name-only strategy fabricate
  // an edge to an unrelated same-named local method (upstream #1276).
  if (ref.language === 'go' && ref.referenceKind === 'calls') {
    const chain = /^([A-Za-z_]\w*\.[A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(ref.referenceName);
    if (chain) return matchGoFieldChainCall(chain[1]!, chain[2]!, ref, context);
  }

  // 0. File path match (e.g., "snippets/drawer-menu.liquid" → file node)
  result = matchByFilePath(ref, context);
  if (result) return result;

  // 1. Qualified name match (highest confidence)
  result = matchByQualifiedName(ref, context);
  if (result) return result;

  // 1b. C++ chained call whose receiver is another call — `Foo::instance().bar()`
  // encoded as `Foo::instance().bar` by the extractor (#645). Resolve the
  // receiver's type from what the inner call returns, then the method on it.
  if (ref.language === 'cpp' || ref.language === 'c') {
    result = matchCppCallChain(ref, context);
    if (result) return result;
  }

  // 1c. `::`-scoped factory chain — PHP `Cls::for($x)->method()` (#608) or Rust
  // `Foo::new().bar()`, both encoded as `Cls::factory().method`. The receiver's
  // type is the factory's `self` (PHP `: self`/`: static`, Rust `-> Self`) or
  // concrete return type.
  if (ref.language === 'php' || ref.language === 'rust') {
    result = matchScopedCallChain(ref, context);
    if (result) return result;
  }

  // 1d. Dotted chained static-factory / fluent call (Java / Kotlin / C# / Swift /
  // Go / Scala / Dart) — `Foo.getInstance().bar()` encoded as `Foo.getInstance().bar`,
  // Go's bare-factory `New().Method()` as `New().Method`, Scala's companion factory
  // `Foo.create().bar()`, or Dart's static factory / factory-constructor
  // `Foo.create().bar()` (#645/#608 mechanism). Resolve the method's class from the
  // inner call's declared return type, then validate it.
  if (
    ref.language === 'java' ||
    ref.language === 'kotlin' ||
    ref.language === 'csharp' ||
    ref.language === 'swift' ||
    ref.language === 'go' ||
    ref.language === 'scala' ||
    ref.language === 'dart'
  ) {
    result = matchDottedCallChain(ref, context);
    if (result) return result;
  }

  // 2. Method call pattern
  result = matchMethodCall(ref, context);
  if (result) return result;

  // 3. Exact name match
  result = matchByExactName(ref, context);
  if (result) return result;

  // 4. Fuzzy match (lowest confidence)
  result = matchFuzzy(ref, context);
  if (result) return result;

  return null;
}
