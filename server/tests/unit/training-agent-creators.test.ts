import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CanonicalProposal } from '@adcp/sdk';
import { CREATOR_PUBLISHER } from '../../src/training-agent/creators.js';
import { PUBLISHERS } from '../../src/training-agent/publishers.js';
import { buildCatalog, buildProposals } from '../../src/training-agent/product-factory.js';
import { validateSourceSchema } from '../../src/training-agent/source-schema.js';
import { executeTrainingAgentTool, invalidateCache } from '../../src/training-agent/task-handlers.js';
import { clearSessions } from '../../src/training-agent/state.js';
import { clearIdempotencyCache } from '../../src/training-agent/idempotency.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

type Row = Record<string, any>;

const creatorProducts = (): Row[] => buildCatalog()
  .filter(entry => entry.publisherId === 'creatorloop')
  .map(entry => entry.product as unknown as Row);

function expectValid(path: string, value: unknown, label: string) {
  const result = validateSourceSchema(path, value);
  expect(result.valid, `${label}: ${JSON.stringify(result.errors ?? result)}`).toBe(true);
}

describe('CreatorLoop creator marketplace fixtures', () => {
  it('registers ten channel collections with creator talent, distribution, and genre', () => {
    expect(PUBLISHERS).toContain(CREATOR_PUBLISHER);
    const shows = CREATOR_PUBLISHER.shows!;
    expect(shows).toHaveLength(10);
    expect(new Set(shows.map(show => show.showId)).size).toBe(10);
    for (const show of shows) {
      expect(show.kind).toBe('channel');
      expect(show.talent).toEqual([{ name: expect.any(String), role: 'creator' }]);
      expect(show.genre.length).toBeGreaterThan(0);
      expect(show.distribution).toHaveLength(1);
      expect(show.distribution![0].identifiers).toHaveLength(1);
      expect(['youtube_channel_id', 'tiktok_id']).toContain(show.distribution![0].identifiers[0].type);
      // Collection objects (as they would appear in adagents.json) are schema-valid.
      expectValid('core/collection.json', {
        collection_id: show.showId,
        name: show.name,
        kind: show.kind,
        description: show.description,
        genre: show.genre,
        language: show.language,
        cadence: show.cadence,
        status: show.status,
        talent: show.talent,
        distribution: show.distribution!.map(d => ({
          publisher_domain: d.publisherDomain,
          identifiers: d.identifiers,
        })),
      }, show.showId);
    }
  });

  it('sells one guaranteed flat-rate product per creator', () => {
    const products = creatorProducts();
    expect(products).toHaveLength(10);
    for (const product of products) {
      expect(product.delivery_type).toBe('guaranteed');
      expect(product.pricing_options).toHaveLength(1);
      expect(product.pricing_options[0]).toMatchObject({ pricing_model: 'flat_rate', currency: 'USD' });
      expect(product.pricing_options[0].fixed_price).toBeGreaterThan(0);
      expect(product.collections).toHaveLength(1);
      expect(product.collections[0].collection_ids).toHaveLength(1);
      expectValid('core/product.json', product, product.product_id);
    }
  });

  it('declares upcoming installments with talking_points -> script -> draft deadlines', () => {
    for (const product of creatorProducts()) {
      expect(product.installments.length).toBeGreaterThanOrEqual(3);
      for (const installment of product.installments) {
        expectValid('core/installment.json', installment, installment.installment_id);
        const scheduledAt = Date.parse(installment.scheduled_at);
        expect(scheduledAt).toBeGreaterThan(Date.now());
        const { deadlines } = installment;
        const stages = deadlines.material_deadlines.map((m: Row) => m.stage);
        expect(stages).toEqual(['talking_points', 'script', 'draft']);
        for (const m of deadlines.material_deadlines) expect(m.label).toEqual(expect.any(String));
        const due = deadlines.material_deadlines.map((m: Row) => Date.parse(m.due_at));
        expect([...due].sort((a, b) => a - b)).toEqual(due);
        expect(due.at(-1)).toBeLessThan(scheduledAt);
        expect(Date.parse(deadlines.booking_deadline)).toBeLessThan(due[0]);
      }
    }
  });

  it('carries a hero image and video sample reference assets on the detailed card', () => {
    for (const product of creatorProducts()) {
      const card = product.product_card_detailed;
      expect(card.hero_image.asset_type).toBe('image');
      expect(card.reference_assets.length).toBeGreaterThanOrEqual(2);
      for (const asset of card.reference_assets) {
        expect(asset).toMatchObject({ role: 'other', role_label: 'Sample content' });
        expect(asset.asset.asset_type).toBe('video');
      }
    }
  });

  it('declares seller-declared age composition and HTTPS-scoped gender evidence', () => {
    for (const product of creatorProducts()) {
      const evidence: Row[] = product.audience_evidence;
      expect(new Set(evidence.map(e => e.snapshot_id)).size).toBe(evidence.length);
      const age = evidence.filter(e => e.audience.dimension === 'age');
      const other = evidence.filter(e => e.audience.dimension !== 'age');
      expect(age.length).toBeGreaterThanOrEqual(2);
      expect(other).toHaveLength(1);
      expect(other[0].audience.dimension).toMatch(/^https:\/\//);
      let ageShare = 0;
      for (const e of evidence) {
        expectValid('core/audience-evidence.json', e, e.evidence_id);
        expect(e).toMatchObject({
          relationship: 'composition',
          unit: 'fraction',
          evidence_type: 'seller_declared',
          provider: { domain: 'creatorloop.example' },
        });
        expect(e.baseline.system).toMatch(/^https:\/\//);
        const { content_digest: digest, attestation_refs: _refs, ...core } = e;
        expect(digest).toBe(`sha256:${createHash('sha256').update(canonicalize(core)!).digest('hex')}`);
        if (e.audience.dimension === 'age') {
          expect(e.audience.range.min).toBeLessThanOrEqual(e.audience.range.max);
          ageShare += e.value;
        }
      }
      expect(ageShare).toBeLessThanOrEqual(1);
    }
  });

  it('answers a creator brief with a four-creator proposal over the creator products', () => {
    const catalog = buildCatalog();
    const proposal = buildProposals(catalog).find(p => p.proposal_id === 'creatorloop_everyday_lifestyle')!;
    expect(proposal.allocations).toHaveLength(4);
    expect(proposal.allocations.reduce((sum, a) => sum + (a as Row).allocation_percentage, 0)).toBe(100);
    const creatorIds = new Set(creatorProducts().map(p => p.product_id));
    for (const allocation of proposal.allocations) expect(creatorIds).toContain(allocation.product_id);
  });
});

describe('CreatorLoop proposal round trip', () => {
  beforeEach(() => {
    clearSessions();
    invalidateCache();
    clearIdempotencyCache();
  });

  const context: TrainingContext = {
    mode: 'open',
    tenantId: 'sales',
    principal: 'creator-proposal-round-trip',
    authenticatedAgentUrl: 'https://buyer.example',
    proposalNegotiationProfile: 'typed-negotiation',
  };
  const brand = { domain: 'buyer.example' };
  const account = { brand, operator: 'buyer.example' };

  it('drops a creator, finalizes, and accepts', async () => {
    const requested = await executeTrainingAgentTool('request_proposals', {
      idempotency_key: 'creator-request-proposals-0001',
      brand,
      brief: 'Sponsored creator videos on YouTube and TikTok for a lifestyle audience of adults 18-44',
    }, context);
    expect(requested.success, requested.error).toBe(true);
    const proposals = requested.data?.proposals as CanonicalProposal[];
    const source = proposals.find(p => p.commercial_terms.purchases.some(
      purchase => purchase.product_id.startsWith('creatorloop_creator_'),
    ))!;
    expect(source, 'creator proposal returned for the creator brief').toBeDefined();
    const productIds = source.commercial_terms.purchases.map(p => p.product_id);
    expect(productIds).toHaveLength(4);
    expect(productIds.every(id => id.startsWith('creatorloop_creator_'))).toBe(true);
    for (const purchase of source.commercial_terms.purchases) {
      expect(purchase.pricing).toMatchObject({ pricing_model: 'flat_rate', currency: 'USD' });
    }

    const dropped = productIds[3]!;
    const revised = await executeTrainingAgentTool('refine_proposals', {
      idempotency_key: 'creator-drop-creator-0001',
      refinements: [{
        proposal_id: source.proposal_id,
        action: 'revise',
        product_changes: { [dropped]: 'omit' },
      }],
    }, context);
    expect(revised.success, revised.error).toBe(true);
    const revision = (revised.data?.results as Array<{ outcome: string; proposals: CanonicalProposal[] }>)[0]!;
    expect(revision.outcome).toBe('revised');
    const draft = revision.proposals[0]!;
    expect(draft.commercial_terms.purchases.map(p => p.product_id)).toEqual(productIds.slice(0, 3));

    const finalized = await executeTrainingAgentTool('refine_proposals', {
      idempotency_key: 'creator-finalize-0001',
      refinements: [{ proposal_id: draft.proposal_id, action: 'finalize' }],
    }, context);
    expect(finalized.success, finalized.error).toBe(true);
    const committed = (finalized.data?.results as Array<{ proposal: CanonicalProposal }>)[0]!.proposal;
    expect(committed).toMatchObject({ proposal_status: 'committed', parent_proposal_id: draft.proposal_id });

    const accepted = await executeTrainingAgentTool('create_media_buy', {
      idempotency_key: 'creator-accept-0001',
      account,
      brand,
      proposal_id: committed.proposal_id,
      total_budget: committed.commercial_terms.total_budget,
      start_time: committed.commercial_terms.start_time,
      end_time: committed.commercial_terms.end_time,
    }, context);
    expect(accepted.success, accepted.error).toBe(true);
    expect(accepted.data).toMatchObject({
      proposal_id: committed.proposal_id,
      media_buy_id: expect.any(String),
    });
  });
});
