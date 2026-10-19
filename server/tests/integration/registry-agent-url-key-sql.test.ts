/**
 * The SQL twin of `registryAgentUrlKey` must agree with it (#7830).
 *
 * `registry-agent-url-key-sql.ts` exists so a maintainer can measure a
 * production database before deploying anything. A twin that disagrees with
 * the real helper would produce exactly the wrong answer in exactly the
 * situation it exists for, so this runs a corpus through both and fails on
 * any disagreement outside the subset the twin declares it cannot compute.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { registryAgentUrlKey } from '../../src/db/registry-agent-url-key.js';
import {
  NOT_SQL_COMPUTABLE,
  REGISTRY_KEY,
  UNKEYABLE,
} from '../../src/db/registry-agent-url-key-sql.js';

/** Every class the migration cares about, plus the rejections. */
const CORPUS: string[] = [
  // Unchanged by the new key.
  'https://agent.example',
  'https://agent.example/mcp',
  'https://agent.example/tenants/Acme/mcp',
  'https://agent.example//double',
  'https://agent.example:8443/mcp',
  'https://[2001:db8::1]:8443/mcp',
  '*',
  // Folded by the new key — the classes that produce real merges.
  'https://agent.example/',
  'HTTPS://Agent.Example/mcp',
  ' https://agent.example/mcp ',
  'https://agent.example:443/mcp',
  'http://agent.example:80/mcp',
  'https://agent.example./mcp',
  'https://agent.example/mcp#frag',
  'https://agent.example/mcp/',
  'https://agent.example/mcp///',
  'https://agent.example/mcp/?t=1',
  'https://[2001:DB8::1]:443/mcp',
  // Query handling, including adcp-client#3084.
  'https://agent.example/mcp?b=2&a=1',
  'https://agent.example?',
  'https://agent.example/?',
  'https://agent.example/mcp?',
  'https://agent.example/?token=abc',
  // Rejections.
  '',
  '   ',
  'agent.example/mcp',
  'https:agent.example/mcp',
  'ftp://agent.example/x',
  'https:///mcp',
  'https://user:pw@agent.example/mcp',
  'https://@agent.example/mcp',
  'https://agent.example\\mcp',
  'https://agent.example/m cp',
  'https://agent.example/m\tcp',
  'https://agent.example../mcp',
  'https://.agent.example/mcp',
  'https://agent.example/a*b',
  '**',
  'https://a"b.example/mcp',
  'https://a`b.example/mcp',
  'https://a{b.example/mcp',
  'https://a}b.example/mcp',
  // Declared out of scope for the twin — the helper still keys these.
  'https://bücher.example/mcp',
  'https://agent.example/café',
  'https://agent.example/%7Euser',
  'https://agent.example/a/./b/../c',
  'https://agent.example/mcp?x=%7e',
  'https://agent.example/x?q=​',
];

describe('registryAgentUrlKey SQL twin (#7830)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('agrees with the helper on every URL it claims to compute', async () => {
    const { rows } = await pool.query<{
      raw: string; sql_key: string | null; unkeyable: boolean; out_of_scope: boolean;
    }>(
      `SELECT u AS raw,
              ${REGISTRY_KEY('u')} AS sql_key,
              ${UNKEYABLE('u')} AS unkeyable,
              ${NOT_SQL_COMPUTABLE('u')} AS out_of_scope
         FROM unnest($1::text[]) AS t(u)`,
      [CORPUS],
    );
    expect(rows).toHaveLength(CORPUS.length);

    const outOfScope: string[] = [];
    for (const row of rows) {
      const tsKey = registryAgentUrlKey(row.raw);
      if (row.out_of_scope) {
        // The twin must not answer here, and must not claim the row is
        // unkeyable either — the helper may well key it.
        expect(row.sql_key, row.raw).toBeNull();
        expect(row.unkeyable, row.raw).toBe(false);
        outOfScope.push(row.raw);
        continue;
      }
      expect(row.sql_key, `${row.raw} (ts=${tsKey})`).toBe(tsKey);
      expect(row.unkeyable, row.raw).toBe(tsKey === null);
    }
    // Guard the guard: if the excluded set silently swallowed the whole
    // corpus the assertions above would be vacuous.
    expect(outOfScope).toEqual([
      'https://bücher.example/mcp',
      'https://agent.example/café',
      'https://agent.example/%7Euser',
      'https://agent.example/a/./b/../c',
      'https://agent.example/mcp?x=%7e',
      'https://agent.example/x?q=​',
    ]);
    expect(rows.filter(row => !row.out_of_scope).length).toBeGreaterThan(35);
  });

  it('groups the folding classes together and keeps the significant ones apart', async () => {
    const { rows } = await pool.query<{ key: string; variants: string[] }>(
      `SELECT ${REGISTRY_KEY('u')} AS key, array_agg(u ORDER BY u) AS variants
         FROM unnest($1::text[]) AS t(u)
        WHERE ${REGISTRY_KEY('u')} IS NOT NULL
        GROUP BY 1 HAVING count(*) > 1 ORDER BY 1`,
      [[
        'https://agent.example/mcp',
        'https://agent.example:443/mcp',
        'HTTPS://Agent.Example/mcp',
        'https://agent.example./mcp',
        'https://agent.example/mcp#frag',
        // Folded for registry identity (#7830 maintainer decision).
        'https://agent.example/mcp/',
        'https://agent.example/mcp///',
        // NOT part of that group: path case stays significant.
        'https://agent.example/MCP',
      ]],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe('https://agent.example/mcp');
    expect(rows[0].variants).toHaveLength(7);
  });
});
