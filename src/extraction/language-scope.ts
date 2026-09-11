import { AsyncLocalStorage } from 'node:async_hooks';
import type { Language } from '../types';

export type LanguageScope = 'default' | 'all';

const languageScope = new AsyncLocalStorage<LanguageScope>();
const DEFAULT_LANGUAGES: ReadonlySet<Language> = new Set(['c', 'cpp', 'objc', 'python', 'lua']);

/** The current operation's selection, or the environment between operations. */
export function getLanguageScope(): LanguageScope {
  return languageScope.getStore() ?? (process.env.CODEGRAPH_ALL_LANGUAGES === '1' ? 'all' : 'default');
}

/** Persisted separately from extraction versions so scope changes can rebuild. */
export function getLanguageScopeKey(): 'default-v1' | 'all' {
  return getLanguageScope() === 'all' ? 'all' : 'default-v1';
}

export function isLanguageEnabled(language: Language, scope: LanguageScope = getLanguageScope()): boolean {
  return language !== 'unknown' && (scope === 'all' || DEFAULT_LANGUAGES.has(language));
}

/** Capture once across async work; nested indexing and resolution share it. */
export function withLanguageScope<T>(callback: () => T): T {
  if (languageScope.getStore() !== undefined) return callback();
  return languageScope.run(getLanguageScope(), callback);
}

/** AsyncLocalStorage does not cross worker boundaries; propagate the snapshot. */
export function languageScopeWorkerEnv(): NodeJS.ProcessEnv {
  return { ...process.env, CODEGRAPH_ALL_LANGUAGES: getLanguageScope() === 'all' ? '1' : '0' };
}

/** Long-lived event sources must start operations outside a prior snapshot. */
export function withoutLanguageScope<T>(callback: () => T): T {
  return languageScope.exit(callback);
}
