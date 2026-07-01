// Pin the `buying` carve-out in resolveAgentTypes (closes #3549).
//
// Buy-side agents are CLIENTS of AdCP, not servers — they call sales /
// creative / signals tools, they don't expose them. The probe-based
// inference therefore cannot detect type=buying; only member self-
// declaration can. resolveAgentTypes carries member-set `buying` through
// the null-inferred-snapshot override path, while still squashing other
// claimed types to `unknown` in that path (smuggle protection).
//
// Coverage matrix:
//   1. snapshot inferred=sales,    client=buying  → sales (probe wins)
//   2. snapshot inferred=null,     client=buying  → buying (carve-out)
//   3. snapshot inferred=null,     client=sales   → unknown (smuggle blocked)
//   4. snapshot inferred=null,     client=creative → unknown (smuggle blocked)
//   5. snapshot inferred=null,     client=signals  → unknown (smuggle blocked)
//   6. no snapshot,                client=buying  → buying (case 4 path)
//   7. no snapshot,                client=buyer   → unknown (legacy string)

import { describe, it, expect, vi } from 'vitest';

// vi.hoisted lifts the mock state above vi.mock's hoisted factory so
// the factory can reference it. Without hoisted, we'd hit TDZ.
const { __mockBulkGetImpl } = vi.hoisted(() => ({
  __mockBulkGetImpl: vi.fn(async (_urls: string[]) => new Map()),
}));

vi.mock('../../src/db/agent-snapshot-db.js', () => ({
  AgentSnapshotDatabase: class {
    bulkGetCapabilities = __mockBulkGetImpl;
  },
}));

// member-profiles.ts transitively imports WorkOS via auth middleware. Mock
// WorkOS as a class so `new WorkOS(...)` returns a stub — env-var-shim
// approaches don't work because ESM imports are hoisted above any module-
// level `process.env.X = ...` assignment. Same pattern as #3558's reprobe
// test mock.
vi.mock('@workos-inc/node', () => ({
  WorkOS: class {
    userManagement = {};
    organizations = {};
  },
  WorkOSNode: class {
    userManagement = {};
    organizations = {};
  },
}));

import { resolveAgentTypes } from '../../src/routes/member-profiles.js';

type Agent = { url: string; type?: string };

function snapshot(inferred: string | null) {
  return { inferred_type: inferred };
}

describe('resolveAgentTypes — buying carve-out (#3549)', () => {
  it('snapshot inferred=sales overrides client=buying (probe wins)', async () => {
    __mockBulkGetImpl.mockResolvedValueOnce(new Map([
      ['https://a.example', snapshot('sales')],
    ]));
    const out = await resolveAgentTypes([
      { url: 'https://a.example', type: 'buying' } as Agent,
    ]);
    expect((out as Agent[])[0].type).toBe('sales');
  });

  it('snapshot inferred=null + client=buying preserves buying', async () => {
    __mockBulkGetImpl.mockResolvedValueOnce(new Map([
      ['https://a.example', snapshot(null)],
    ]));
    const out = await resolveAgentTypes([
      { url: 'https://a.example', type: 'buying' } as Agent,
    ]);
    expect((out as Agent[])[0].type).toBe('buying');
  });

  it('snapshot inferred=null + client=sales squashes to unknown (smuggle blocked)', async () => {
    __mockBulkGetImpl.mockResolvedValueOnce(new Map([
      ['https://a.example', snapshot(null)],
    ]));
    const out = await resolveAgentTypes([
      { url: 'https://a.example', type: 'sales' } as Agent,
    ]);
    expect((out as Agent[])[0].type).toBe('unknown');
  });

  it('snapshot inferred=null + client=creative squashes to unknown', async () => {
    __mockBulkGetImpl.mockResolvedValueOnce(new Map([
      ['https://a.example', snapshot(null)],
    ]));
    const out = await resolveAgentTypes([
      { url: 'https://a.example', type: 'creative' } as Agent,
    ]);
    expect((out as Agent[])[0].type).toBe('unknown');
  });

  it('snapshot inferred=null + client=signals squashes to unknown', async () => {
    __mockBulkGetImpl.mockResolvedValueOnce(new Map([
      ['https://a.example', snapshot(null)],
    ]));
    const out = await resolveAgentTypes([
      { url: 'https://a.example', type: 'signals' } as Agent,
    ]);
    expect((out as Agent[])[0].type).toBe('unknown');
  });

  it('no snapshot + client=buying preserves buying (case 4 path)', async () => {
    __mockBulkGetImpl.mockResolvedValueOnce(new Map());
    const out = await resolveAgentTypes([
      { url: 'https://a.example', type: 'buying' } as Agent,
    ]);
    expect((out as Agent[])[0].type).toBe('buying');
  });

  it('no snapshot + legacy string=buyer drops to unknown', async () => {
    __mockBulkGetImpl.mockResolvedValueOnce(new Map());
    const out = await resolveAgentTypes([
      { url: 'https://a.example', type: 'buyer' } as Agent,
    ]);
    expect((out as Agent[])[0].type).toBe('unknown');
  });
});
