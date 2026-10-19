/**
 * Since #8337 the registry reviewer fails safe: an unparseable verdict, an
 * out-of-contract verdict, or a failed model call (an Anthropic outage, or
 * a deployment with no `ANTHROPIC_API_KEY`) leaves the submission alone and
 * posts to the moderator channel. A Slack message is not a queue, so an
 * outage could build a backlog nobody could see (adcp#8338).
 *
 * This file pins the durable half: every outcome that leaves a decision for
 * a human writes a row to `registry_review_queue`, every outcome that
 * finished its own work does not, and the edit rows carry the revision
 * #8337 fixed — revision N restores the state before edit N.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  anthropicCreate: vi.fn(),
  approveBrand: vi.fn(async () => undefined),
  approveProperty: vi.fn(async () => undefined),
  deleteDiscoveredBrand: vi.fn(async () => undefined),
  deleteHostedPropertyByDomain: vi.fn(async () => undefined),
  rollbackBrand: vi.fn(async () => undefined),
  rollbackProperty: vi.fn(async () => undefined),
  createBan: vi.fn(async () => undefined),
  notifyAddieReview: vi.fn(async () => undefined),
  notifyRegistryApproval: vi.fn(async () => undefined),
  notifyRegistryBan: vi.fn(async () => undefined),
  recordRegistryReviewOutcome: vi.fn(async () => undefined),
}));

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = { create: mocks.anthropicCreate };
  }
  return { default: FakeAnthropic };
});

vi.mock('../../src/db/brand-db.js', () => ({
  BrandDatabase: class {
    approveBrand = mocks.approveBrand;
    deleteDiscoveredBrand = mocks.deleteDiscoveredBrand;
    rollbackBrand = mocks.rollbackBrand;
  },
  sanitizeBrandSnapshot: <T,>(snapshot: T) => snapshot,
}));

vi.mock('../../src/db/property-db.js', () => ({
  PropertyDatabase: class {
    approveProperty = mocks.approveProperty;
    deleteHostedPropertyByDomain = mocks.deleteHostedPropertyByDomain;
    rollbackProperty = mocks.rollbackProperty;
  },
}));

vi.mock('../../src/db/bans-db.js', () => ({
  BansDatabase: class {
    createBan = mocks.createBan;
  },
}));

vi.mock('../../src/notifications/registry.js', () => ({
  notifyAddieReview: mocks.notifyAddieReview,
  notifyRegistryApproval: mocks.notifyRegistryApproval,
  notifyRegistryBan: mocks.notifyRegistryBan,
}));

vi.mock('../../src/db/registry-review-queue-db.js', () => ({
  recordRegistryReviewOutcome: mocks.recordRegistryReviewOutcome,
}));

import { reviewNewRecord, reviewRegistryEdit } from '../../src/addie/mcp/registry-review.js';

function verdictResponse(verdict: string, reason = 'because') {
  return { content: [{ type: 'text', text: JSON.stringify({ verdict, reason }) }] };
}

function newBrandRecord(overrides: Record<string, unknown> = {}) {
  return {
    entity_type: 'brand' as const,
    domain: 'acme.example',
    editor_user_id: 'user_mallory',
    editor_email: 'mallory@example.com',
    snapshot: { brand_name: 'Acme Corp' },
    slack_thread_ts: '1.0',
    ...overrides,
  };
}

function brandEdit(overrides: Record<string, unknown> = {}) {
  return {
    entity_type: 'brand' as const,
    domain: 'acme.example',
    editor_user_id: 'user_mallory',
    editor_email: 'mallory@example.com',
    edit_summary: 'tidy up the description',
    old_snapshot: { brand_name: 'Acme Corp' },
    new_snapshot: { brand_name: 'Acme Corporation' },
    revision_number: 7,
    slack_thread_ts: '1.0',
    ...overrides,
  };
}

/** The single enqueue argument, or undefined when nothing was queued. */
function queued(): Record<string, unknown> | undefined {
  const call = mocks.recordRegistryReviewOutcome.mock.calls.at(-1);
  return call?.[0] as Record<string, unknown> | undefined;
}

describe('registry review → moderator queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  describe('new records', () => {
    it('queues a record the reviewer could not decide, with the verdict that left it pending', async () => {
      // Unparseable output is the #8337 fail-safe path: nothing is approved.
      mocks.anthropicCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'not json at all' }] });

      const result = await reviewNewRecord(newBrandRecord());

      expect(result.verdict).toBe('needs_human_review');
      expect(mocks.approveBrand).not.toHaveBeenCalled();
      expect(mocks.recordRegistryReviewOutcome).toHaveBeenCalledTimes(1);
      expect(queued()).toMatchObject({
        entity_type: 'brand',
        domain: 'acme.example',
        submission_kind: 'new_record',
        submitter_user_id: 'user_mallory',
        submitter_email: 'mallory@example.com',
        verdict: 'needs_human_review',
        action_taken: 'Left pending for human review',
      });
    });

    it('queues a record when an unconfigured model call fails safe', async () => {
      delete process.env.ANTHROPIC_API_KEY;

      const result = await reviewNewRecord(newBrandRecord({ domain: 'outage.example' }));

      expect(result.verdict).toBe('needs_human_review');
      expect(mocks.recordRegistryReviewOutcome).toHaveBeenCalledTimes(1);
      expect(queued()).toMatchObject({ domain: 'outage.example', submission_kind: 'new_record' });
    });

    it('does not queue an approved record', async () => {
      mocks.anthropicCreate.mockResolvedValueOnce(verdictResponse('ok'));

      await reviewNewRecord(newBrandRecord());

      expect(mocks.approveBrand).toHaveBeenCalled();
      expect(mocks.recordRegistryReviewOutcome).not.toHaveBeenCalled();
    });

    it('does not queue a malicious record the cleanup actually removed', async () => {
      mocks.anthropicCreate.mockResolvedValueOnce(verdictResponse('malicious', 'spam'));

      await reviewNewRecord(newBrandRecord());

      expect(mocks.deleteDiscoveredBrand).toHaveBeenCalled();
      expect(mocks.recordRegistryReviewOutcome).not.toHaveBeenCalled();
    });

    it('queues a malicious record whose removal failed, because it is still pending', async () => {
      mocks.anthropicCreate.mockResolvedValueOnce(verdictResponse('malicious', 'spam'));
      mocks.deleteDiscoveredBrand.mockRejectedValueOnce(new Error('deadlock detected'));

      await reviewNewRecord(newBrandRecord());

      expect(mocks.recordRegistryReviewOutcome).toHaveBeenCalledTimes(1);
      expect(queued()).toMatchObject({ verdict: 'malicious', submission_kind: 'new_record' });
      expect(String(queued()?.action_taken)).toContain('FAILED');
    });
  });

  describe('edits', () => {
    it('queues the edit against the revision that restores the pre-edit state', async () => {
      mocks.anthropicCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: '{"verdict":"wat"}' }] });

      const result = await reviewRegistryEdit(brandEdit({ revision_number: 7 }));

      expect(result.verdict).toBe('needs_human_review');
      expect(mocks.rollbackBrand).not.toHaveBeenCalled();
      // Revision N holds the state before edit N (adcp#8337). Queuing N-1
      // would make a moderator's revert discard the previous member's edit.
      expect(queued()).toMatchObject({
        submission_kind: 'edit',
        revision_number: 7,
        edit_summary: 'tidy up the description',
        verdict: 'needs_human_review',
      });
    });

    it('does not queue an edit the auto-revert already undid', async () => {
      mocks.anthropicCreate.mockResolvedValueOnce(verdictResponse('malicious', 'vandalism'));

      await reviewRegistryEdit(brandEdit());

      expect(mocks.rollbackBrand).toHaveBeenCalledWith('acme.example', 7, expect.anything());
      expect(mocks.recordRegistryReviewOutcome).not.toHaveBeenCalled();
    });

    it('queues an edit whose auto-revert failed, so a moderator can retry the same revision', async () => {
      mocks.anthropicCreate.mockResolvedValueOnce(verdictResponse('malicious', 'vandalism'));
      mocks.rollbackBrand.mockRejectedValueOnce(new Error('deadlock detected'));

      await reviewRegistryEdit(brandEdit({ revision_number: 3 }));

      expect(queued()).toMatchObject({
        submission_kind: 'edit',
        revision_number: 3,
        verdict: 'malicious',
      });
    });

    it('does not queue an approved edit', async () => {
      mocks.anthropicCreate.mockResolvedValueOnce(verdictResponse('ok'));

      await reviewRegistryEdit(brandEdit());

      expect(mocks.recordRegistryReviewOutcome).not.toHaveBeenCalled();
    });

    it('still posts to the moderator channel when the queue write fails', async () => {
      mocks.anthropicCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'nope' }] });
      mocks.recordRegistryReviewOutcome.mockRejectedValueOnce(new Error('relation does not exist'));

      const result = await reviewRegistryEdit(brandEdit());

      expect(result.verdict).toBe('needs_human_review');
      expect(mocks.notifyAddieReview).toHaveBeenCalledTimes(1);
    });
  });
});
