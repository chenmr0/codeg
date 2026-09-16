/**
 * CODEGRAPH_MCP_TOOLS allowlist — lets an operator (or an A/B harness) trim the
 * exposed MCP tool surface without touching the client config. Inert when unset.
 * Filtering happens in ListTools (getTools) and is enforced again on execute().
 *
 * codegraph_wx_explore is disabled by default; set CODEGRAPH_ENABLE_EXPLORE=1 to
 * include it in the surface.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ToolHandler } from '../src/mcp/tools';

const ENV = 'CODEGRAPH_MCP_TOOLS';
const EXPLORE_ENV = 'CODEGRAPH_ENABLE_EXPLORE';

describe('CODEGRAPH_MCP_TOOLS allowlist', () => {
  const allowlistOriginal = process.env[ENV];
  const exploreOriginal = process.env[EXPLORE_ENV];
  afterEach(() => {
    if (allowlistOriginal === undefined) delete process.env[ENV];
    else process.env[ENV] = allowlistOriginal;
    if (exploreOriginal === undefined) delete process.env[EXPLORE_ENV];
    else process.env[EXPLORE_ENV] = exploreOriginal;
  });

  const listed = () => new ToolHandler(null).getTools().map(t => t.name).sort();

  // --- explore disabled by default (CODEGRAPH_ENABLE_EXPLORE unset) ---

  it('does not expose codegraph_wx_explore by default', () => {
    delete process.env[ENV];
    const all = listed();
    expect(all).not.toContain('explore');
    expect(all).toContain('context');
    expect(all).toContain('text_search');
    expect(all.every((name) => !name.startsWith('codegraph_'))).toBe(true);
    expect(all.length).toBeGreaterThanOrEqual(7);
  });

  it('exposes codegraph_wx_explore when CODEGRAPH_ENABLE_EXPLORE=1', () => {
    delete process.env[ENV];
    process.env[EXPLORE_ENV] = '1';
    const all = listed();
    expect(all).toContain('explore');
    expect(all.length).toBeGreaterThanOrEqual(8);
  });

  it('filters ListTools to the allowlisted short names', () => {
    process.env[EXPLORE_ENV] = '1';
    process.env[ENV] = 'explore,search,node';
    expect(listed()).toEqual(['explore', 'node', 'search']);
  });

  it('allowlists the new exact context and literal text search tools', () => {
    process.env[ENV] = 'context,text_search';
    expect(listed()).toEqual(['context', 'text_search']);
  });

  it('requires short raw names and ignores prefixed allowlist entries', () => {
    process.env[EXPLORE_ENV] = '1';
    process.env[ENV] = ' codegraph_wx_explore , search ';
    expect(listed()).toEqual(['search']);
  });

  it('treats an empty/whitespace value as unset (full surface, explore disabled by default)', () => {
    process.env[ENV] = '   ';
    expect(listed().length).toBeGreaterThanOrEqual(7);
  });

  it('rejects a disabled tool on execute (defense in depth)', async () => {
    process.env[ENV] = 'node';
    const res = await new ToolHandler(null).execute('explore', {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/disabled/);
  });

  it('lets an allowlisted tool past the guard', async () => {
    process.env[ENV] = 'search';
    // No CodeGraph attached, so it fails *after* the allowlist guard — the
    // "disabled" message must NOT appear, proving the guard passed it through.
    const res = await new ToolHandler(null).execute('search', { query: 'x' });
    expect(res.content[0].text).not.toMatch(/disabled/);
  });
});
