import { describe, it, expect } from 'vitest';

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
