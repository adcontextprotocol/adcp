/**
 * The #7830 rewrite planner, one test per collision class the audit detects.
 *
 * These are the cases where a blind `UPDATE ... SET key = f(url)` would lose
 * data or pick a winner it has no business picking, so each one has to be
 * visible in a dry run and — where it is destructive — refuse the apply.
 */
import { describe, expect, it } from 'vitest';
import {
  planIsBlocked,
  planStoreRewrite,
  type KeyedRow,
} from '../../src/scripts/registry-agent-url-key-rewrite-plan.js';

const row = (over: Partial<KeyedRow> & Pick<KeyedRow, 'rowId' | 'rawUrl'>): KeyedRow => ({
  storedKey: over.rawUrl.trim().toLowerCase().replace(/\/+$/, ''),
  scopes: [''],
  ...over,
});

describe('planStoreRewrite', () => {
  it('leaves a row alone when the registry key already matches', () => {
    const plan = planStoreRewrite('s', [row({ rowId: '1', rawUrl: 'https://agent.example/mcp' })]);
    expect(plan.rewrites).toEqual([]);
    expect(planIsBlocked(plan)).toBe(false);
  });

  it('folds a trailing slash, so /mcp/ and /mcp collide on one key', () => {
    const plan = planStoreRewrite('s', [
      row({ rowId: 'a', rawUrl: 'https://agent.example/mcp/', storedKey: 'https://agent.example/mcp/' }),
      row({ rowId: 'b', rawUrl: 'https://agent.example/mcp' }),
    ]);
    expect(plan.rewrites.map(r => r.rowId)).toEqual(['a']);
    expect(plan.merges).toHaveLength(1);
    expect(plan.merges[0].key).toBe('https://agent.example/mcp');
    expect(planIsBlocked(plan)).toBe(true);
  });

  it('keeps root-served agents byte-identical, so they need no rewrite', () => {
    const plan = planStoreRewrite('s', [
      row({ rowId: '1', rawUrl: 'https://agent.example/' }),
      row({ rowId: '2', rawUrl: 'HTTPS://Agent.Example' }),
    ]);
    expect(plan.rewrites).toEqual([]);
  });

  it('rewrites a row whose path case the old key destroyed', () => {
    const plan = planStoreRewrite('s', [
      row({ rowId: '1', rawUrl: 'https://agent.example/tenants/Acme/mcp' }),
    ]);
    expect(plan.rewrites).toEqual([{
      rowId: '1',
      rawUrl: 'https://agent.example/tenants/Acme/mcp',
      fromKey: 'https://agent.example/tenants/acme/mcp',
      toKey: 'https://agent.example/tenants/Acme/mcp',
    }]);
    expect(planIsBlocked(plan)).toBe(false);
  });

  it('rewrites the other changed classes: trailing slash, port, dot segments, percent, IDN', () => {
    const plan = planStoreRewrite('s', [
      // Self-keyed in production: the stored key itself carries the slash,
      // which is where the trailing-slash collisions come from.
      row({
        rowId: 'slash',
        rawUrl: 'https://agent.example/mcp/',
        storedKey: 'https://agent.example/mcp/',
      }),
      row({ rowId: 'port', rawUrl: 'https://agent.example:443/mcp' }),
      row({ rowId: 'dots', rawUrl: 'https://agent.example/a/./b/../c' }),
      row({ rowId: 'pct', rawUrl: 'https://agent.example/%7Euser' }),
      row({ rowId: 'idn', rawUrl: 'https://bücher.example/mcp' }),
      row({ rowId: 'frag', rawUrl: 'https://agent.example/mcp#x' }),
    ]);
    expect(Object.fromEntries(plan.rewrites.map(r => [r.rowId, r.toKey]))).toEqual({
      slash: 'https://agent.example/mcp',
      port: 'https://agent.example/mcp',
      dots: 'https://agent.example/a/c',
      pct: 'https://agent.example/~user',
      idn: 'https://xn--bcher-kva.example/mcp',
      frag: 'https://agent.example/mcp',
    });
  });

  it('blocks on a merge: two live rows in one scope landing on one key', () => {
    const plan = planStoreRewrite('s', [
      row({ rowId: 'a', rawUrl: 'https://agent.example:443/mcp' }),
      row({ rowId: 'b', rawUrl: 'https://agent.example/mcp' }),
    ]);
    expect(plan.merges).toHaveLength(1);
    expect(plan.merges[0].key).toBe('https://agent.example/mcp');
    expect(plan.merges[0].rows.map(r => r.rowId).sort()).toEqual(['a', 'b']);
    expect(planIsBlocked(plan)).toBe(true);
  });

  it('does not call it a merge when the colliding rows sit in different scopes', () => {
    const plan = planStoreRewrite('s', [
      row({ rowId: 'a', rawUrl: 'https://agent.example:443/mcp', scopes: ['pub-a'] }),
      row({ rowId: 'b', rawUrl: 'https://agent.example/mcp', scopes: ['pub-b'] }),
    ]);
    expect(plan.merges).toEqual([]);
    expect(planIsBlocked(plan)).toBe(false);
  });

  it('reports a split without blocking: one old key, several real agents', () => {
    const plan = planStoreRewrite('s', [
      row({ rowId: 'a', rawUrl: 'https://agent.example/Mcp', scopes: ['pub-a'] }),
      row({ rowId: 'b', rawUrl: 'https://agent.example/mcp', scopes: ['pub-b'] }),
    ]);
    expect(plan.splits).toHaveLength(1);
    expect(plan.splits[0].legacyKey).toBe('https://agent.example/mcp');
    expect(plan.splits[0].keys.sort())
      .toEqual(['https://agent.example/Mcp', 'https://agent.example/mcp']);
    expect(planIsBlocked(plan)).toBe(false);
  });

  it('blocks on a row whose URL no longer produces a key', () => {
    const plan = planStoreRewrite('s', [
      row({ rowId: 'bad', rawUrl: 'agent.example/mcp', storedKey: 'agent.example/mcp' }),
    ]);
    expect(plan.unkeyable).toEqual([
      { rowId: 'bad', rawUrl: 'agent.example/mcp', storedKey: 'agent.example/mcp' },
    ]);
    expect(plan.rewrites).toEqual([]);
    expect(planIsBlocked(plan)).toBe(true);
  });

  it('never proposes a rewrite for the wildcard sentinel', () => {
    const plan = planStoreRewrite('s', [row({ rowId: 'w', rawUrl: '*', storedKey: '*' })]);
    expect(plan.rewrites).toEqual([]);
    expect(plan.lossyRows).toEqual([]);
    expect(planIsBlocked(plan)).toBe(false);
  });

  it('flags lossy rows only for stores that overwrote their raw URL', () => {
    const rows = [
      row({ rowId: 'path', rawUrl: 'https://agent.example/mcp', storedKey: 'https://agent.example/mcp' }),
      row({ rowId: 'root', rawUrl: 'https://agent.example', storedKey: 'https://agent.example' }),
    ];
    expect(planStoreRewrite('raw-kept', rows).lossyRows).toEqual([]);
    // A root-served agent survived the old algorithm intact; a path did not.
    expect(planStoreRewrite('key-only', rows, true).lossyRows).toEqual([
      { rowId: 'path', rawUrl: 'https://agent.example/mcp', newKey: 'https://agent.example/mcp' },
    ]);
  });

  it('finds no merge when nothing constrains the key', () => {
    // History tables hold many rows per agent and have no unique index on
    // agent_url, so two rows landing on one key is the normal case.
    const plan = planStoreRewrite('s', [
      row({ rowId: 'a', rawUrl: 'https://agent.example:443/mcp', scopes: [] }),
      row({ rowId: 'b', rawUrl: 'https://agent.example/mcp', scopes: [] }),
    ]);
    expect(plan.merges).toEqual([]);
    expect(planIsBlocked(plan)).toBe(false);
  });

  it('finds a merge when any one of several unique indexes would be violated', () => {
    const plan = planStoreRewrite('s', [
      row({ rowId: 'a', rawUrl: 'https://agent.example:443/mcp', scopes: ['0\u0000x', '1\u0000y'] }),
      row({ rowId: 'b', rawUrl: 'https://agent.example/mcp', scopes: ['0\u0000z', '1\u0000y'] }),
    ]);
    expect(plan.merges).toHaveLength(1);
    expect(plan.merges[0].scope).toBe('1\u0000y');
    expect(planIsBlocked(plan)).toBe(true);
  });

  it('proposes one rewrite per row even when the row spans several scopes', () => {
    const plan = planStoreRewrite('s', [
      row({ rowId: 'a', rawUrl: 'https://agent.example:443/mcp', scopes: ['0\u0000x', '1\u0000y'] }),
    ]);
    expect(plan.rewrites).toHaveLength(1);
  });

  it('counts a row that moves onto another row\'s existing key as a merge', () => {
    // 'keeper' is already correct; 'mover' is rewritten onto it.
    const plan = planStoreRewrite('s', [
      row({ rowId: 'keeper', rawUrl: 'https://agent.example/a/c' }),
      row({ rowId: 'mover', rawUrl: 'https://agent.example/a/b/../c' }),
    ]);
    expect(plan.rewrites.map(r => r.rowId)).toEqual(['mover']);
    expect(plan.merges).toHaveLength(1);
    expect(planIsBlocked(plan)).toBe(true);
  });
});
