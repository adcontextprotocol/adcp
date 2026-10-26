/**
 * #8487: a caller pinned below 3.3 gets the shape of the release the response
 * echoes. versioning.mdx ("Server shapes to the served release"): the
 * response validates against that release's schema and omits what the
 * release does not define.
 *
 * Two checks on every route:
 *
 * - No field the source schemas mark as added after the served release
 *   (`x-added-in`). This catches a 3.3 field under an object 3.2 leaves open,
 *   which the 3.2 schema cannot catch.
 * - The response validates against the served release's own bundle, as
 *   stable SDKs validate it (16.x against 3.2.7). This catches anything new
 *   under an object the release closes, annotated or not.
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

/** Read tools each route answers without prior state, and the source
 * response schema each is graded against. */
const RESPONSE_SCHEMAS: Record<string, string> = {
  get_adcp_capabilities: 'protocol/get-adcp-capabilities-response.json',
  get_products: 'media-buy/get-products-response.json',
  list_products: 'media-buy/list-products-response.json',
  get_media_buys: 'media-buy/get-media-buys-response.json',
  list_creative_formats: 'media-buy/list-creative-formats-response.json',
  list_creatives: 'creative/list-creatives-response.json',
  get_signals: 'signals/get-signals-response.json',
  list_property_lists: 'property/list-property-lists-response.json',
  list_collection_lists: 'collection/list-collection-lists-response.json',
  list_content_standards: 'content-standards/list-content-standards-response.json',
  get_rights: 'brand/get-rights-response.json',
  list_tasks: 'core/tasks-list-response.json',
  sync_audiences: 'media-buy/sync-audiences-response.json',
  sync_event_sources: 'media-buy/sync-event-sources-response.json',
};

const ROUTES: Record<string, readonly string[]> = {
  sales: ['get_adcp_capabilities', 'get_products', 'list_products', 'get_media_buys', 'list_creative_formats', 'list_creatives', 'list_tasks', 'sync_audiences', 'sync_event_sources'],
  signals: ['get_adcp_capabilities', 'get_signals', 'list_tasks'],
  governance: ['get_adcp_capabilities', 'list_property_lists', 'list_collection_lists', 'list_content_standards', 'list_tasks'],
  creative: ['get_adcp_capabilities', 'list_creative_formats', 'list_creatives', 'list_tasks'],
  'creative-builder': ['get_adcp_capabilities', 'list_creative_formats', 'list_tasks'],
  brand: ['get_adcp_capabilities', 'get_rights', 'list_tasks'],
  si: ['get_adcp_capabilities', 'list_tasks'],
  // The v5 route the SDK's `test-mcp` alias and the public examples call.
  '': ['get_adcp_capabilities', 'get_products', 'list_products', 'get_media_buys', 'list_creative_formats', 'list_creatives', 'get_signals', 'list_property_lists', 'list_collection_lists', 'list_content_standards', 'get_rights', 'sync_audiences', 'sync_event_sources'],
};

/**
 * Responses whose whole shape is graded against the served bundle below 3.2.
 * Older releases also predate shapes the agent still projects on other tools
 * (outside #8487), so those are held to the `x-added-in` check only.
 */
const GRADED_BELOW_THREE_TWO = new Set(['get_adcp_capabilities']);

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
        for (const tool of tools) {
          const args: Record<string, unknown> = { adcp_version: version, account };
          if (tool === 'get_products') args.buying_mode = 'wholesale';
          if (tool === 'get_signals') {
            args.signal_spec = 'sports fans';
            args.deliver_to = { deployments: [{ type: 'platform', platform: 'the-trade-desk' }], countries: ['US'] };
          }
          if (tool === 'sync_audiences') {
            args.idempotency_key = `served-release-${route || 'v5'}-${version}-audiences`;
            args.audiences = [{
              audience_id: 'served_release_loyalty', name: 'Served release loyalty', audience_type: 'crm',
              add: [{ external_id: 'member_1', hashed_email: 'a'.repeat(64) }],
            }];
          }
          if (tool === 'sync_event_sources') {
            args.idempotency_key = `served-release-${route || 'v5'}-${version}-sources`;
            args.event_sources = [{ event_source_id: 'served_release_pixel', name: 'Served release pixel', event_types: ['purchase'] }];
          }
          const { structured, raw } = await call(url, tool, args);
          const adcpError = structured?.adcp_error as { code?: string; message?: string } | undefined;
          const error = adcpError?.code;
          // Compact-lifecycle tools start at 3.2 and list_tasks at 3.1; older
          // pins answer VERSION_UNSUPPORTED, or "Unknown tool" on /mcp.
          const absentFromRelease = error === 'VERSION_UNSUPPORTED'
            || (error === 'INVALID_REQUEST' && adcpError?.message === `Unknown tool: ${tool}`);
          if (absentFromRelease && version !== '3.2') continue;
          if (!structured || error) {
            failures.push(`${label} ${tool} @${version}: no result ${JSON.stringify(raw).slice(0, 300)}`);
            continue;
          }
          const served = typeof structured.adcp_version === 'string' ? structured.adcp_version : version;
          expect(served.startsWith(version), `${label} ${tool} echoed ${served} for ${version}`).toBe(true);

          const schemaFile = tool === 'list_creative_formats' && route.startsWith('creative')
            ? 'creative/list-creative-formats-response.json'
            : RESPONSE_SCHEMAS[tool];
          const newer = fieldsAddedAfterRelease(structured, schemaFile, served)
            .filter(pointer => pointer !== '/adcp_version');
          if (newer.length > 0) failures.push(`${label} ${tool} @${served}: fields added after ${served}: ${newer.join(', ')}`);

          if (version !== '3.2' && !GRADED_BELOW_THREE_TWO.has(tool)) continue;
          const validate = getCanonicalToolValidator(tool, 'sync', { adcpVersion: served });
          if (!validate) {
            failures.push(`${label} ${tool} @${served}: no ${served} response schema`);
            continue;
          }
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
          graded.push(`${tool}@${served}`);
        }
      }
      expect(failures).toEqual([]);
      // Every listed tool was graded at 3.2.
      expect(graded.filter(entry => entry.endsWith('@3.2')).map(entry => entry.split('@')[0])).toEqual([...tools]);
    }, 60_000);
  }
});
