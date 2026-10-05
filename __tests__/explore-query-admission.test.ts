import { describe, expect, it } from 'vitest';
import { isNaturalLanguageExploreQuery, isNaturalLanguageQuery } from '../src/search/query-utils';

describe('explore symbol-bag admission', () => {
  it.each([
    'AuthService',
    'GraphTraverser BFS impact traversal.ts',
    'Session method helper',
    'dispatch proceed handleLogging LoggingInterceptor BridgeInterceptor CacheInterceptor RetryInterceptor ResponseFormatter',
    'AuthService.loginUser std::string src/traversal.ts',
    'foo\tbar\nbaz',
    'AuthService, loginUser; GraphTraverser',
    'src/foo-bar.ts platform\\worker.ts ::api::run',
  ])('accepts the documented code-name bag: %s', query => {
    expect(isNaturalLanguageExploreQuery(query).isNatural).toBe(false);
  });
  it.each([
    'how does auth work',
    'how does auth work?',
    'find me the login function',
    'please explain AuthService',
    'AuthService 0x4237F001',
    'AuthService 404',
    'AuthService 注册流程',
    'AuthService + loginUser',
  ])('rejects prose, values and non-name expressions: %s', query => {
    expect(isNaturalLanguageExploreQuery(query).isNatural).toBe(true);
  });
  it('does not relax the independent strict single-symbol search contract', () => {
    expect(isNaturalLanguageQuery('AuthService loginUser').isNatural).toBe(true);
    expect(isNaturalLanguageQuery('std::string MyModule::foo').isNatural).toBe(true);
    expect(isNaturalLanguageQuery('loginUser').isNatural).toBe(false);
  });
});
