/**
 * #8181 / #8093: the experimental 3.3 collection surfaces on the training
 * agent, exercised over MCP at the hosted 3.3 preview pin and graded with the
 * reference grader for collection copies
 * (tests/helpers/collection-copies-grader.cjs, the same module that replays
 * static/compliance/source/test-vectors/collection-copies/).
 *
 * - media_buy.collection_cards: include_collections on get_products,
 *   list_products, request_proposals and refine_proposals; feed versions
 *   scoped by the flag; card fields and follower counts.
 * - media_buy.collection_catalog: list_collections, the card webhooks
 *   (delivered to a local receiver), the seed_collection controller scenario
 *   that drives them, and the consistency rule.
 * - brand.collection_links: get_brand_identity collections on /brand.
 *
 * Stable callers never see any of it; tenants/served-release-shape.test.ts
 * proves that for the full read flow.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import { createRequire } from 'node:module';

process.env.PUBLIC_TEST_AGENT_TOKEN = 'collections-test-public-token';

import { TRAINING_AGENT_HOSTED_PREVIEW } from '../../src/training-agent/candidate-version.js';
import { stopSessionCleanup } from '../../src/training-agent/state.js';
import { clearCollectionCardState } from '../../src/training-agent/collections/card-catalog.js';
import { bulkThreshold } from '../../src/training-agent/collections/seed-collection.js';
import { monotonicUuidV7 } from '../../src/training-agent/collections/card-webhooks.js';

const grader = createRequire(import.meta.url)('../../../tests/helpers/collection-copies-grader.cjs') as {
  CATALOG_FEATURE: string;
  CARDS_FEATURE: string;
  validate: Record<string, ((value: unknown) => boolean) & { errors?: unknown }>;
  canonical: (value: unknown) => string;
  mergedView: (vector: Record<string, unknown>) => Array<Record<string, unknown>>;
  gradeResponse: (vector: Record<string, unknown>) => string[];
  gradeWebhook: (vector: Record<string, unknown>) => string[];
  applyEvents: (vector: Record<string, unknown>) => { verdict: string; repair_token: string | null; mirror: { cards: unknown[]; version: string } };
};

const PREVIEW = TRAINING_AGENT_HOSTED_PREVIEW.wireVersion;
/** A caller-unique demo credential: card changes are kept per principal. */
const TOKEN = 'demo-collection-cards-v1';
const STABLE_PINS: Array<Record<string, unknown>> = [
  {}, { adcp_major_version: 3 }, { adcp_version: '3.2' }, { adcp_version: '3.1' }, { adcp_version: '3.0' }, { adcp_version: '3.3' },
];
const CARD_EVENTS = ['collection_card.updated', 'collection_card.removed', 'collection_catalog.bulk_change'];
const CREATORS = 'creatorloop.example';

type Structured = Record<string, any>;
type Card = Record<string, any> & { publisher_domain: string; collection_id: string };

const keyOf = (card: { publisher_domain: string; collection_id: string }) => `${card.publisher_domain}/${card.collection_id}`;

function referencedKeys(products: Array<Record<string, any>>): Set<string> {
  const keys = new Set<string>();
  for (const product of products) {
    for (const selector of product.collections ?? []) {
      for (const id of selector.collection_ids ?? []) keys.add(`${selector.publisher_domain}/${id}`);
    }
  }
  return keys;
}

describe('experimental 3.3 collections on the training agent', () => {
  let server: http.Server;
  let receiver: http.Server;
  let baseUrl: string;
  let hookUrl: string;
  let rpcId = 0;
  const received: Array<{ headers: http.IncomingHttpHeaders; body: Record<string, any> }> = [];

  const rpc = async (path: string, method: string, params?: Record<string, unknown>, token = TOKEN) => {
    rpcId += 1;
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, ...(params && { params }) }),
    });
    return response.json() as Promise<Record<string, any>>;
  };
  const call = async (path: string, name: string, args: Record<string, unknown>, token = TOKEN): Promise<Structured> => {
    const envelope = await rpc(path, 'tools/call', { name, arguments: args }, token);
    return (envelope.result?.structuredContent ?? { __envelope: envelope }) as Structured;
  };
  const preview = (name: string, args: Record<string, unknown> = {}, path = '/sales/mcp') => call(path, name, { adcp_version: PREVIEW, ...args });
  const listAll = async (): Promise<{ cards: Card[]; version: string; cacheScope: string }> => {
    const cards: Card[] = [];
    let cursor: string | undefined;
    let version = '';
    let cacheScope = '';
    do {
      const page = await preview('list_collections', { pagination: { max_results: 7, ...(cursor && { cursor }) } });
      expect(page.outcome, JSON.stringify(page).slice(0, 300)).toBe('listed');
      if (version) expect(page.collections_version).toBe(version);
      version = page.collections_version;
      cacheScope = page.cache_scope;
      cards.push(...page.collections);
      cursor = page.pagination?.has_more ? page.pagination.cursor : undefined;
    } while (cursor);
    return { cards, version, cacheScope };
  };
  const seed = (params: Record<string, unknown>) => preview('comply_test_controller', {
    scenario: 'seed_collection',
    account: { brand: { domain: 'collections-buyer.example' }, operator: 'collections-buyer.example', sandbox: true },
    params,
  });
  /** The grader's seller declaration for this agent. */
  const SELLER = { experimental_features: [] as string[], wholesale_feed_webhook_event_types: [] as string[] };

  beforeAll(async () => {
    clearCollectionCardState();
    receiver = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk as Buffer));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, any>;
        if (body.type === 'webhook.challenge') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ challenge: body.challenge }));
          return;
        }
        received.push({ headers: req.headers, body });
        res.writeHead(204);
        res.end();
      });
    });
    await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
    const hookAddress = receiver.address();
    if (!hookAddress || typeof hookAddress === 'string') throw new Error('Missing receiver address');
    hookUrl = `http://127.0.0.1:${hookAddress.port}/hooks/collection-cards`;

    const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');
    const app = express();
    app.use(express.json({ limit: '5mb', verify: (req, _res, body) => {
      (req as unknown as { rawBody: string }).rawBody = body.toString('utf8');
    } }));
    app.use('/api/training-agent', createTrainingAgentRouter({ disableRateLimit: true }));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    baseUrl = `http://127.0.0.1:${address.port}/api/training-agent`;
  }, 60_000);

  afterAll(async () => {
    clearCollectionCardState();
    stopSessionCleanup();
    for (const s of [server, receiver]) {
      if (!s) continue;
      s.closeAllConnections();
      await new Promise<void>(resolve => s.close(() => resolve()));
    }
  });

  it('declares the collection features and card events at the preview pin only', async () => {
    const sales = await preview('get_adcp_capabilities');
    expect(sales.adcp_version).toBe(PREVIEW);
    expect(sales.experimental_features).toEqual(expect.arrayContaining([grader.CARDS_FEATURE, grader.CATALOG_FEATURE]));
    expect(sales.wholesale_feed_webhooks.event_types).toEqual(expect.arrayContaining(CARD_EVENTS));
    expect(sales.media_buy.lifecycle_tools ?? []).not.toContain('list_collections');
    SELLER.experimental_features = sales.experimental_features;
    SELLER.wholesale_feed_webhook_event_types = sales.wholesale_feed_webhooks.event_types;
    const brand = await preview('get_adcp_capabilities', {}, '/brand/mcp');
    expect(brand.experimental_features).toContain('brand.collection_links');

    for (const pin of STABLE_PINS) {
      const stable = await call('/sales/mcp', 'get_adcp_capabilities', pin);
      expect(stable.adcp_version, JSON.stringify(pin)).not.toBe(PREVIEW);
      expect(stable.experimental_features ?? []).not.toContain(grader.CARDS_FEATURE);
      expect(stable.experimental_features ?? []).not.toContain(grader.CATALOG_FEATURE);
      for (const type of CARD_EVENTS) expect(stable.wholesale_feed_webhooks?.event_types ?? []).not.toContain(type);
      const stableBrand = await call('/brand/mcp', 'get_adcp_capabilities', pin);
      expect(stableBrand.experimental_features ?? []).not.toContain('brand.collection_links');
    }
  }, 60_000);

  it('lists list_collections and seed_collection only at the preview pin', async () => {
    const pinned = await rpc('/sales/mcp', 'tools/list', { _meta: { adcp_version: PREVIEW } });
    expect(pinned.result.tools.map((tool: { name: string }) => tool.name)).toContain('list_collections');
    for (const params of [{}, { _meta: { adcp_version: '3.2' } }, { _meta: { adcp_version: '3.3' } }]) {
      const stable = await rpc('/sales/mcp', 'tools/list', params);
      expect(stable.result.tools.map((tool: { name: string }) => tool.name)).not.toContain('list_collections');
    }
    for (const adcp_version of ['3.2', '3.3']) {
      const refused = await rpc('/sales/mcp', 'tools/call', { name: 'list_collections', arguments: { adcp_version } });
      expect(refused.result?.isError, JSON.stringify(refused).slice(0, 300)).toBe(true);
    }
    const scenarios = await preview('comply_test_controller', { scenario: 'list_scenarios' });
    expect(scenarios.scenarios).toContain('seed_collection');
    const stableScenarios = await call('/sales/mcp', 'comply_test_controller', { adcp_version: '3.2', scenario: 'list_scenarios' });
    expect(stableScenarios.scenarios).not.toContain('seed_collection');
  }, 60_000);

  it('serves creator collection cards with images, samples, links, talent brand_refs and follower counts', async () => {
    const { cards, version, cacheScope } = await listAll();
    expect(cacheScope).toBe('public');
    expect(version).toMatch(/^cc_/);
    const creators = cards.filter(card => card.publisher_domain === CREATORS);
    expect(creators).toHaveLength(10);
    for (const card of cards) expect(grader.validate.copy(card), `${keyOf(card)} ${JSON.stringify(grader.validate.copy.errors)}`).toBe(true);
    for (const card of creators) {
      expect(card.kind).toBe('channel');
      expect(card.url).toMatch(/^https:\/\/creatorloop\.example\/creators\//);
      expect(card.images.length).toBeGreaterThan(0);
      expect(card.sample_content.every((post: Record<string, unknown>) => post.asset_type === 'published_post')).toBe(true);
      expect(card.talent[0].role).toBe('creator');
      for (const entry of card.distribution) {
        expect(entry.followers, keyOf(card)).toMatchObject({ precision: 'approximate' });
        expect(entry.followers.upper_bound).toBeGreaterThanOrEqual(entry.followers.lower_bound);
        expect(typeof entry.followers.as_of).toBe('string');
      }
    }
    // Ten creators; nine name their brand identity, one does not.
    expect(creators.filter(card => card.talent[0].brand_ref).length).toBe(9);
    // Two creators cross-post, so a card can carry more than one count.
    expect(creators.filter(card => card.distribution.length > 1).length).toBe(2);
  }, 60_000);

  it('answers include_collections on list_products, request_proposals and refine_proposals with the referenced cards only, and never on get_products (adcp#8501)', async () => {
    const catalog = new Map((await listAll()).cards.map(card => [keyOf(card), card]));
    const checkCards = (label: string, result: Structured) => {
      expect(result.adcp_error, `${label}: ${JSON.stringify(result).slice(0, 400)}`).toBeUndefined();
      expect(Array.isArray(result.products), label).toBe(true);
      const referenced = referencedKeys(result.products);
      expect(referenced.size, label).toBeGreaterThan(0);
      const keys = (result.collections as Card[]).map(keyOf);
      // Deduplicated, referenced only, and complete.
      expect(new Set(keys).size, label).toBe(keys.length);
      for (const key of keys) expect(referenced.has(key), `${label}: stray ${key}`).toBe(true);
      expect(new Set(keys), label).toEqual(referenced);
      // The same copy list_collections serves for the key.
      for (const card of result.collections as Card[]) {
        expect(grader.canonical(card), `${label}: ${keyOf(card)}`).toBe(grader.canonical(catalog.get(keyOf(card))));
      }
      return result.collections as Card[];
    };

    const brief = 'Creator sponsored video integrations for an everyday lifestyle audience';
    // get_products no longer returns collections, even when asked, but keeps the sample_content projection.
    const gp = await preview('get_products', { buying_mode: 'brief', brief, include_collections: true });
    expect(gp.adcp_error, JSON.stringify(gp).slice(0, 400)).toBeUndefined();
    expect(gp.collections).toBeUndefined();
    const creatorProduct = (gp.products as Array<Record<string, any>>).find(product => (product.collections ?? [])
      .some((selector: { publisher_domain: string }) => selector.publisher_domain === CREATORS));
    expect(creatorProduct).toBeDefined();
    // Creator product cards carry their samples with the sample_content role.
    const samples = creatorProduct!.product_card_detailed.reference_assets
      .filter((asset: { role: string }) => asset.role === 'sample_content');
    expect(samples.length).toBeGreaterThan(0);
    expect(samples[0].asset).toMatchObject({ asset_type: 'url' });
    const card = catalog.get(`${CREATORS}/${creatorProduct!.collections[0].collection_ids[0]}`);
    expect(card!.sample_content.map((post: { post_url: string }) => post.post_url)).toContain(samples[0].asset.url);

    const lp = await preview('list_products', { include_collections: true });
    checkCards('list_products', lp);

    const rp = await preview('request_proposals', {
      brand: { domain: 'collections-buyer.example' },
      brief,
      include_collections: true,
      idempotency_key: 'collections-request-proposals-0001',
    });
    expect(rp.outcome, JSON.stringify(rp).slice(0, 400)).toBe('proposed');
    checkCards('request_proposals', rp);

    const proposalId = rp.proposals[0].proposal_id;
    const refined = await preview('refine_proposals', {
      refinements: [{ proposal_id: proposalId, action: 'revise', ask: 'Drop the most expensive creator.' }],
      include_collections: true,
      idempotency_key: 'collections-refine-proposals-0001',
    });
    checkCards('refine_proposals', refined);

    // Without the flag, no cards.
    for (const [name, args] of [
      ['get_products', { buying_mode: 'brief', brief }],
      ['list_products', {}],
      ['list_products', { include_collections: false }],
    ] as const) {
      const plain = await preview(name, args);
      expect(plain.collections, name).toBeUndefined();
    }

    // A fields projection without product collections omits the array too.
    const projected = await preview('list_products', { include_collections: true, fields: ['name'] });
    expect(projected.outcome).toBe('listed');
    expect(projected.collections).toBeUndefined();
  }, 120_000);

  it('grades include_collections copies against the agent adagents.json: every referenced card is verified', async () => {
    const adagents = await (await fetch(`${baseUrl}/.well-known/adagents.json`)).json() as Record<string, any>;
    const declarations: Record<string, unknown[]> = {};
    for (const declared of adagents.collections as Card[]) {
      const { publisher_domain: domain, ...rest } = declared;
      expect(grader.validate.collection(declared), JSON.stringify(grader.validate.collection.errors)).toBe(true);
      (declarations[domain] ??= []).push(rest);
    }
    const sellerAuthorized = (adagents.authorized_agents as Array<Record<string, any>>)
      .filter(entry => String(entry.url).endsWith('/sales/mcp') && Array.isArray(entry.collections))
      .flatMap(entry => entry.collections);
    expect(sellerAuthorized.length).toBeGreaterThan(0);

    const gp = await preview('list_products', { include_collections: true });
    const keys = [...referencedKeys(gp.products)].map(key => {
      const [publisher_domain, collection_id] = key.split('/');
      return { publisher_domain, collection_id };
    });
    const merged = grader.mergedView({ keys, declarations, seller_authorized: sellerAuthorized, copies: gp.collections });
    for (const entry of merged) {
      expect(entry.status, `${keyOf(entry as Card)}`).toBe('verified');
      expect(entry.carriage_eligible).toBe(true);
      // The copy wins on its closed list: the card's follower counts and
      // images reach the merged view; anchored facts are the declaration's.
      const copy = (gp.collections as Card[]).find(candidate => keyOf(candidate) === keyOf(entry as Card))!;
      const effective = entry.effective as Card;
      expect(effective.images).toEqual(copy.images);
      expect(effective.talent).toEqual(copy.talent);
      expect(effective.distribution).toEqual(copy.distribution);
    }
  }, 60_000);

  it('serves list_collections by key and with filters, graded conformant by the reference grader', async () => {
    const { cards } = await listAll();
    const catalog = cards.map(card => ({ card, visible_to: 'public' }));
    const grade = async (request: Record<string, unknown>, token?: Record<string, unknown>) => {
      const response = await preview('list_collections', request);
      const { adcp_version: _served, ...wire } = response;
      const violations = grader.gradeResponse({
        seller: SELLER,
        seller_catalog: catalog,
        request: { adcp_version: PREVIEW, ...request },
        response: wire,
        ...(token && { token_issued_for: token }),
      });
      expect(violations, `${JSON.stringify(request)} → ${JSON.stringify(response).slice(0, 400)}`).toEqual([]);
      return response;
    };

    const byKey = await grade({
      collections: [
        { publisher_domain: CREATORS, collection_ids: ['creatorloop_channel_juniper_vale', 'creatorloop_channel_unknown'] },
        { publisher_domain: 'unknown-publisher.example', collection_ids: ['nothing'] },
      ],
    });
    // Unknown keys are omitted silently, with no per-key error.
    expect(byKey.collections.map(keyOf)).toEqual([`${CREATORS}/creatorloop_channel_juniper_vale`]);

    const whole = await grade({ collections: [{ publisher_domain: CREATORS }] });
    expect(whole.collections).toHaveLength(10);

    expect((await grade({ filters: { kinds: ['channel'] } })).collections).toHaveLength(10);
    // RFC 4647 basic filtering: "en" matches "en" and "en-US"; "en-GB" does not match "en".
    expect((await grade({ filters: { languages: ['en'] } })).collections.length).toBeGreaterThanOrEqual(10);
    expect((await grade({ filters: { languages: ['en-GB'] } })).collections).toHaveLength(0);
    expect((await grade({ filters: { statuses: ['active'] } })).collections.length).toBeGreaterThan(0);
    expect((await grade({ filters: { genres_include: ['fitness'] } })).collections.map(keyOf))
      .toEqual([`${CREATORS}/creatorloop_channel_nadia_ferro`]);
    const juniper = await grade({ filters: { talent: [{ domain: 'creatorlooptalent.example', brand_id: 'juniper_vale' }] } });
    expect(juniper.collections.map(keyOf)).toEqual([`${CREATORS}/creatorloop_channel_juniper_vale`]);
    const shorts = await grade({ filters: { platforms: ['shorts.creatorloop.example'] } });
    expect(shorts.collections.length).toBe(5);
    expect((await grade({ filters: { name_contains: 'garage' } })).collections.map(keyOf))
      .toEqual([`${CREATORS}/creatorloop_channel_ravi_castellan`]);
    await grade({ filters: { kinds: ['channel'], platforms: ['video.creatorloop.example'], genres_exclude: ['gaming'] } });

    // Pagination: the version is stable across pages and the pages tile the selection.
    const first = await grade({ filters: { kinds: ['channel'] }, pagination: { max_results: 4 } });
    expect(first.pagination).toMatchObject({ has_more: true });
    const second = await preview('list_collections', { filters: { kinds: ['channel'] }, pagination: { max_results: 4, cursor: first.pagination.cursor } });
    expect(second.collections_version).toBe(first.collections_version);
    expect(second.collections.map(keyOf).some((key: string) => first.collections.map(keyOf).includes(key))).toBe(false);

    // Conditional fetch: same selection → unchanged; any other selection → listed.
    const filters = { kinds: ['channel'], languages: ['en'] };
    const listed = await grade({ filters });
    const unchanged = await grade(
      { filters: { languages: ['en'], kinds: ['channel'] }, if_collections_version: listed.collections_version },
      { filters, cache_scope: 'public' },
    );
    expect(unchanged.outcome).toBe('unchanged');
    expect(unchanged.collections).toBeUndefined();
    const other = await grade({ filters: { kinds: ['channel'] }, if_collections_version: listed.collections_version });
    expect(other.outcome).toBe('listed');

    // More than 100 collection IDs fails the request.
    const tooMany = await preview('list_collections', {
      collections: [{ publisher_domain: CREATORS, collection_ids: Array.from({ length: 101 }, (_, i) => `id_${i}`) }],
    });
    expect(tooMany.adcp_error?.code, JSON.stringify(tooMany).slice(0, 300)).toBe('VALIDATION_ERROR');
  }, 120_000);

  it('scopes product feed versions by include_collections and moves only the card scope on a card change', async () => {
    const plain = await preview('list_products', {});
    const withCards = await preview('list_products', { include_collections: true });
    expect(typeof plain.feed_version).toBe('string');
    expect(withCards.feed_version).not.toBe(plain.feed_version);
    // Each token is current under its own setting...
    expect((await preview('list_products', { if_feed_version: plain.feed_version })).outcome).toBe('unchanged');
    const unchangedCards = await preview('list_products', { include_collections: true, if_feed_version: withCards.feed_version });
    expect(unchangedCards.outcome).toBe('unchanged');
    expect(unchangedCards.collections).toBeUndefined();
    // ...and a mismatch under the other.
    expect((await preview('list_products', { include_collections: true, if_feed_version: plain.feed_version })).outcome).toBe('listed');
    expect((await preview('list_products', { if_feed_version: withCards.feed_version })).outcome).toBe('listed');

    // get_products ignores include_collections (adcp#8501): same scope, same unsuffixed version.
    const gpPlain = await preview('get_products', { buying_mode: 'wholesale' });
    const gpCards = await preview('get_products', { buying_mode: 'wholesale', include_collections: true });
    expect(gpCards.wholesale_feed_version).toBe(gpPlain.wholesale_feed_version);
    expect(gpCards.wholesale_feed_version).not.toMatch(/cards/);
    expect(gpCards.collections).toBeUndefined();
    expect((await preview('get_products', { buying_mode: 'wholesale', include_collections: true, if_wholesale_feed_version: gpPlain.wholesale_feed_version })).unchanged).toBe(true);

    // A card change moves the card scope only.
    const changed = await seed({
      action: 'update',
      collections: [{ publisher_domain: CREATORS, collection_id: 'creatorloop_channel_kenji_arden', fields: { season: '2026' } }],
    });
    expect(changed.success, JSON.stringify(changed)).toBe(true);
    expect((await preview('list_products', { if_feed_version: plain.feed_version })).outcome).toBe('unchanged');
    const moved = await preview('list_products', { include_collections: true, if_feed_version: withCards.feed_version });
    expect(moved.outcome).toBe('listed');
    expect(moved.feed_version).not.toBe(withCards.feed_version);
    expect(moved.collections.find((card: Card) => card.collection_id === 'creatorloop_channel_kenji_arden')?.season).toBe('2026');
  }, 120_000);

  it('pushes card webhooks to a local receiver, graded conformant, and a mirror applying them matches list_collections', async () => {
    clearCollectionCardState();
    received.length = 0;
    const account = { brand: { domain: 'collections-buyer.example' }, operator: 'collections-buyer.example', sandbox: true };
    const subscription = { subscriber_id: 'card-mirror', url: hookUrl, event_types: CARD_EVENTS, active: true };
    // Undeclared below 3.3: the stable wire rejects the card event types.
    const stable = await call('/sales/mcp', 'sync_accounts', {
      adcp_version: '3.2',
      accounts: [{ ...account, billing: 'operator', payment_terms: 'net_30', notification_configs: [subscription] }],
      idempotency_key: 'collections-sync-accounts-stable-0001',
    });
    expect(stable.accounts?.[0], JSON.stringify(stable).slice(0, 400)).toMatchObject({
      action: 'failed',
      status: 'rejected',
      errors: [expect.objectContaining({ field: 'notification_configs[0].event_types[0]' })],
    });
    const synced = await preview('sync_accounts', {
      accounts: [{ ...account, billing: 'operator', payment_terms: 'net_30', notification_configs: [subscription] }],
      idempotency_key: 'collections-sync-accounts-0001',
    });
    expect(synced.accounts?.[0]?.status, JSON.stringify(synced).slice(0, 400)).toBe('active');
    const accountId = synced.accounts[0].account_id as string;

    // Bootstrap the mirror from an unfiltered read.
    const bootstrap = await listAll();
    const mirror = { cache_scope: bootstrap.cacheScope, version: bootstrap.version, last_event_id: null as string | null, cards: bootstrap.cards };

    // A follower refresh that leaves the bounds and precision unchanged is not a change.
    const nadia = bootstrap.cards.find(card => card.collection_id === 'creatorloop_channel_nadia_ferro')!;
    const shorts = nadia.distribution.find((entry: Record<string, any>) => entry.publisher_domain === 'shorts.creatorloop.example');
    const sameCount = await seed({
      action: 'refresh_followers',
      followers: [{
        publisher_domain: CREATORS,
        collection_id: nadia.collection_id,
        distribution_publisher_domain: 'shorts.creatorloop.example',
        lower_bound: shorts.followers.lower_bound,
        upper_bound: shorts.followers.upper_bound,
        precision: 'approximate',
        as_of: '2026-11-01T00:00:00Z',
      }],
    });
    expect(sameCount.events).toEqual([]);
    expect(sameCount.collections_version).toBe(bootstrap.version);
    expect(received).toHaveLength(0);
    const recheck = await preview('list_collections', { collections: [{ publisher_domain: CREATORS, collection_ids: [nadia.collection_id] }] });
    expect(recheck.collections[0].distribution).toEqual(nadia.distribution);

    // One editorial change → one collection_card.updated with the full card.
    const newSample = {
      asset_type: 'published_post',
      post_url: 'https://shorts.creatorloop.example/v/nadia-ferro-3',
      platform: 'shorts.creatorloop.example',
      published_at: '2026-10-30T12:00:00Z',
    };
    const updated = await seed({
      action: 'update',
      collections: [{ publisher_domain: CREATORS, collection_id: nadia.collection_id, fields: { sample_content: [newSample, ...nadia.sample_content].slice(0, 3) } }],
    });
    expect(updated.success, JSON.stringify(updated)).toBe(true);
    expect(updated.events.map((event: { notification_type: string }) => event.notification_type)).toEqual(['collection_card.updated']);

    // One removal and one re-entry.
    const removed = await seed({ action: 'remove', collections: [{ publisher_domain: CREATORS, collection_id: 'creatorloop_channel_sol_marquez', removal_reason: 'withdrawn' }] });
    expect(removed.events.map((event: { notification_type: string }) => event.notification_type)).toEqual(['collection_card.removed']);
    const restored = await seed({ action: 'restore', collections: [{ publisher_domain: CREATORS, collection_id: 'creatorloop_channel_sol_marquez' }] });
    expect(restored.events.map((event: { notification_type: string }) => event.notification_type)).toEqual(['collection_card.updated']);

    // A follower sweep that moves counts goes out as one bulk event.
    const sweep = await seed({
      action: 'refresh_followers',
      followers: [
        { publisher_domain: CREATORS, collection_id: nadia.collection_id, distribution_publisher_domain: 'shorts.creatorloop.example', lower_bound: 3_900_000, upper_bound: 3_999_999, precision: 'approximate' },
        { publisher_domain: CREATORS, collection_id: 'creatorloop_channel_odette_moreau', distribution_publisher_domain: 'shorts.creatorloop.example', lower_bound: 4_500_000, upper_bound: 4_599_999, precision: 'approximate' },
      ],
    });
    expect(sweep.events.map((event: { notification_type: string }) => event.notification_type)).toEqual(['collection_catalog.bulk_change']);

    // An editorial operation over more cards than the threshold is one bulk event too.
    expect(bulkThreshold(17)).toBe(1);
    const multi = await seed({
      action: 'update',
      collections: [
        { publisher_domain: CREATORS, collection_id: 'creatorloop_channel_juniper_vale', fields: { season: '4' } },
        { publisher_domain: CREATORS, collection_id: 'creatorloop_channel_tobias_quill', fields: { season: '7' } },
      ],
    });
    expect(multi.events.map((event: { notification_type: string }) => event.notification_type)).toEqual(['collection_catalog.bulk_change']);

    // Anchored facts cannot change on the seller's copy.
    const anchored = await seed({ action: 'update', collections: [{ publisher_domain: CREATORS, collection_id: nadia.collection_id, fields: { status: 'ended' } }] });
    expect(anchored.success).toBe(false);
    expect(anchored.error).toBe('INVALID_PARAMS');

    // Every event was delivered, signed, to the local receiver, in order.
    const deliveries = received.map(entry => entry.body);
    expect(deliveries.map(body => body.notification_type)).toEqual([
      'collection_card.updated', 'collection_card.removed', 'collection_card.updated',
      'collection_catalog.bulk_change', 'collection_catalog.bulk_change',
    ]);
    for (const { headers } of received) {
      expect(headers['signature-input'] ?? headers.signature, 'RFC 9421 signature').toBeDefined();
    }
    const visibleKeys = (await listAll()).cards.map(card => ({ publisher_domain: card.publisher_domain, collection_id: card.collection_id }));
    for (const body of deliveries) {
      expect(body.account_id).toBe(accountId);
      expect(body.product_payload_view).toBeUndefined();
      const violations = grader.gradeWebhook({
        seller: SELLER,
        subscription: { account_id: accountId, event_types: CARD_EVENTS },
        subscriber_visible_keys: visibleKeys,
        webhook: body,
      });
      expect(violations, JSON.stringify(body).slice(0, 400)).toEqual([]);
    }
    // The updated event carries exactly the card list_collections serves.
    const updatedCard = deliveries[0].event.payload.collection;
    expect(deliveries[0].event.payload.changed_fields).toEqual(['sample_content']);
    const removedPayload = deliveries[1].event.payload;
    expect(removedPayload).toMatchObject({ publisher_domain: CREATORS, collection_id: 'creatorloop_channel_sol_marquez', removal_reason: 'withdrawn' });

    // Per-card events apply in order to the mirror; the first bulk event asks
    // for a full replace from an unfiltered read.
    const applied = grader.applyEvents({ mirror, events: deliveries.slice(0, 3).map(webhook => ({ webhook })) });
    expect(applied.verdict).toBe('applied');
    const afterRestore = (applied.mirror.cards as Card[]).find(card => card.collection_id === nadia.collection_id);
    expect(grader.canonical(afterRestore)).toBe(grader.canonical(updatedCard));
    const bulk = grader.applyEvents({ mirror: { ...mirror, ...applied.mirror, last_event_id: deliveries[2].event.event_id, cards: applied.mirror.cards }, events: deliveries.slice(3).map(webhook => ({ webhook })) });
    expect(bulk.verdict).toBe('repair_full');

    // A mirror that applies the per-card events matches list_collections at
    // that point: replay the same changes on a fresh sandbox and compare.
    clearCollectionCardState();
    await seed({ action: 'update', collections: [{ publisher_domain: CREATORS, collection_id: nadia.collection_id, fields: { sample_content: [newSample, ...nadia.sample_content].slice(0, 3) } }] });
    await seed({ action: 'remove', collections: [{ publisher_domain: CREATORS, collection_id: 'creatorloop_channel_sol_marquez' }] });
    await seed({ action: 'restore', collections: [{ publisher_domain: CREATORS, collection_id: 'creatorloop_channel_sol_marquez' }] });
    const fresh = await listAll();
    expect(fresh.version).toBe(applied.mirror.version);
    expect(grader.canonical(fresh.cards)).toBe(grader.canonical(applied.mirror.cards));

    // A gap repairs with the last applied version, which list_collections
    // answers with a full page.
    const gap = grader.applyEvents({ mirror, events: [deliveries[1], deliveries[2]].map(webhook => ({ webhook })) });
    expect(gap.verdict).toBe('repair_conditional');
    expect(gap.repair_token).toBe(bootstrap.version);
    const repaired = await preview('list_collections', { if_collections_version: gap.repair_token });
    expect(repaired.outcome).toBe('listed');
  }, 120_000);

  it('links creator identities back to their collections on /brand at the preview only', async () => {
    const { cards } = await listAll();
    const creators = cards.filter(card => card.publisher_domain === CREATORS && card.talent?.[0]?.brand_ref);
    const confirmed: string[] = [];
    for (const card of creators) {
      const ref = card.talent[0].brand_ref as { domain: string; brand_id: string };
      expect(ref.domain).toBe('creatorlooptalent.example');
      const identity = await preview('get_brand_identity', { brand_id: ref.brand_id, fields: ['description', 'logos', 'collections'] }, '/brand/mcp');
      expect(identity.adcp_error, JSON.stringify(identity).slice(0, 300)).toBeUndefined();
      expect(identity.logos?.length).toBeGreaterThan(0);
      const links = identity.collections as Array<{ publisher_domain: string; collection_id: string }>;
      expect(links?.length, ref.brand_id).toBeGreaterThan(0);
      if (links.some(link => keyOf(link) === keyOf(card))) confirmed.push(ref.brand_id);
    }
    // Every brand_ref is confirmed by the identity listing the key back, except one.
    expect(confirmed).toHaveLength(8);
    expect(creators.map(card => card.talent[0].brand_ref.brand_id).filter(id => !confirmed.includes(id))).toEqual(['ravi_castellan']);

    const narrowed = await preview('get_brand_identity', { brand_id: 'juniper_vale', fields: ['description'] }, '/brand/mcp');
    expect(narrowed.collections).toBeUndefined();
    for (const pin of [{ adcp_version: '3.2' }, { adcp_major_version: 3 }, {}]) {
      const stable = await call('/brand/mcp', 'get_brand_identity', { ...pin, brand_id: 'juniper_vale' });
      expect(stable.adcp_error, JSON.stringify(stable).slice(0, 300)).toBeUndefined();
      expect(stable.collections, JSON.stringify(pin)).toBeUndefined();
    }
  }, 60_000);

  it('issues strictly increasing UUID v7 event ids', () => {
    const ids = Array.from({ length: 50 }, () => monotonicUuidV7(1_800_000_000_000));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
