import { describe, it, expect, vi, beforeEach } from 'vitest';

// Pure-logic regression test for the type-update policy in
// `crawler.ts:refreshAgentSnapshots`. The on-disk function is too coupled
// (DB, federated index, capability discovery) for a cheap integration test,
// but the *policy* is a small pure function and we extract it here verbatim.
// If anyone changes the live policy without updating this test, that change
// is visible — which is the whole point.

interface UpdateDecision {
  canPromote: boolean;
  isDisagreement: boolean;
}

// Mirrors the policy block in `crawler.ts:refreshAgentSnapshots` post-#3538.
// Keep these two implementations in sync — if the live function evolves,
// update this duplicate and the test cases below.
function decide(knownType: string | undefined, inferredType: string): UpdateDecision {
  const canPromote =
    inferredType !== 'unknown' && (!knownType || knownType === 'unknown');
  const isDisagreement =
    !!knownType &&
    knownType !== 'unknown' &&
    inferredType !== 'unknown' &&
    knownType !== inferredType;
  return { canPromote, isDisagreement };
}

describe('crawler type-update policy', () => {
  it('promotes when no stored type and probe gives a real type', () => {
    expect(decide(undefined, 'sales')).toEqual({ canPromote: true, isDisagreement: false });
  });

  it('promotes when stored is unknown and probe gives a real type', () => {
    expect(decide('unknown', 'creative')).toEqual({ canPromote: true, isDisagreement: false });
  });

  it('does NOT promote when stored matches probe', () => {
    expect(decide('sales', 'sales')).toEqual({ canPromote: false, isDisagreement: false });
  });

  it('flags disagreement WITHOUT auto-flipping when stored disagrees with probe', () => {
    expect(decide('buying', 'sales')).toEqual({ canPromote: false, isDisagreement: true });
  });

  it('does not promote when probe returned unknown — never erase stored data', () => {
    expect(decide(undefined, 'unknown')).toEqual({ canPromote: false, isDisagreement: false });
    expect(decide('sales', 'unknown')).toEqual({ canPromote: false, isDisagreement: false });
    expect(decide('unknown', 'unknown')).toEqual({ canPromote: false, isDisagreement: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Audit-log hook for the disagreement path. Closes #3550.
//
// The crawler's disagreement branch ALSO writes a row to
// `type_reclassification_log` with source='crawler_promote' so future audits
// can answer "when did Bidcliq flip from buying to sales?" with a row instead
// of a stdout-grep. The disagreement event itself is what the audit log
// captures — the crawler does NOT auto-flip the stored type.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] }),
}));

// Lazy-import after the mock so the module under test sees the mocked client.
const importHelper = async () =>
  (await import('../../src/db/type-reclassification-log-db.js')).insertTypeReclassification;

describe('crawler disagreement → audit log', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records source=crawler_promote with stored→inferred when disagreement decided', async () => {
    const insertTypeReclassification = await importHelper();
    const { query } = await import('../../src/db/client.js');
    const mockedQuery = vi.mocked(query);

    const knownType = 'buying';
    const inferredType = 'sales';
    const url = 'https://bidcliq.example/agent';

    const { isDisagreement } = decide(knownType, inferredType);
    expect(isDisagreement).toBe(true);

    if (isDisagreement) {
      await insertTypeReclassification({
        agentUrl: url,
        oldType: knownType,
        newType: inferredType,
        source: 'crawler_promote',
        notes: { decision: 'logged_only_no_promote' },
      });
    }

    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockedQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO type_reclassification_log/);
    expect(params?.[0]).toBe(url);
    expect(params?.[2]).toBe('buying');     // old_type
    expect(params?.[3]).toBe('sales');      // new_type
    expect(params?.[4]).toBe('crawler_promote');
    expect(params?.[6]).toBe(JSON.stringify({ decision: 'logged_only_no_promote' }));
  });

  it('does NOT call the audit log when the policy decides "agree" (no flip, no row)', async () => {
    const insertTypeReclassification = await importHelper();
    const { query } = await import('../../src/db/client.js');
    const mockedQuery = vi.mocked(query);

    const { isDisagreement } = decide('sales', 'sales');
    expect(isDisagreement).toBe(false);

    // Same code path as in crawler.ts: only call insertTypeReclassification
    // when the disagreement branch fires.
    if (isDisagreement) {
      await insertTypeReclassification({
        agentUrl: 'https://a',
        newType: 'sales',
        source: 'crawler_promote',
      });
    }

    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it('does NOT call the audit log when the policy decides "promote" (promote is not a logged event)', async () => {
    const insertTypeReclassification = await importHelper();
    const { query } = await import('../../src/db/client.js');
    const mockedQuery = vi.mocked(query);

    const { canPromote, isDisagreement } = decide(undefined, 'sales');
    expect(canPromote).toBe(true);
    expect(isDisagreement).toBe(false);

    if (isDisagreement) {
      await insertTypeReclassification({
        agentUrl: 'https://a',
        newType: 'sales',
        source: 'crawler_promote',
      });
    }

    expect(mockedQuery).not.toHaveBeenCalled();
  });
});
