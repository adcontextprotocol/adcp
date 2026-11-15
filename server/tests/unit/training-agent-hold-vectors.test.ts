/**
 * The training agent's experimental 3.3 holds (#8181), graded by the
 * reference grader (tests/helpers/hold-policy-grader.cjs, the grader that
 * replays static/compliance/source/test-vectors/hold-policy/vectors.json).
 *
 * Each case calls the hosted preview (its exact pin) on /sales/mcp, then
 * assembles the vector the grader reads from what the agent actually
 * returned: the drafts as served, the request, the observed request/response
 * window, the response or task error, and (for installment products) the
 * installment deadlines list_products serves. Every vector must be
 * conformant: no violations and nothing indeterminate.
 */

import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearSessions, stopSessionCleanup } from '../../src/training-agent/state.js';
import { clearAccountStore } from '../../src/training-agent/account-handlers.js';
import { TRAINING_AGENT_HOSTED_PREVIEW } from '../../src/training-agent/candidate-version.js';

process.env.PUBLIC_TEST_AGENT_TOKEN = 'hold-vectors-token';
const TOKEN = 'hold-vectors-token';
const PREVIEW = TRAINING_AGENT_HOSTED_PREVIEW.wireVersion;

type Json = Record<string, any>;

interface Grader {
  gradeFinalize(vector: Json): { violations: string[]; indeterminate: string[] };
  gradeReplay(vector: Json): { violations: string[] };
  gradeDraft(vector: Json): { violations: string[] };
  gradeExtend(vector: Json): { violations: string[] };
}

const grader = createRequire(import.meta.url)(
  path.resolve(__dirname, '../../../tests/helpers/hold-policy-grader.cjs'),
) as Grader;

interface Timed {
  structured: Json;
  error?: Json;
  observation: { request_received_at: string; response_at: string };
}

describe('experimental 3.3 holds graded by the reference hold-policy grader', () => {
  let server: http.Server;
  let url: string;
  let rpcId = 1;
  let seller: Json;
  let keyCount = 0;
  const graded: Array<{ kind: string; label: string; result: { violations: string[]; indeterminate?: string[] } }> = [];

  const key = (label: string) => `hold-vectors-${label}-${(keyCount += 1).toString().padStart(4, '0')}`;
  const buyer = (name: string) => ({ brand: { domain: `${name}.example` }, operator: `${name}.example`, sandbox: true });
  const BUYER_A = buyer('hold-buyer-a');
  const BUYER_B = buyer('hold-buyer-b');

  async function call(name: string, args: Json, version = PREVIEW): Promise<Timed> {
    rpcId += 1;
    const request_received_at = new Date().toISOString();
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'tools/call', params: { name, arguments: { adcp_version: version, ...args } } }),
    });
    const raw = await response.json() as Json;
    const response_at = new Date().toISOString();
    const structured = (raw.result?.structuredContent ?? {}) as Json;
    const adcpError = structured.adcp_error as Json | undefined;
    return {
      structured,
      ...(adcpError && {
        error: {
          code: adcpError.code,
          message: adcpError.message,
          ...(adcpError.field && { field: adcpError.field }),
          ...(adcpError.recovery && { recovery: adcpError.recovery }),
        },
      }),
      observation: { request_received_at, response_at },
    };
  }

  /** One draft for `productIds`, as served to `account`, with its products. */
  async function draft(account: Json, productIds: string[], version = PREVIEW): Promise<{ draft: Json; products: Json[] }> {
    const { structured, error } = await call('request_proposals', {
      account,
      brief: 'Sponsorship for the spring launch',
      criteria: { product_ids: productIds },
      idempotency_key: key('draft'),
    }, version);
    expect(error, JSON.stringify(structured).slice(0, 400)).toBeUndefined();
    expect(structured.outcome, JSON.stringify(structured).slice(0, 400)).toBe('proposed');
    return { draft: structured.proposals[0], products: structured.products };
  }

  function finalizeRequest(ids: string[], version = PREVIEW): Json {
    return {
      adcp_version: version,
      idempotency_key: key('finalize'),
      refinements: ids.map(id => ({ proposal_id: id, action: 'finalize' })),
    };
  }

  async function finalize(drafts: Json[], options: { version?: string; installments?: Json[]; label: string }): Promise<Timed & { request: Json }> {
    const version = options.version ?? PREVIEW;
    const request = finalizeRequest(drafts.map(entry => entry.proposal_id), version);
    const { adcp_version: _version, ...args } = request;
    const timed = await call('refine_proposals', args, version);
    const result = grader.gradeFinalize({
      seller,
      source_drafts: drafts,
      request,
      observation: timed.observation,
      ...(timed.error ? { task_error: timed.error } : { response: timed.structured }),
      ...(options.installments && { installments: options.installments }),
    });
    graded.push({ kind: 'finalize', label: options.label, result });
    return { ...timed, request };
  }

  async function extend(sources: Json[], label: string): Promise<Timed> {
    const request = {
      adcp_version: PREVIEW,
      idempotency_key: key('extend'),
      refinements: sources.map(source => ({ proposal_id: source.proposal_id, action: 'extend_hold' })),
    };
    const { adcp_version: _version, ...args } = request;
    const timed = await call('refine_proposals', args);
    graded.push({
      kind: 'extend',
      label,
      result: grader.gradeExtend({
        seller,
        source_proposals: sources,
        request,
        ...(timed.error ? { task_error: timed.error } : { response: timed.structured }),
      }),
    });
    return timed;
  }

  function gradeDraft(label: string, draftProposal: Json, products: Json[]): void {
    graded.push({ kind: 'draft', label, result: grader.gradeDraft({ seller, products, draft: draftProposal }) });
  }

  /** The installment deadlines list_products serves for these products. */
  async function installmentDeadlines(productIds: string[]): Promise<Json[]> {
    const { structured } = await call('list_products', { account: BUYER_A, criteria: { product_ids: productIds } });
    return (structured.products as Json[]).flatMap(product => (product.installments ?? [])
      .filter((installment: Json) => installment.deadlines)
      .map((installment: Json) => ({ product_id: product.product_id, deadlines: installment.deadlines })));
  }

  const committedOf = (timed: Timed, index = 0): Json => timed.structured.results?.[index]?.proposal;

  beforeAll(async () => {
    clearSessions();
    clearAccountStore();
    const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');
    const app = express();
    app.use(express.json({
      limit: '5mb',
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: string }).rawBody = buf.toString('utf8');
      },
    }));
    app.use('/api/training-agent', createTrainingAgentRouter({ disableRateLimit: true }));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    url = `http://127.0.0.1:${address.port}/api/training-agent/sales/mcp`;
    for (const account of [BUYER_A, BUYER_B]) {
      await call('sync_accounts', {
        accounts: [{ ...account, billing: 'operator', payment_terms: 'net_30' }],
        idempotency_key: key('provision'),
      });
    }
    const capabilities = await call('get_adcp_capabilities', {});
    seller = { experimental_features: capabilities.structured.experimental_features };
  }, 60_000);

  afterAll(async () => {
    clearSessions();
    clearAccountStore();
    stopSessionCleanup();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('declares the four hold features, the extend_hold gate, and force_hold_unavailable at the preview', async () => {
    const { structured } = await call('get_adcp_capabilities', {});
    expect(structured.experimental_features).toEqual(expect.arrayContaining([
      'media_buy.hold_policy', 'media_buy.hold_extension', 'media_buy.hold_ranking', 'media_buy.installment_holds',
    ]));
    expect(structured.media_buy.proposal_refinement).toMatchObject({ hold_extension: true });
    expect(structured.compliance_testing.scenarios).toContain('force_hold_unavailable');
  });

  it('places an exclusive hold inside its bounds and refuses a second buyer', async () => {
    const a = await draft(BUYER_A, ['crestline_radio_premium']);
    const b = await draft(BUYER_B, ['crestline_radio_premium']);
    expect(a.draft.hold_policy).toEqual({ available: true, min_duration: 'P1D', max_duration: 'P3D' });
    gradeDraft('exclusive draft', a.draft, a.products);
    const first = await finalize([a.draft], { label: 'exclusive first' });
    const committed = committedOf(first);
    expect(committed.hold_placed_at).toEqual(expect.any(String));
    expect(committed).not.toHaveProperty('hold_rank');
    const second = await finalize([b.draft], { label: 'exclusive contended' });
    expect(second.structured.results[0]).toMatchObject({ outcome: 'unable', reason_code: 'hold_unavailable' });

    // An exact retry replays the original committed proposal: the clock is not restarted.
    const { adcp_version: _version, ...args } = first.request;
    const retry = await call('refine_proposals', args);
    expect(committedOf(retry).hold_placed_at).toBe(committed.hold_placed_at);
    expect(retry.structured.replayed).toBe(true);

    // Negative control: the grader catches a hold kept past max_duration.
    const tampered = structuredClone(first.structured);
    tampered.results[0].proposal.expires_at = new Date(Date.parse(committed.hold_placed_at) + 4 * 24 * 60 * 60 * 1000).toISOString();
    expect(grader.gradeFinalize({
      seller,
      source_drafts: [a.draft],
      request: first.request,
      observation: first.observation,
      response: tampered,
    }).violations).toEqual(['max_duration_exceeded']);

    graded.push({
      kind: 'replay',
      label: 'exclusive replay',
      result: grader.gradeReplay({
        seller,
        source_drafts: [a.draft],
        request: first.request,
        original: { observation: first.observation, response: first.structured },
        replay: { response: retry.structured },
      }),
    });
  });

  it('ranks two buyers on the same slot 1 and 2, and declines acceptance behind first position', async () => {
    const a = await draft(BUYER_A, ['streetlevel_premium']);
    const b = await draft(BUYER_B, ['streetlevel_premium']);
    gradeDraft('ranked draft', b.draft, b.products);
    const first = committedOf(await finalize([a.draft], { label: 'ranked first' }));
    const second = committedOf(await finalize([b.draft], { label: 'ranked second' }));
    expect(first.hold_rank).toBe(1);
    expect(second.hold_rank).toBe(2);

    const behind = await call('accept_proposal', {
      account: BUYER_B,
      proposal_id: second.proposal_id,
      proposal_terms_digest: second.terms_digest,
      idempotency_key: key('accept'),
    });
    expect(behind.error?.code).toBe('PRODUCT_UNAVAILABLE');
    // Only the count ahead is disclosed: nothing about the other buyer.
    expect(JSON.stringify(behind.structured)).not.toContain('hold-buyer-a');
    expect(JSON.stringify(behind.structured)).not.toContain(first.proposal_id);
    expect(JSON.stringify(behind.structured)).not.toContain(first.expires_at);
  });

  it('commits non-holdable and mixed drafts as terms only, and refuses that commitment below 3.3', async () => {
    const solo = await draft(BUYER_A, ['beacon_search_standard']);
    expect(solo.draft.hold_policy).toEqual({ available: false });
    gradeDraft('terms-only draft', solo.draft, solo.products);
    const termsOnly = committedOf(await finalize([solo.draft], { label: 'terms only' }));
    expect(termsOnly).not.toHaveProperty('hold_placed_at');

    const mixed = await draft(BUYER_A, ['beacon_search_standard', 'shopgrid_standard']);
    expect(mixed.draft.hold_policy).toEqual({ available: false });
    gradeDraft('mixed draft', mixed.draft, mixed.products);
    await finalize([mixed.draft], { label: 'mixed terms only' });

    // A draft served at 3.3 with a terms-only policy, finalized by a 3.2 caller.
    const gated = await draft(BUYER_A, ['beacon_search_standard']);
    const refused = await finalize([gated.draft], { label: 'version gate', version: '3.2' });
    expect(refused.error?.code).toBe('UNSUPPORTED_FEATURE');
  });

  it('places a hold with the agent default policy on a product that declares none', async () => {
    const plain = await draft(BUYER_A, ['pinnacle_news_display_premium']);
    expect(plain.draft.hold_policy).toEqual({ available: true });
    gradeDraft('agent default draft', plain.draft, plain.products);
    const committed = committedOf(await finalize([plain.draft], { label: 'agent default' }));
    expect(committed.hold_policy).toEqual({ available: true });
    expect(committed.hold_placed_at).toEqual(expect.any(String));
  });

  it('fails a forced batch all-or-none, consumes the directive, and replays the failure', async () => {
    const forced = await draft(BUYER_A, ['creatorloop_creator_tobias_quill']);
    const sibling = await draft(BUYER_A, ['novamind_premium']);
    const termsOnly = await draft(BUYER_A, ['beacon_search_standard']);
    const directive = await call('comply_test_controller', {
      account: { ...BUYER_A, sandbox: true },
      scenario: 'force_hold_unavailable',
      params: { proposal_id: forced.draft.proposal_id },
    });
    expect(directive.structured, JSON.stringify(directive.structured)).toMatchObject({ success: true, forced: { arm: 'unable', proposal_id: forced.draft.proposal_id } });
    const drafts = [forced.draft, sibling.draft, termsOnly.draft];
    const failed = await finalize(drafts, { label: 'forced batch' });
    expect(failed.structured.results.map((entry: Json) => entry.reason_code)).toEqual(['hold_unavailable', 'batch_aborted', 'batch_aborted']);

    const { adcp_version: _version, ...args } = failed.request;
    const retry = await call('refine_proposals', args);
    graded.push({
      kind: 'replay',
      label: 'forced batch replay',
      result: grader.gradeReplay({
        seller,
        source_drafts: drafts,
        request: failed.request,
        original: { observation: failed.observation, response: failed.structured },
        replay: { response: retry.structured },
      }),
    });

    // The directive was consumed: the same batch now finalizes.
    const committed = await finalize(drafts, { label: 'batch after directive' });
    expect(committed.structured.results.map((entry: Json) => entry.outcome)).toEqual(['finalized', 'finalized', 'finalized']);
    expect(committedOf(committed, 2)).not.toHaveProperty('hold_placed_at');
  });

  it('lists the installments a creator hold covers, capped by their booking deadline', async () => {
    const creator = 'creatorloop_creator_kenji_arden';
    const { draft: source, products } = await draft(BUYER_A, [creator]);
    gradeDraft('creator draft', source, products);
    const installments = await installmentDeadlines([creator]);
    expect(installments.length).toBeGreaterThan(0);
    const committed = committedOf(await finalize([source], { label: 'creator installments', installments }));
    expect(committed.holds.map((entry: Json) => entry.installment_ref.installment_id)).toEqual([
      'kenji_arden_slot_1', 'kenji_arden_slot_2', 'kenji_arden_slot_3',
    ]);
    expect(committed.holds.every((entry: Json) => entry.hold_rank === 1)).toBe(true);

    // Extensions carry the policy, hold_placed_at, and holds forward, and
    // stop at the earliest booking deadline before max_total_duration.
    let current = committed;
    const deadline = Math.min(...installments.map(entry => Date.parse(entry.deadlines.booking_deadline)));
    for (let step = 0; step < 8; step += 1) {
      const extended = await extend([current], `creator extension ${step + 1}`);
      const result = extended.structured.results[0];
      if (result.outcome !== 'finalized') {
        expect(result.reason_code).toBe('hold_unavailable');
        break;
      }
      expect(Date.parse(result.proposal.expires_at)).toBeLessThanOrEqual(deadline);
      current = result.proposal;
    }
    expect(Date.parse(current.expires_at)).toBe(deadline);

    // The extended source is superseded and can no longer be accepted.
    const superseded = await call('accept_proposal', {
      account: BUYER_A,
      proposal_id: committed.proposal_id,
      proposal_terms_digest: committed.terms_digest,
      idempotency_key: key('accept'),
    });
    expect(superseded.error?.code).toBe('INVALID_STATE');
  });

  it('extends up to max_total_duration, declines what it cannot extend, and rejects a source without a hold', async () => {
    const { draft: source } = await draft(BUYER_A, ['trendsettr_premium']);
    let current = committedOf(await finalize([source], { label: 'extendable' }));
    const ceiling = Date.parse(current.hold_placed_at) + 10 * 24 * 60 * 60 * 1000;
    for (let step = 0; step < 6; step += 1) {
      const result = (await extend([current], `extension ${step + 1}`)).structured.results[0];
      if (result.outcome !== 'finalized') break;
      expect(result.proposal.hold_placed_at).toBe(current.hold_placed_at);
      current = result.proposal;
    }
    expect(Date.parse(current.expires_at)).toBe(ceiling);

    // Not extendable: a hold under the agent default policy, in a batch with
    // an extendable creator hold.
    const notExtendable = committedOf(await finalize(
      [(await draft(BUYER_A, ['pinnacle_news_display_premium'])).draft],
      { label: 'default for extension' },
    ));
    const extendable = committedOf(await finalize(
      [(await draft(BUYER_A, ['creatorloop_creator_ravi_castellan'])).draft],
      { label: 'creator for batch extension' },
    ));
    const batch = await extend([extendable, notExtendable], 'batch extension');
    expect(batch.structured.results.map((entry: Json) => entry.reason_code)).toEqual(['batch_aborted', 'hold_unavailable']);

    const { draft: search } = await draft(BUYER_A, ['beacon_search_standard']);
    const termsOnly = committedOf(await finalize([search], { label: 'terms only for extension' }));
    const noHold = await extend([termsOnly], 'extend terms only');
    expect(noHold.error?.code).toBe('INVALID_STATE');
  });

  it('improves a queued hold when the hold ahead is declined, and never worsens it', async () => {
    // The creator brief's four-creator plan: three upcoming slots per creator.
    const creatorDraft = async (account: Json) => {
      const { structured } = await call('request_proposals', {
        account,
        brief: 'Sponsored creator videos for a lifestyle audience skewing 18-44',
        idempotency_key: key('creator-brief'),
      });
      const proposal = (structured.proposals as Json[]).find(candidate => candidate.commercial_terms.purchases
        .every((purchase: Json) => String(purchase.product_id).startsWith('creatorloop_creator_')));
      expect(proposal, JSON.stringify(structured).slice(0, 400)).toBeDefined();
      gradeDraft('creator brief draft', proposal!, structured.products);
      return proposal!;
    };
    const first = committedOf(await finalize([await creatorDraft(BUYER_A)], { label: 'queue first' }));
    const second = committedOf(await finalize([await creatorDraft(BUYER_B)], { label: 'queue second' }));
    expect(first.hold_rank).toBe(1);
    expect(second.hold_rank).toBe(2);
    expect(second.holds).toHaveLength(12);
    expect(second.holds.every((entry: Json) => entry.hold_rank === 2)).toBe(true);
    const declined = await call('decline_proposals', {
      idempotency_key: key('decline'),
      declines: [{ proposal_id: first.proposal_id, reason: 'inventory_fit' }],
    });
    expect(declined.structured.results?.[0]?.outcome, JSON.stringify(declined.structured)).toBe('declined');
    const extended = (await extend([second], 'queue extension')).structured.results[0];
    expect(extended.proposal.hold_rank).toBe(1);
    expect(extended.proposal.holds.every((entry: Json) => entry.hold_rank === 1)).toBe(true);

    const accepted = await call('accept_proposal', {
      account: BUYER_B,
      proposal_id: extended.proposal.proposal_id,
      proposal_terms_digest: extended.proposal.terms_digest,
      io_acceptance: {
        io_id: extended.proposal.insertion_order.io_id,
        accepted_at: new Date().toISOString(),
        signatory: 'Sam Buyer',
      },
      idempotency_key: key('accept'),
    });
    expect(accepted.error, JSON.stringify(accepted.structured).slice(0, 400)).toBeUndefined();
    expect(accepted.structured.media_buy_id).toEqual(expect.any(String));
  });

  it('grades every captured response conformant', () => {
    expect(graded.length).toBeGreaterThanOrEqual(30);
    const failures = graded
      .filter(({ result }) => result.violations.length > 0 || (result.indeterminate ?? []).length > 0)
      .map(({ kind, label, result }) => `${kind} ${label}: ${JSON.stringify(result)}`);
    expect(failures).toEqual([]);
    for (const kind of ['finalize', 'replay', 'draft', 'extend']) {
      expect(graded.some(entry => entry.kind === kind), kind).toBe(true);
    }
  });
});
