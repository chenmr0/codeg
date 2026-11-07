import { describe, expect, it } from 'vitest';
import { cppCallableOwnersMatch } from '../src/resolution/cpp-signature';
import { CppTargetIdentity, exploreCppCallableOwnersMatch } from '../src/upstream-explore/mcp/cpp-target-identity';
import type { Node, Edge } from '../src/upstream-explore/types';

const named = (qualifiedName: string) => ({ qualifiedName });
describe('Explore owner case isolation from persistent synthesis', () => {
  it('requires case-sensitive owner identity but permits an unambiguous short suffix', () => {
    expect(exploreCppCallableOwnersMatch(named('left::Channel::send'), named('Left::Channel::send'))).toBe(false);
    expect(exploreCppCallableOwnersMatch(named('Channel::send'), named('left::Channel::send'))).toBe(true);
    expect(exploreCppCallableOwnersMatch(named('channel::send'), named('left::Channel::send'))).toBe(false);
    expect(exploreCppCallableOwnersMatch(named('left::Channel::send'), named('right::Channel::send'))).toBe(false);
    expect(exploreCppCallableOwnersMatch(named('send'), named('left::Channel::send'))).toBe(false);
    // Explicit migration boundary: don't silently change existing synthesis or
    // other native tools when tightening the new read-only Explore identity.
    expect(cppCallableOwnersMatch(named('left::Channel::send'), named('Left::Channel::send'))).toBe(true);
  });

  it('refuses a persisted legacy case-folded defines bridge without changing that edge', () => {
    const declaration = { id: 'decl', name: 'send', qualifiedName: 'left::Channel::send',
      language: 'cpp', kind: 'method', signature: 'int send(int value)', isDeclaration: true,
      filePath: 'channel.hpp' } as Node;
    const definition = { ...declaration, id: 'def', qualifiedName: 'Left::Channel::send',
      isDeclaration: false, filePath: 'channel.cpp' } as Node;
    const bridge = { source: 'def', target: 'decl', kind: 'defines',
      metadata: { synthesizedBy: 'cpp-decl-def' } } as Edge;
    const before = JSON.stringify(bridge);
    const identity = new CppTargetIdentity({
      getNode: id => id === 'def' ? definition : declaration,
      getIncomingEdges: () => [bridge],
    }, new Set());
    expect(identity.canonical(declaration)).toBe(declaration);
    expect(identity.unique([declaration, definition])).toHaveLength(2);
    expect(JSON.stringify(bridge)).toBe(before);
  });
});
