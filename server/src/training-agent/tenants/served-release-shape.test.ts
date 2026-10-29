/**
 * #8487: a caller pinned below 3.3 gets the shape of the release the response
 * echoes. versioning.mdx ("Server shapes to the served release"): the
 * response validates against that release's schema and omits what the
 * release does not define.
 *
 * Every route is driven through the same read and lifecycle flow at 3.2, 3.1
 * and 3.0, and every response is held to three checks:
 *
 * - No field the source schemas mark as added after the served release
 *   (`x-added-in`). This catches a 3.3 field under an object 3.2 leaves open,
 *   which the 3.2 schema cannot catch.
 * - The response validates against the served release's own bundle, as
 *   stable SDKs validate it (16.x against 3.2.7). This catches anything new
 *   under an object the release closes, annotated or not, and any field or
 *   enum value an older release requires or lacks.
 * - A tool the served release does not define is refused (VERSION_UNSUPPORTED,
 *   or "Unknown tool" on /mcp) rather than answered with a payload that
 *   release cannot validate.
 *
 * The 3.3 side (the same fields still reach a 3.3 caller) is covered in
 * tests/unit/training-agent-candidate-version.test.ts, since the training
 * agent serves 3.3 only through the local candidate wire contract.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import { getCanonicalToolValidator } from '@adcp/sdk/schemas';
import { fieldsAddedAfterRelease } from '../served-release-fields.js';
import { clearSessions, stopSessionCleanup } from '../state.js';
import { clearAccountStore } from '../account-handlers.js';

process.env.PUBLIC_TEST_AGENT_TOKEN = 'served-release-shape-token';

const TOKEN = 'served-release-shape-token';

/** The source response schema each tool is graded against for `x-added-in`. */
const RESPONSE_SCHEMAS: Record<string, string> = {
  get_adcp_capabilities: 'protocol/get-adcp-capabilities-response.json',
  list_accounts: 'account/list-accounts-response.json',
  get_products: 'media-buy/get-products-response.json',
  list_products: 'media-buy/list-products-response.json',
  create_media_buy: 'media-buy/create-media-buy-response.json',
  get_media_buys: 'media-buy/get-media-buys-response.json',
  update_media_buy: 'media-buy/update-media-buy-response.json',
  get_media_buy_delivery: 'media-buy/get-media-buy-delivery-response.json',
  list_creative_formats: 'media-buy/list-creative-formats-response.json',
  sync_creatives: 'creative/sync-creatives-response.json',
  list_creatives: 'creative/list-creatives-response.json',
  preview_creative: 'creative/preview-creative-response.json',
  list_transformers: 'creative/list-transformers-response.json',
  get_signals: 'signals/get-signals-response.json',
  list_property_lists: 'property/list-property-lists-response.json',
  create_property_list: 'property/create-property-list-response.json',
  get_property_list: 'property/get-property-list-response.json',
  list_collection_lists: 'collection/list-collection-lists-response.json',
  list_content_standards: 'content-standards/list-content-standards-response.json',
  get_brand_identity: 'brand/get-brand-identity-response.json',
  get_rights: 'brand/get-rights-response.json',
  acquire_rights: 'brand/acquire-rights-response.json',
  search_brands: 'brand/search-brands-response.json',
  list_tasks: 'core/tasks-list-response.json',
  sync_audiences: 'media-buy/sync-audiences-response.json',
  sync_event_sources: 'media-buy/sync-event-sources-response.json',
};

// list_creatives runs before sync_creatives so it lists the seeded canonical
// (format_kind) library creative a 3.0 caller must see by format_id.
const MEDIA_BUY_FLOW = [
  'list_creative_formats', 'get_products', 'list_products', 'create_media_buy', 'get_media_buys',
  'update_media_buy', 'get_media_buy_delivery', 'list_creatives', 'sync_creatives', 'preview_creative',
] as const;

/** Each route's tools, in call order (later calls read earlier results). */
const ROUTES: Record<string, readonly string[]> = {
  sales: ['get_adcp_capabilities', 'list_accounts', ...MEDIA_BUY_FLOW, 'list_tasks', 'sync_audiences', 'sync_event_sources'],
  signals: ['get_adcp_capabilities', 'list_accounts', 'get_signals', 'list_tasks'],
  governance: ['get_adcp_capabilities', 'list_accounts', 'list_property_lists', 'create_property_list', 'get_property_list', 'list_collection_lists', 'list_content_standards', 'list_tasks'],
  creative: ['get_adcp_capabilities', 'list_accounts', 'list_creative_formats', 'list_creatives', 'list_transformers', 'list_tasks'],
  'creative-builder': ['get_adcp_capabilities', 'list_accounts', 'list_creative_formats', 'list_transformers', 'list_tasks'],
  brand: ['get_adcp_capabilities', 'list_accounts', 'get_brand_identity', 'get_rights', 'acquire_rights', 'search_brands', 'list_tasks'],
  si: ['get_adcp_capabilities', 'list_accounts', 'list_tasks'],
  // The v5 route the SDK's `test-mcp` alias and the public examples call.
  '': [
    'get_adcp_capabilities', 'list_accounts', ...MEDIA_BUY_FLOW, 'get_signals', 'list_property_lists',
    'create_property_list', 'get_property_list', 'list_collection_lists', 'list_content_standards',
    'get_brand_identity', 'get_rights', 'acquire_rights', 'search_brands', 'sync_audiences', 'sync_event_sources',
  ],
};

/**
 * Root envelope keys a release's closed task root may not list: the
 * `adcp_version` echo every response carries (versioning.mdx; the 3.2
 * list_products root omits it, 3.3 adds it) and the envelope `status` the v5
 * route stamps. SDK clients relax the response root for both.
 */
const ROOT_ENVELOPE_KEYS = new Set(['adcp_version', 'status']);

interface Called {
  structured: Record<string, unknown> | undefined;
  raw: unknown;
}

/** Results earlier calls in one route/version flow hand to later ones. */
interface FlowState {
  products?: Array<Record<string, unknown>>;
  formatId?: Record<string, unknown>;
  mediaBuyId?: string;
  propertyListId?: string;
  rights?: { rightsId: string; pricingOptionId: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function rpc(url: string, id: number, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params && { params }) }),
  });
  return response.json() as Promise<Record<string, unknown>>;
}

/** Arguments for `tool`, or undefined when the flow lacks what it needs. */
function argsFor(tool: string, label: string, version: string, state: FlowState): Record<string, unknown> | undefined {
  const key = (suffix: string) => `served-release-${label}-${version}-${suffix}`;
  const image = { asset_type: 'image', url: 'https://cdn.example.com/served-release.png', width: 300, height: 250 };
  switch (tool) {
    case 'get_products':
      return { buying_mode: 'brief', brief: 'Display and video for sports fans in the US' };
    case 'create_media_buy': {
      const product = state.products?.find(candidate => {
        const option = (candidate.pricing_options as Array<Record<string, unknown>> | undefined)?.[0];
        return typeof option?.fixed_price === 'number' && Number(option.min_spend_per_package ?? 0) <= 10_000;
      });
      const option = (product?.pricing_options as Array<Record<string, unknown>> | undefined)?.[0];
      if (!product || !option) return undefined;
      const day = 24 * 60 * 60 * 1000;
      return {
        brand: { domain: `served-release-${label}.example` },
        start_time: new Date(Date.now() + day).toISOString(),
        end_time: new Date(Date.now() + 30 * day).toISOString(),
        idempotency_key: key('media-buy'),
        packages: [{ product_id: product.product_id, pricing_option_id: option.pricing_option_id, budget: 10_000 }],
      };
    }
    case 'get_media_buys':
    case 'get_media_buy_delivery':
      return state.mediaBuyId ? { media_buy_ids: [state.mediaBuyId] } : undefined;
    case 'update_media_buy':
      return state.mediaBuyId
        ? { media_buy_id: state.mediaBuyId, paused: true, idempotency_key: key('update') }
        : undefined;
    case 'sync_creatives':
      return state.formatId
        ? {
          idempotency_key: key('creatives'),
          creatives: [{ creative_id: `served_release_${version.replace('.', '_')}`, name: 'Served release creative', format_id: state.formatId, assets: { image } }],
        }
        : undefined;
    case 'preview_creative':
      return state.formatId
        ? { request_type: 'single', format_id: state.formatId, creative_manifest: { format_id: state.formatId, assets: { image } } }
        : undefined;
    case 'get_signals':
      return {
        signal_spec: 'sports fans',
        deliver_to: { deployments: [{ type: 'platform', platform: 'the-trade-desk' }], countries: ['US'] },
      };
    case 'create_property_list':
      return { name: 'Served release list', idempotency_key: key('property-list') };
    case 'get_property_list':
      return state.propertyListId ? { list_id: state.propertyListId } : undefined;
    case 'get_brand_identity':
      return { brand_id: 'daan_janssen' };
    case 'get_rights':
      return { query: 'athlete endorsement', uses: ['likeness'] };
    case 'acquire_rights':
      return state.rights
        ? {
          rights_id: state.rights.rightsId,
          pricing_option_id: state.rights.pricingOptionId,
          buyer: { domain: `served-release-${label}.example` },
          campaign: {
            description: 'Served release rights',
            uses: ['likeness'],
            countries: ['NL'],
            estimated_impressions: 100_000,
            start_date: '2099-04-01',
            end_date: '2099-06-30',
          },
          revocation_webhook: {
            url: `https://served-release-${label}.example/webhooks/revocation`,
            authentication: { schemes: ['Bearer'], credentials: 'revocation-token-xxxxxxxxxxxxxxxx' },
          },
          idempotency_key: key('rights'),
        }
        : undefined;
    case 'search_brands':
      return { query: 'speed skating athletes' };
    case 'sync_audiences':
      return {
        idempotency_key: key('audiences'),
        audiences: [{
          audience_id: 'served_release_loyalty', name: 'Served release loyalty', audience_type: 'crm',
          add: [{ external_id: 'member_1', hashed_email: 'a'.repeat(64) }],
        }],
      };
    case 'sync_event_sources':
      return {
        idempotency_key: key('sources'),
        event_sources: [{ event_source_id: 'served_release_pixel', name: 'Served release pixel', event_types: ['purchase'] }],
      };
    default:
      return {};
  }
}

function capture(tool: string, structured: Record<string, unknown>, state: FlowState): void {
  if (tool === 'get_products' && Array.isArray(structured.products)) {
    state.products = structured.products.filter(isRecord);
  }
  if (tool === 'list_creative_formats' && Array.isArray(structured.formats)) {
    const formats = structured.formats.filter(isRecord);
    const display = formats.find(format => isRecord(format.format_id) && String(format.format_id.id).includes('display'));
    if (display && isRecord(display.format_id)) state.formatId = display.format_id;
  }
  if (tool === 'create_media_buy' && typeof structured.media_buy_id === 'string') {
    state.mediaBuyId = structured.media_buy_id;
  }
  if (tool === 'get_rights' && Array.isArray(structured.rights)) {
    const offer = structured.rights.filter(isRecord).find(right => typeof right.rights_id === 'string'
      && Array.isArray(right.pricing_options) && isRecord(right.pricing_options[0]));
    const option = offer && (offer.pricing_options as Array<Record<string, unknown>>)[0];
    if (offer && option && typeof option.pricing_option_id === 'string') {
      state.rights = { rightsId: offer.rights_id as string, pricingOptionId: option.pricing_option_id };
    }
  }
  if (tool === 'create_property_list' && isRecord(structured.list) && typeof structured.list.list_id === 'string') {
    state.propertyListId = structured.list.list_id;
  }
}

describe('served-release response shape below 3.3 (#8487)', () => {
  let server: http.Server;
  let baseUrl: string;
  let rpcId = 1;

  const call = async (url: string, name: string, args: Record<string, unknown>): Promise<Called> => {
    rpcId += 1;
    const raw = await rpc(url, rpcId, 'tools/call', { name, arguments: args });
    const result = raw.result as { structuredContent?: Record<string, unknown> } | undefined;
    return { structured: result?.structuredContent, raw };
  };

  beforeAll(async () => {
    clearSessions();
    clearAccountStore();
    const { createTrainingAgentRouter } = await import('../index.js');
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
    baseUrl = `http://127.0.0.1:${address.port}/api/training-agent`;
  }, 60_000);

  afterAll(async () => {
    clearSessions();
    clearAccountStore();
    stopSessionCleanup();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  for (const [route, tools] of Object.entries(ROUTES)) {
    const label = route ? `/${route}/mcp` : '/mcp';
    it(`serves ${label} callers pinned to 3.2, 3.1 and 3.0 their release's shape`, async () => {
      const url = `${baseUrl}${route ? `/${route}` : ''}/mcp`;
      await rpc(url, 1, 'initialize', {
        protocolVersion: '2025-03-26',
        clientInfo: { name: 'served-release-shape', version: '1' },
        capabilities: {},
      });
      const graded: string[] = [];
      const failures: string[] = [];
      for (const version of ['3.2', '3.1', '3.0']) {
        const account = {
          brand: { domain: `served-release-${route || 'v5'}.example` },
          operator: `served-release-${route || 'v5'}.example`,
          sandbox: true,
        };
        await call(url, 'sync_accounts', {
          adcp_version: version,
          accounts: [{ ...account, billing: 'operator', payment_terms: 'net_30' }],
          idempotency_key: `served-release-${route || 'v5'}-${version}-provision`,
        });
        const state: FlowState = {};
        for (const tool of tools) {
          const toolArgs = argsFor(tool, route || 'v5', version, state);
          if (!toolArgs) {
            failures.push(`${label} ${tool} @${version}: an earlier step left nothing to call it with`);
            continue;
          }
          const { structured, raw } = await call(url, tool, { adcp_version: version, account, ...toolArgs });
          const adcpError = structured?.adcp_error as { code?: string; message?: string } | undefined;
          const error = adcpError?.code;
          const validate = getCanonicalToolValidator(tool, 'sync', { adcpVersion: version });
          if (!validate) {
            // The served release does not define the tool (list_tasks before
            // 3.1, search_brands and list_transformers before 3.1, the
            // compact lifecycle before 3.2): it must be refused, not served.
            const refused = error === 'VERSION_UNSUPPORTED'
              || (error === 'INVALID_REQUEST' && adcpError?.message === `Unknown tool: ${tool}`);
            if (!refused) {
              failures.push(`${label} ${tool} @${version}: served a tool ${version} does not define ${JSON.stringify(raw).slice(0, 200)}`);
            }
            continue;
          }
          if (!structured || error) {
            failures.push(`${label} ${tool} @${version}: no result ${JSON.stringify(raw).slice(0, 300)}`);
            continue;
          }
          capture(tool, structured, state);
          const served = typeof structured.adcp_version === 'string' ? structured.adcp_version : version;
          expect(served.startsWith(version), `${label} ${tool} echoed ${served} for ${version}`).toBe(true);

          const schemaFile = tool === 'list_creative_formats' && route.startsWith('creative')
            ? 'creative/list-creative-formats-response.json'
            : RESPONSE_SCHEMAS[tool];
          const newer = fieldsAddedAfterRelease(structured, schemaFile, served)
            .filter(pointer => pointer !== '/adcp_version');
          if (newer.length > 0) failures.push(`${label} ${tool} @${served}: fields added after ${served}: ${newer.join(', ')}`);

          validate(structured);
          const errors = (validate.errors ?? []).filter(entry => !(
            entry.instancePath === ''
            && entry.keyword === 'additionalProperties'
            && ROOT_ENVELOPE_KEYS.has(String((entry.params as { additionalProperty?: unknown }).additionalProperty))
          ));
          if (errors.length > 0) {
            failures.push(`${label} ${tool} @${served}: ${JSON.stringify(errors.slice(0, 5).map(entry => (
              `${entry.instancePath} ${entry.message} ${JSON.stringify(entry.params)}`
            )))}`);
          }
          // A 3.0 product card is a format reference plus its manifest; the
          // inline card replaced it in 3.1. Withholding the card would also
          // validate, so require the release's own shape on a carded product.
          if (tool === 'get_products') {
            const cards = (structured.products as Array<Record<string, unknown>>)
              .map(product => product.product_card)
              .filter(isRecord);
            const releaseShaped = version === '3.0'
              ? cards.some(card => isRecord(card.format_id) && card.format_id.id === 'product_card_standard' && isRecord(card.manifest))
              : cards.some(card => typeof card.title === 'string');
            if (!releaseShaped) failures.push(`${label} get_products @${version}: no product carries the ${version} product_card shape`);
          }
          graded.push(`${tool}@${version}`);
        }
      }
      expect(failures).toEqual([]);
      // Every listed tool was graded at 3.2.
      expect(graded.filter(entry => entry.endsWith('@3.2')).map(entry => entry.split('@')[0])).toEqual([...tools]);
    }, 180_000);
  }

  it('answers /mcp search_brands without a query with the correctable error the request schema requires', async () => {
    const url = `${baseUrl}/mcp`;
    for (const version of ['3.2', '3.1']) {
      const { structured, raw } = await call(url, 'search_brands', { adcp_version: version });
      const adcpError = structured?.adcp_error as { code?: string; field?: string; recovery?: string } | undefined;
      expect(adcpError, JSON.stringify(raw).slice(0, 300)).toMatchObject({
        code: 'INVALID_REQUEST',
        field: 'query',
        recovery: 'correctable',
      });
      // An empty query is a valid request: it matches the whole roster.
      const empty = await call(url, 'search_brands', { adcp_version: version, query: '' });
      expect(Array.isArray(empty.structured?.brands), JSON.stringify(empty.raw).slice(0, 300)).toBe(true);
    }
  }, 30_000);
});
