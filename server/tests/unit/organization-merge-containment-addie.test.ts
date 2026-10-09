import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberContext } from '../../src/addie/member-context.js';

// The Addie merge handler used to read provider memberships, run the database
// merge, write provider memberships and delete the provider organization twice.
// Every one of those collaborators is a throwing double here.
const effects = vi.hoisted(() => ({
  getPool: vi.fn(() => { throw new Error('Contained merge must not touch the database pool'); }),
  query: vi.fn(() => { throw new Error('Contained merge must not query the database'); }),
  mergeOrganizations: vi.fn(() => { throw new Error('Contained merge must not reach the merge service'); }),
  previewMerge: vi.fn(),
  listOrganizationMemberships: vi.fn(),
  createOrganizationMembership: vi.fn(() => { throw new Error('Contained merge must not write provider memberships'); }),
  deleteOrganization: vi.fn(() => { throw new Error('Contained merge must not delete a provider organization'); }),
  // Not a throwing double: preview legitimately acquires a client, so this is
  // asserted per-branch rather than globally forbidden.
  getWorkos: vi.fn(),
}));

vi.mock('../../src/db/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/client.js')>()),
  getPool: effects.getPool,
  query: effects.query,
}));
vi.mock('../../src/db/org-merge-db.js', () => ({
  mergeOrganizations: effects.mergeOrganizations,
  previewMerge: effects.previewMerge,
}));
vi.mock('../../src/auth/workos-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/auth/workos-client.js')>()),
  getWorkos: effects.getWorkos,
}));

import { createAdminToolHandlers, ADMIN_TOOLS } from '../../src/addie/mcp/admin-tools.js';
import {
  ORGANIZATION_MERGE_UNAVAILABLE_ERROR,
  ORGANIZATION_MERGE_UNAVAILABLE_MESSAGE,
} from '../../src/db/org-merge-containment.js';

const PRIMARY = 'org_merge_addie_primary';
const SECONDARY = 'org_merge_addie_secondary';

const adminMemberContext = {
  is_mapped: true,
  is_member: false,
  slack_linked: true,
  organization: null,
  workos_user: {
    workos_user_id: 'user_merge_addie_admin',
    email: 'sam@merge.example.test',
    first_name: 'Sam',
    last_name: 'Adeyemi',
  },
} as unknown as MemberContext;

const previewFixture = {
  primary_org: { id: PRIMARY, name: 'Pinnacle Agency' },
  secondary_org: { id: SECONDARY, name: 'Pinnacle Media' },
  estimated_changes: [{ table_name: 'organization_memberships', rows_to_move: 2 }],
  stripe_customer_conflict: {
    has_conflict: false,
    primary_customer_id: null,
    secondary_customer_id: null,
    requires_resolution: false,
  },
  warnings: [],
};

function merge(input: Record<string, unknown>) {
  return createAdminToolHandlers(adminMemberContext).get('merge_organizations')!(input);
}

function providerDouble() {
  return {
    organizations: { deleteOrganization: effects.deleteOrganization },
    userManagement: {
      createOrganizationMembership: effects.createOrganizationMembership,
      listOrganizationMemberships: effects.listOrganizationMemberships,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  effects.previewMerge.mockResolvedValue(previewFixture);
  effects.listOrganizationMemberships.mockResolvedValue({ data: [] });
  effects.getWorkos.mockReturnValue(providerDouble());
});

function expectNoExecutionEffects() {
  for (const name of ['getPool', 'query', 'mergeOrganizations', 'createOrganizationMembership', 'deleteOrganization'] as const) {
    expect(effects[name], `${name} must not be called`).not.toHaveBeenCalled();
  }
}

describe('Addie merge_organizations — contained execution', () => {
  const executeInputs = [
    { label: 'plain execute', input: { primary_org_id: PRIMARY, secondary_org_id: SECONDARY, preview: false } },
    { label: 'execute with stripe resolution', input: { primary_org_id: PRIMARY, secondary_org_id: SECONDARY, preview: false, stripe_customer_resolution: 'keep_primary' } },
    { label: 'execute with unknown resolution', input: { primary_org_id: PRIMARY, secondary_org_id: SECONDARY, preview: false, stripe_customer_resolution: 'not_a_resolution' } },
    { label: 'reversed direction', input: { primary_org_id: SECONDARY, secondary_org_id: PRIMARY, preview: false } },
    { label: 'extra unknown keys', input: { primary_org_id: PRIMARY, secondary_org_id: SECONDARY, preview: false, force: true, confirmation: 'Pinnacle Agency' } },
  ];

  for (const { label, input } of executeInputs) {
    it(`refuses (${label}) with the stable code and performs no work`, async () => {
      const response = await merge(input);

      expect(response).toContain(ORGANIZATION_MERGE_UNAVAILABLE_MESSAGE);
      expect(response).toContain(ORGANIZATION_MERGE_UNAVAILABLE_ERROR);
      // The old success copy must be gone — Addie must not claim a merge.
      expect(response).not.toContain('Merge Complete');
      expect(response).not.toContain('has been deleted');
      expect(response).not.toContain('rows moved');
      expectNoExecutionEffects();
      expect(effects.previewMerge).not.toHaveBeenCalled();
      expect(effects.listOrganizationMemberships).not.toHaveBeenCalled();
    });

    it(`does not acquire a WorkOS client (${label})`, async () => {
      // Stricter than "no provider method ran": the contained execution path
      // must not construct or initialize a provider client at all.
      await merge(input);
      expect(effects.getWorkos).not.toHaveBeenCalled();
    });
  }

  it('steers away from manual workarounds instead of leaving the operator to improvise', async () => {
    const response = await merge({ primary_org_id: PRIMARY, secondary_org_id: SECONDARY, preview: false });
    expect(response).toMatch(/preview=true/);
    expect(response).toMatch(/#6827/);
    expect(response).toMatch(/Do not substitute a manual database edit/);
  });

  it('refuses repeated execution attempts identically', async () => {
    const input = { primary_org_id: PRIMARY, secondary_org_id: SECONDARY, preview: false };
    const first = await merge(input);
    const second = await merge(input);
    expect(second).toBe(first);
    expectNoExecutionEffects();
    expect(effects.getWorkos).not.toHaveBeenCalled();
  });
});

describe('Addie merge_organizations — read-only preview is preserved', () => {
  for (const input of [
    { primary_org_id: PRIMARY, secondary_org_id: SECONDARY },
    { primary_org_id: PRIMARY, secondary_org_id: SECONDARY, preview: true },
  ]) {
    it(`still previews for ${JSON.stringify(input)} without executing`, async () => {
      const response = await merge(input);

      expect(effects.previewMerge).toHaveBeenCalledWith(PRIMARY, SECONDARY);
      expect(response).toContain('Merge Preview');
      expect(response).toContain('organization_memberships');
      expectNoExecutionEffects();
    });

    it(`acquires the WorkOS client only in the preview branch for ${JSON.stringify(input)}`, async () => {
      // Positive control for the execution-path assertion above: getWorkos is
      // genuinely observable here, so "not called" during execute is meaningful.
      await merge(input);
      expect(effects.getWorkos).toHaveBeenCalledTimes(1);
      expect(effects.listOrganizationMemberships).toHaveBeenCalled();
    });
  }

  it('no longer instructs the caller to execute with preview=false', async () => {
    const response = await merge({ primary_org_id: PRIMARY, secondary_org_id: SECONDARY });
    expect(response).not.toContain('To execute the merge');
    expect(response).toContain('read-only preview');
    expect(response).toContain(ORGANIZATION_MERGE_UNAVAILABLE_ERROR);
  });

  it('describes provider effects as hypothetical, not scheduled', async () => {
    const response = await merge({ primary_org_id: PRIMARY, secondary_org_id: SECONDARY });
    expect(response).toContain('would be deleted from WorkOS');
    expect(response).not.toContain('will be deleted from WorkOS');
  });

  it('still reports a Stripe customer conflict without resolving it', async () => {
    effects.previewMerge.mockResolvedValue({
      ...previewFixture,
      stripe_customer_conflict: {
        has_conflict: true,
        primary_customer_id: 'cus_primary_double',
        secondary_customer_id: 'cus_secondary_double',
        requires_resolution: true,
      },
    });
    const response = await merge({ primary_org_id: PRIMARY, secondary_org_id: SECONDARY });
    expect(response).toContain('Stripe Customer Conflict');
    expectNoExecutionEffects();
  });
});

describe('Addie merge_organizations — input guards and tool surface', () => {
  for (const input of [
    {},
    { primary_org_id: PRIMARY },
    { secondary_org_id: SECONDARY },
    { primary_org_id: PRIMARY, secondary_org_id: PRIMARY, preview: false },
  ]) {
    it(`rejects malformed input ${JSON.stringify(input)} without any effect`, async () => {
      const response = await merge(input);
      expect(response).toMatch(/^❌/);
      expectNoExecutionEffects();
      expect(effects.previewMerge).not.toHaveBeenCalled();
      expect(effects.getWorkos).not.toHaveBeenCalled();
    });
  }

  it('still declares the tool so the contained handler stays reachable and refusing', async () => {
    // The tool's declared description and usage_hints are intentionally NOT
    // changed by this containment: scripts/addie-tool-surface-budget.json pins a
    // reviewed profile-contract hash over every declared tool profile, and
    // re-blessing it is its own review. The runtime refusal is authoritative; the
    // stale "execute with preview=false" hint is recorded as a follow-up in
    // docs/contributing/organization-deletion-containment.md.
    const tool = ADMIN_TOOLS.find(t => t.name === 'merge_organizations');
    expect(tool).toBeDefined();
    expect(tool!.input_schema.properties).toHaveProperty('preview');
  });
});
