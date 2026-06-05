import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

vi.mock('../../src/utils/url-security.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/url-security.js')>();
  return {
    ...actual,
    safeFetchAxiosLike: vi.fn(),
  };
});

// Mock @adcp/sdk so MCP validation doesn't try a real network connect.
// The MCP path dynamically imports the SDK; without this mock, a missing
// agent test waits on the SDK's connect-then-timeout (5s) plus library
// init overhead, which can blow the test timeout.
vi.mock('@adcp/sdk', () => {
  class AdCPClient {
    constructor() {}
    agent() {
      return {
        getAgentInfo: () => Promise.reject(new Error('mock: MCP unreachable')),
      };
    }
  }
  return {
    AdCPClient,
    is401Error: () => false,
  };
});

import { AdAgentsManager } from '../../src/adagents-manager.js';
import type { AuthorizedAgent, AdAgentsJson } from '../../src/types.js';
import { safeFetchAxiosLike } from '../../src/utils/url-security.js';

const mockedSafeFetch = vi.mocked(safeFetchAxiosLike);

function buf(data: unknown): Buffer {
  return Buffer.from(JSON.stringify(data));
}

describe('AdAgentsManager', () => {
  let manager: AdAgentsManager;

  beforeEach(() => {
    manager = new AdAgentsManager();
    mockedSafeFetch.mockReset();
  });

  describe('validateDomain', () => {
    it('validates a valid adagents.json file', async () => {
      const validAdAgents: AdAgentsJson = {
        $schema: 'https://adcontextprotocol.org/schemas/v3/adagents.json',
        authorized_agents: [
          {
            url: 'https://agent.example.com',
            authorized_for: 'Test authorization scope',
            authorization_type: 'property_ids',
            property_ids: ['p1'],
          },
        ],
        last_updated: new Date().toISOString(),
      };

      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: buf(validAdAgents),
        headers: { 'content-type': 'application/json' },
        url: 'https://example.com/.well-known/adagents.json',
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.domain).toBe('example.com');
      expect(result.url).toBe('https://example.com/.well-known/adagents.json');
      expect(result.status_code).toBe(200);
      expect(result.discovery_method).toBe('direct');
    });

    // Phase B regression: validator must capture response body byte
    // length and post-redirect resolved URL on success. The crawler
    // threads both into publishers.last_response_bytes / resolved_url
    // for verifier-grade hero chrome. Without these tests, a
    // refactor that loses the captures would silently regress while
    // the route-layer tests still pass (they upsert metadata directly).
    it('captures response_bytes and resolved_url on a 200 fetch', async () => {
      const valid: AdAgentsJson = {
        authorized_agents: [{ url: 'https://agent.example.com', authorized_for: 'Test', authorization_type: 'property_ids', property_ids: ['p1'] }],
        last_updated: new Date().toISOString(),
      };
      const body = buf(valid);
      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: body,
        headers: { 'content-type': 'application/json' },
        // Simulate a 301 redirect: input was example.com, final URL
        // is the CDN host. Validator should record the post-redirect URL.
        url: 'https://cdn.example.net/.well-known/adagents.json',
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(true);
      expect(result.response_bytes).toBe(body.byteLength);
      expect(result.resolved_url).toBe('https://cdn.example.net/.well-known/adagents.json');
    });

    it('captures response_bytes and resolved_url even on a non-200', async () => {
      // Failed fetch still surfaces the metadata via
      // recordFailedAdagentsFetch downstream — the validator must
      // populate both before early-returning.
      const errBody = Buffer.from('<html>Not Found</html>');
      mockedSafeFetch.mockResolvedValue({
        status: 404,
        data: errBody,
        headers: { 'content-type': 'text/html' },
        url: 'https://example.com/.well-known/adagents.json',
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(false);
      expect(result.status_code).toBe(404);
      expect(result.response_bytes).toBe(errBody.byteLength);
      expect(result.resolved_url).toBe('https://example.com/.well-known/adagents.json');
    });

    it('overwrites resolved_url when authoritative_location is followed', async () => {
      // Phase A behavior reaffirmed: when the publisher's stub points
      // at a different canonical URL, the validator follows it and the
      // resolved_url should reflect WHERE the canonical body came from
      // (the authoritative_location target), not where the stub lived.
      const stubBody = buf({ authoritative_location: 'https://cdn.example.net/adagents.json' });
      const canonicalBody = buf({
        authorized_agents: [{ url: 'https://agent.example.com', authorized_for: 'Test', authorization_type: 'property_ids', property_ids: ['p1'] }],
        last_updated: new Date().toISOString(),
      });
      mockedSafeFetch
        .mockResolvedValueOnce({
          status: 200,
          data: stubBody,
          headers: { 'content-type': 'application/json' },
          url: 'https://example.com/.well-known/adagents.json',
        })
        .mockResolvedValueOnce({
          status: 200,
          data: canonicalBody,
          headers: { 'content-type': 'application/json' },
          url: 'https://cdn.example.net/adagents.json',
        });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(true);
      expect(result.resolved_url).toBe('https://cdn.example.net/adagents.json');
      expect(result.response_bytes).toBe(canonicalBody.byteLength);
    });

    it('normalizes domain by removing protocol', async () => {
      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: buf({ authorized_agents: [{ url: 'https://agent.example.com', authorized_for: 'Test', authorization_type: 'property_ids', property_ids: ['p1'] }] }),
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('https://example.com');

      expect(result.domain).toBe('example.com');
      expect(result.url).toBe('https://example.com/.well-known/adagents.json');
    });

    it('normalizes domain by removing trailing slash', async () => {
      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: buf({ authorized_agents: [{ url: 'https://agent.example.com', authorized_for: 'Test', authorization_type: 'property_ids', property_ids: ['p1'] }] }),
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com/');

      expect(result.domain).toBe('example.com');
    });

    it('detects missing adagents.json (404)', async () => {
      mockedSafeFetch.mockResolvedValue({
        status: 404,
        data: '<html>Not Found</html>',
        headers: { 'content-type': 'text/html' },
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('File not found');
      expect(result.raw_data).toBeUndefined(); // Don't include HTML error pages
    });

    it('falls back to managerdomain adagents.json when origin adagents.json is missing and ads.txt declares managerdomain', async () => {
      mockedSafeFetch.mockImplementation(async (url) => {
        if (url === 'https://publisher.example/.well-known/adagents.json') {
          return { status: 404, data: 'Not Found', headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://publisher.example/ads.txt') {
          return { status: 200, data: Buffer.from('MANAGERDOMAIN=manager.example\n'), headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://manager.example/.well-known/adagents.json') {
          return {
            status: 200,
            data: buf({ authorized_agents: [{ url: 'https://agent.example', authorized_for: 'All inventory', authorization_type: 'publisher_properties', publisher_properties: [{ publisher_domain: 'publisher.example', selection_type: 'all' }] }] }),
            headers: { 'content-type': 'application/json' },
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const result = await manager.validateDomain('publisher.example');
      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.field === 'managerdomain')).toBe(true);
      expect(result.domain).toBe('publisher.example');
      expect(result.url).toBe('https://publisher.example/.well-known/adagents.json');
      expect(result.discovery_method).toBe('ads_txt_managerdomain');
      expect(result.manager_domain).toBe('manager.example');
    });

    it('falls back to managerdomain adagents.json when origin returns 403 for a missing S3/CloudFront object', async () => {
      mockedSafeFetch.mockImplementation(async (url) => {
        if (url === 'https://publisher.example/.well-known/adagents.json') {
          return {
            status: 403,
            data: Buffer.from('<Error><Code>AccessDenied</Code></Error>'),
            headers: { 'content-type': 'application/xml' },
          };
        }
        if (url === 'https://publisher.example/ads.txt') {
          return { status: 200, data: Buffer.from('MANAGERDOMAIN=manager.example\n'), headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://manager.example/.well-known/adagents.json') {
          return {
            status: 200,
            data: buf({
              authorized_agents: [{
                url: 'https://agent.example',
                authorized_for: 'All inventory',
                authorization_type: 'publisher_properties',
                publisher_properties: [{ publisher_domain: 'publisher.example', selection_type: 'all' }],
              }],
            }),
            headers: { 'content-type': 'application/json' },
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const result = await manager.validateDomain('publisher.example');
      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.field === 'managerdomain')).toBe(true);
      expect(result.domain).toBe('publisher.example');
      expect(result.discovery_method).toBe('ads_txt_managerdomain');
      expect(result.manager_domain).toBe('manager.example');
    });

    it('does not trigger manager fallback on generic 403 denial responses', async () => {
      let calledAdsTxt = false;
      mockedSafeFetch.mockImplementation(async (url) => {
        if (url === 'https://publisher.example/.well-known/adagents.json') {
          return {
            status: 403,
            data: Buffer.from('<html>Forbidden</html>'),
            headers: { 'content-type': 'text/html' },
          };
        }
        if (url === 'https://publisher.example/ads.txt') {
          calledAdsTxt = true;
          return { status: 200, data: Buffer.from('MANAGERDOMAIN=manager.example\n'), headers: { 'content-type': 'text/plain' } };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const result = await manager.validateDomain('publisher.example');
      expect(result.valid).toBe(false);
      expect(calledAdsTxt).toBe(false);
      expect(result.errors.some(e => e.message.includes('HTTP 403'))).toBe(true);
    });

    it('does not recurse indefinitely when managerdomain points back to original domain', async () => {
      mockedSafeFetch.mockImplementation(async (url) => {
        if (url === 'https://publisher.example/.well-known/adagents.json') {
          return { status: 404, data: 'Not Found', headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://publisher.example/ads.txt') {
          return { status: 200, data: Buffer.from('MANAGERDOMAIN=publisher.example\n'), headers: { 'content-type': 'text/plain' } };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const result = await manager.validateDomain('publisher.example');
      expect(result.valid).toBe(false);
      expect(result.warnings.some(w => w.message.includes('cycle detection'))).toBe(true);
      expect(result.errors.some(e => e.field === 'http_status')).toBe(true);
    });

    it('enforces one-hop managerdomain fallback depth', async () => {
      mockedSafeFetch.mockImplementation(async (url) => {
        if (url === 'https://publisher.example/.well-known/adagents.json') {
          return { status: 404, data: 'Not Found', headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://publisher.example/ads.txt') {
          return { status: 200, data: Buffer.from('MANAGERDOMAIN=manager1.example\n'), headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://manager1.example/.well-known/adagents.json') {
          return { status: 404, data: 'Not Found', headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://manager1.example/ads.txt') {
          return { status: 200, data: Buffer.from('MANAGERDOMAIN=manager2.example\n'), headers: { 'content-type': 'text/plain' } };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const result = await manager.validateDomain('publisher.example');
      expect(result.valid).toBe(false);
      expect(result.warnings.some(w => w.message.includes('max fallback depth'))).toBe(true);
      expect(result.errors.some(e => e.field === 'http_status')).toBe(true);
    });

    it('ignores managerdomain when the managerdomain line has #noagents', async () => {
      mockedSafeFetch.mockImplementation(async (url) => {
        if (url === 'https://publisher.example/.well-known/adagents.json') {
          return { status: 404, data: 'Not Found', headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://publisher.example/ads.txt') {
          return {
            status: 200,
            data: Buffer.from('MANAGERDOMAIN=manager.example #noagents\n'),
            headers: { 'content-type': 'text/plain' },
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const result = await manager.validateDomain('publisher.example');
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'http_status')).toBe(true);
    });

    it('accepts MANAGERDOMAIN directive form (non-comment) case-insensitively', async () => {
      mockedSafeFetch.mockImplementation(async (url) => {
        if (url === 'https://publisher.example/.well-known/adagents.json') {
          return { status: 404, data: 'Not Found', headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://publisher.example/ads.txt') {
          return { status: 200, data: Buffer.from('MANAGERDOMAIN=Manager.Example\n'), headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://manager.example/.well-known/adagents.json') {
          return {
            status: 200,
            data: buf({ authorized_agents: [{ url: 'https://agent.example', authorized_for: 'All inventory', authorization_type: 'publisher_properties', publisher_properties: [{ publisher_domain: 'publisher.example', selection_type: 'all' }] }] }),
            headers: { 'content-type': 'application/json' },
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const result = await manager.validateDomain('publisher.example');
      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.field === 'managerdomain')).toBe(true);
    });

    it('ignores comment-only managerdomain lines', async () => {
      mockedSafeFetch.mockImplementation(async (url) => {
        if (url === 'https://publisher.example/.well-known/adagents.json') {
          return { status: 404, data: 'Not Found', headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://publisher.example/ads.txt') {
          return { status: 200, data: Buffer.from('# managerdomain=comment-only.example\n'), headers: { 'content-type': 'text/plain' } };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const result = await manager.validateDomain('publisher.example');
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'http_status')).toBe(true);
    });

    it('uses the last managerdomain entry when multiple managerdomain entries are present', async () => {
      mockedSafeFetch.mockImplementation(async (url) => {
        if (url === 'https://publisher.example/.well-known/adagents.json') {
          return { status: 404, data: 'Not Found', headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://publisher.example/ads.txt') {
          return {
            status: 200,
            data: Buffer.from('MANAGERDOMAIN=bad-manager.example\nMANAGERDOMAIN=good-manager.example\n'),
            headers: { 'content-type': 'text/plain' },
          };
        }
        if (url === 'https://good-manager.example/.well-known/adagents.json') {
          return {
            status: 200,
            data: buf({ authorized_agents: [{ url: 'https://agent.example', authorized_for: 'Good', authorization_type: 'publisher_properties', publisher_properties: [{ publisher_domain: 'publisher.example' }] }] }),
            headers: { 'content-type': 'application/json' },
          };
        }
        if (url === 'https://bad-manager.example/.well-known/adagents.json') {
          throw new Error('bad-manager.example should not be tried; last entry wins');
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const result = await manager.validateDomain('publisher.example');
      expect(result.valid).toBe(true);
      expect(result.discovery_method).toBe('ads_txt_managerdomain');
      expect(result.manager_domain).toBe('good-manager.example');
      expect(result.warnings.some(w => w.message.includes('good-manager.example'))).toBe(true);
    });

    it('uses next eligible managerdomain when #noagents removes the first candidate', async () => {
      mockedSafeFetch.mockImplementation(async (url) => {
        if (url === 'https://publisher.example/.well-known/adagents.json') {
          return { status: 404, data: 'Not Found', headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://publisher.example/ads.txt') {
          return {
            status: 200,
            data: Buffer.from('MANAGERDOMAIN=blocked.example #NOAGENTS\nMANAGERDOMAIN=allowed.example\n'),
            headers: { 'content-type': 'text/plain' },
          };
        }
        if (url === 'https://allowed.example/.well-known/adagents.json') {
          return {
            status: 200,
            data: buf({ authorized_agents: [{ url: 'https://agent.example', authorized_for: 'Allowed', authorization_type: 'publisher_properties', publisher_properties: [{ publisher_domain: 'publisher.example' }] }] }),
            headers: { 'content-type': 'application/json' },
          };
        }
        if (url === 'https://blocked.example/.well-known/adagents.json') {
          throw new Error('blocked.example should be skipped due to #NOAGENTS');
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const result = await manager.validateDomain('publisher.example');
      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.message.includes('allowed.example'))).toBe(true);
    });

    it('rejects managerdomain fallback when manager adagents.json does not explicitly scope to source publisher', async () => {
      mockedSafeFetch.mockImplementation(async (url) => {
        if (url === 'https://publisher.example/.well-known/adagents.json') {
          return { status: 404, data: 'Not Found', headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://publisher.example/ads.txt') {
          return { status: 200, data: Buffer.from('MANAGERDOMAIN=manager.example\n'), headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://manager.example/.well-known/adagents.json') {
          return {
            status: 200,
            data: buf({ authorized_agents: [{ url: 'https://agent.example', authorized_for: 'All inventory', authorization_type: 'property_ids', property_ids: ['p1'] }] }),
            headers: { 'content-type': 'application/json' },
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const result = await manager.validateDomain('publisher.example');
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'managerdomain_scope')).toBe(true);
    });

    it('ignores managerdomain lines with invalid host token and continues scanning', async () => {
      mockedSafeFetch.mockImplementation(async (url) => {
        if (url === 'https://publisher.example/.well-known/adagents.json') {
          return { status: 404, data: 'Not Found', headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://publisher.example/ads.txt') {
          return {
            status: 200,
            data: Buffer.from('MANAGERDOMAIN=https://bad.example\nMANAGERDOMAIN=good.example\n'),
            headers: { 'content-type': 'text/plain' },
          };
        }
        if (url === 'https://good.example/.well-known/adagents.json') {
          return {
            status: 200,
            data: buf({ authorized_agents: [{ url: 'https://agent.example', authorized_for: 'Good', authorization_type: 'publisher_properties', publisher_properties: [{ publisher_domain: 'publisher.example' }] }] }),
            headers: { 'content-type': 'application/json' },
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const result = await manager.validateDomain('publisher.example');
      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.message.includes('good.example'))).toBe(true);
    });

    it('uses the last managerdomain entry when multiple entries include cyclic and non-cyclic managerdomain values', async () => {
      mockedSafeFetch.mockImplementation(async (url) => {
        if (url === 'https://publisher.example/.well-known/adagents.json') {
          return { status: 404, data: 'Not Found', headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://publisher.example/ads.txt') {
          return {
            status: 200,
            data: Buffer.from('MANAGERDOMAIN=publisher.example\nMANAGERDOMAIN=good.example\n'),
            headers: { 'content-type': 'text/plain' },
          };
        }
        if (url === 'https://good.example/.well-known/adagents.json') {
          return {
            status: 200,
            data: buf({ authorized_agents: [{ url: 'https://agent.example', authorized_for: 'Good', authorization_type: 'publisher_properties', publisher_properties: [{ publisher_domain: 'publisher.example' }] }] }),
            headers: { 'content-type': 'application/json' },
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const result = await manager.validateDomain('publisher.example');
      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.message.includes('good.example'))).toBe(true);
    });



    it('accepts managerdomain fallback when manager adagents.json scopes via collections', async () => {
      mockedSafeFetch.mockImplementation(async (url) => {
        if (url === 'https://publisher.example/.well-known/adagents.json') {
          return { status: 404, data: 'Not Found', headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://publisher.example/ads.txt') {
          return { status: 200, data: Buffer.from('MANAGERDOMAIN=manager.example\n'), headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://manager.example/.well-known/adagents.json') {
          return {
            status: 200,
            data: buf({
              authorized_agents: [{
                url: 'https://agent.example',
                authorized_for: 'Scoped via collection',
                authorization_type: 'property_tags',
                property_tags: ['network'],
                collections: [{ publisher_domain: 'publisher.example' }],
              }],
            }),
            headers: { 'content-type': 'application/json' },
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const result = await manager.validateDomain('publisher.example');
      expect(result.valid).toBe(true);
      expect(result.discovery_method).toBe('ads_txt_managerdomain');
      expect(result.manager_domain).toBe('manager.example');
    });

    it('rejects managerdomain fallback when manager adagents.json scopes a different publisher', async () => {
      mockedSafeFetch.mockImplementation(async (url) => {
        if (url === 'https://publisher.example/.well-known/adagents.json') {
          return { status: 404, data: 'Not Found', headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://publisher.example/ads.txt') {
          return { status: 200, data: Buffer.from('MANAGERDOMAIN=manager.example\n'), headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://manager.example/.well-known/adagents.json') {
          return {
            status: 200,
            data: buf({
              authorized_agents: [{
                url: 'https://agent.example',
                authorized_for: 'Wrong publisher',
                authorization_type: 'publisher_properties',
                publisher_properties: [{ publisher_domain: 'other-publisher.example' }],
              }],
            }),
            headers: { 'content-type': 'application/json' },
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const result = await manager.validateDomain('publisher.example');
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'managerdomain_scope')).toBe(true);
    });

    it('accepts managerdomain fallback when manager scopes via property_tags + property-level publisher_domain (Mediavine pattern)', async () => {
      // Real-world shape: properties[] carries publisher_domain, agents
      // reference properties indirectly via property_tags. The cross-
      // publisher commitment is declared, just routed through the
      // property layer.
      mockedSafeFetch.mockImplementation(async (url) => {
        if (url === 'https://publisher.example/.well-known/adagents.json') {
          return { status: 404, data: 'Not Found', headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://publisher.example/ads.txt') {
          return { status: 200, data: Buffer.from('MANAGERDOMAIN=manager.example\n'), headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://manager.example/.well-known/adagents.json') {
          return {
            status: 200,
            data: buf({
              properties: [{
                property_id: 'pub_main_site',
                property_type: 'website',
                publisher_domain: 'publisher.example',
                tags: ['scope3-aee', 'managed_network'],
              }],
              authorized_agents: [{
                url: 'https://agent.example',
                authorized_for: 'Display via tag',
                authorization_type: 'property_tags',
                property_tags: ['scope3-aee'],
              }],
            }),
            headers: { 'content-type': 'application/json' },
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const result = await manager.validateDomain('publisher.example');
      expect(result.valid).toBe(true);
      expect(result.discovery_method).toBe('ads_txt_managerdomain');
      expect(result.manager_domain).toBe('manager.example');
    });

    it('accepts managerdomain fallback when manager scopes via property_ids + property-level publisher_domain', async () => {
      mockedSafeFetch.mockImplementation(async (url) => {
        if (url === 'https://publisher.example/.well-known/adagents.json') {
          return { status: 404, data: 'Not Found', headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://publisher.example/ads.txt') {
          return { status: 200, data: Buffer.from('MANAGERDOMAIN=manager.example\n'), headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://manager.example/.well-known/adagents.json') {
          return {
            status: 200,
            data: buf({
              properties: [{
                property_id: 'pub_main_site',
                property_type: 'website',
                publisher_domain: 'publisher.example',
              }],
              authorized_agents: [{
                url: 'https://agent.example',
                authorized_for: 'Display via id',
                authorization_type: 'property_ids',
                property_ids: ['pub_main_site'],
              }],
            }),
            headers: { 'content-type': 'application/json' },
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const result = await manager.validateDomain('publisher.example');
      expect(result.valid).toBe(true);
      expect(result.discovery_method).toBe('ads_txt_managerdomain');
    });

    it('rejects fallback when property-level publisher_domain belongs to a different publisher', async () => {
      // The property carries publisher_domain, the agent points at it
      // by tag — but the property belongs to another publisher.
      // Cross-publisher confusion attack must still fail closed.
      mockedSafeFetch.mockImplementation(async (url) => {
        if (url === 'https://publisher.example/.well-known/adagents.json') {
          return { status: 404, data: 'Not Found', headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://publisher.example/ads.txt') {
          return { status: 200, data: Buffer.from('MANAGERDOMAIN=manager.example\n'), headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://manager.example/.well-known/adagents.json') {
          return {
            status: 200,
            data: buf({
              properties: [{
                property_id: 'someone_elses_site',
                publisher_domain: 'other-publisher.example',
                tags: ['scope3-aee'],
              }],
              authorized_agents: [{
                url: 'https://agent.example',
                authorized_for: 'Display via tag',
                authorization_type: 'property_tags',
                property_tags: ['scope3-aee'],
              }],
            }),
            headers: { 'content-type': 'application/json' },
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const result = await manager.validateDomain('publisher.example');
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'managerdomain_scope')).toBe(true);
    });

    it('rejects fallback when agent references a tag with no publisher-scoped property carrying it', async () => {
      // The publisher's property exists, but the agent points at a tag
      // that none of the publisher's properties carry. Must fail closed
      // — the agent has no scoping path back to the publisher.
      mockedSafeFetch.mockImplementation(async (url) => {
        if (url === 'https://publisher.example/.well-known/adagents.json') {
          return { status: 404, data: 'Not Found', headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://publisher.example/ads.txt') {
          return { status: 200, data: Buffer.from('MANAGERDOMAIN=manager.example\n'), headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://manager.example/.well-known/adagents.json') {
          return {
            status: 200,
            data: buf({
              properties: [{
                property_id: 'pub_main_site',
                publisher_domain: 'publisher.example',
                tags: ['display'],
              }],
              authorized_agents: [{
                url: 'https://agent.example',
                authorized_for: 'Video via different tag',
                authorization_type: 'property_tags',
                property_tags: ['video'],
              }],
            }),
            headers: { 'content-type': 'application/json' },
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const result = await manager.validateDomain('publisher.example');
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'managerdomain_scope')).toBe(true);
    });

    it('accepts managerdomain fallback when manager publisher_domain has non-canonical form (trailing dot, scheme prefix, mixed case)', async () => {
      // Code-reviewer SF2 / #4541: hasExplicitPublisherScope must produce
      // identical canonicalization across publisher_domain (singular),
      // publisher_domains[] (compact), collections[].publisher_domain, and
      // the property-level publisher_domain filter. A manifest with any of
      // these in DNS-canonical form (trailing dot) or with a stray scheme
      // prefix should still satisfy the gate.
      mockedSafeFetch.mockImplementation(async (url) => {
        if (url === 'https://publisher.example/.well-known/adagents.json') {
          return { status: 404, data: 'Not Found', headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://publisher.example/ads.txt') {
          return { status: 200, data: Buffer.from('MANAGERDOMAIN=manager.example\n'), headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://manager.example/.well-known/adagents.json') {
          return {
            status: 200,
            data: buf({
              authorized_agents: [{
                url: 'https://agent.example',
                authorized_for: 'Mixed non-canonical forms',
                authorization_type: 'publisher_properties',
                publisher_properties: [{
                  // Trailing dot, mixed case, scheme prefix — should all
                  // canonicalize to "publisher.example".
                  publisher_domains: ['Publisher.Example.', 'https://other.example'],
                  selection_type: 'by_tag',
                  property_tags: ['managed_network'],
                }],
              }],
            }),
            headers: { 'content-type': 'application/json' },
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const result = await manager.validateDomain('publisher.example');
      expect(result.valid).toBe(true);
      expect(result.discovery_method).toBe('ads_txt_managerdomain');
    });

    it('accepts managerdomain fallback via property-level path when properties[].publisher_domain has trailing dot', async () => {
      // The property-level fallback path also flows through
      // canonicalizePublisherDomain — locks that for trailing-dot forms.
      mockedSafeFetch.mockImplementation(async (url) => {
        if (url === 'https://publisher.example/.well-known/adagents.json') {
          return { status: 404, data: 'Not Found', headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://publisher.example/ads.txt') {
          return { status: 200, data: Buffer.from('MANAGERDOMAIN=manager.example\n'), headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://manager.example/.well-known/adagents.json') {
          return {
            status: 200,
            data: buf({
              properties: [{
                property_id: 'pub_main_site',
                property_type: 'website',
                // Trailing-dot DNS-canonical form.
                publisher_domain: 'publisher.example.',
                tags: ['scope3-aee'],
              }],
              authorized_agents: [{
                url: 'https://agent.example',
                authorized_for: 'Property-level path with canonical mismatch',
                authorization_type: 'property_tags',
                property_tags: ['scope3-aee'],
              }],
            }),
            headers: { 'content-type': 'application/json' },
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const result = await manager.validateDomain('publisher.example');
      expect(result.valid).toBe(true);
    });

    it('accepts managerdomain fallback when manager scopes via publisher_properties[].publisher_domains[] compact form', async () => {
      // Managed networks (Raptive/Cafemedia shape) declare scope across
      // many represented publishers in a single publisher_properties[]
      // entry using publisher_domains[]. The source publisher domain
      // appearing anywhere in that array satisfies the safety gate.
      mockedSafeFetch.mockImplementation(async (url) => {
        if (url === 'https://publisher.example/.well-known/adagents.json') {
          return { status: 404, data: 'Not Found', headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://publisher.example/ads.txt') {
          return { status: 200, data: Buffer.from('MANAGERDOMAIN=manager.example\n'), headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://manager.example/.well-known/adagents.json') {
          return {
            status: 200,
            data: buf({
              authorized_agents: [{
                url: 'https://agent.example',
                authorized_for: 'Managed network display inventory',
                authorization_type: 'publisher_properties',
                publisher_properties: [{
                  publisher_domains: ['other.example', 'publisher.example', 'third.example'],
                  selection_type: 'by_tag',
                  property_tags: ['managed_network'],
                }],
              }],
            }),
            headers: { 'content-type': 'application/json' },
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const result = await manager.validateDomain('publisher.example');
      expect(result.valid).toBe(true);
      expect(result.discovery_method).toBe('ads_txt_managerdomain');
    });

    it('rejects compact-form fallback when source publisher is NOT in publisher_domains[]', async () => {
      mockedSafeFetch.mockImplementation(async (url) => {
        if (url === 'https://publisher.example/.well-known/adagents.json') {
          return { status: 404, data: 'Not Found', headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://publisher.example/ads.txt') {
          return { status: 200, data: Buffer.from('MANAGERDOMAIN=manager.example\n'), headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://manager.example/.well-known/adagents.json') {
          return {
            status: 200,
            data: buf({
              authorized_agents: [{
                url: 'https://agent.example',
                authorized_for: 'Managed network — different publishers',
                authorization_type: 'publisher_properties',
                publisher_properties: [{
                  publisher_domains: ['other.example', 'third.example'],
                  selection_type: 'by_tag',
                  property_tags: ['managed_network'],
                }],
              }],
            }),
            headers: { 'content-type': 'application/json' },
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const result = await manager.validateDomain('publisher.example');
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'managerdomain_scope')).toBe(true);
    });

    it('does not crash when a publisher_properties[] entry omits publisher_domain (compact-form only)', async () => {
      // Regression: pre-PR code did `.publisher_domain.toLowerCase()`
      // unconditionally and threw TypeError on compact-form entries
      // where publisher_domain is undefined. The gate must degrade
      // gracefully instead of crashing.
      mockedSafeFetch.mockImplementation(async (url) => {
        if (url === 'https://publisher.example/.well-known/adagents.json') {
          return { status: 404, data: 'Not Found', headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://publisher.example/ads.txt') {
          return { status: 200, data: Buffer.from('MANAGERDOMAIN=manager.example\n'), headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://manager.example/.well-known/adagents.json') {
          return {
            status: 200,
            data: buf({
              authorized_agents: [{
                url: 'https://agent.example',
                authorized_for: 'Compact form only',
                authorization_type: 'publisher_properties',
                publisher_properties: [{
                  publisher_domains: ['publisher.example'],
                  selection_type: 'all',
                }],
              }],
            }),
            headers: { 'content-type': 'application/json' },
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const result = await manager.validateDomain('publisher.example');
      expect(result.valid).toBe(true);
    });

    it('does not trigger manager fallback on non-403/404 adagents responses', async () => {
      let calledAdsTxt = false;
      mockedSafeFetch.mockImplementation(async (url) => {
        if (url === 'https://publisher.example/.well-known/adagents.json') {
          return { status: 500, data: 'Server error', headers: { 'content-type': 'text/plain' } };
        }
        if (url === 'https://publisher.example/ads.txt') {
          calledAdsTxt = true;
          return { status: 200, data: Buffer.from('MANAGERDOMAIN=good.example\n'), headers: { 'content-type': 'text/plain' } };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const result = await manager.validateDomain('publisher.example');
      expect(result.valid).toBe(false);
      expect(calledAdsTxt).toBe(false);
      expect(result.errors.some(e => e.message.includes('HTTP 500'))).toBe(true);
    });

    it('handles network connection errors', async () => {
      mockedSafeFetch.mockRejectedValue(
        Object.assign(new Error('getaddrinfo ENOTFOUND nonexistent.example.com'), {
          cause: { code: 'ENOTFOUND' },
        })
      );

      const result = await manager.validateDomain('nonexistent.example.com');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'connection')).toBe(true);
    });

    it('handles request timeout', async () => {
      mockedSafeFetch.mockRejectedValue(
        Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
      );

      const result = await manager.validateDomain('slow.example.com');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'timeout')).toBe(true);
    });

    it('detects missing authorized_agents field', async () => {
      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: buf({ $schema: 'https://adcontextprotocol.org/schemas/v2/adagents.json' }),
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'authorized_agents')).toBe(true);
    });

    it('detects invalid authorized_agents type', async () => {
      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: buf({ authorized_agents: 'not an array' }),
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('must be an array'))).toBe(true);
    });

    it('warns about missing optional $schema field', async () => {
      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: buf({ authorized_agents: [{ url: 'https://agent.example.com', authorized_for: 'Test', authorization_type: 'property_ids', property_ids: ['p1'] }] }),
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.field === '$schema')).toBe(true);
    });

    it('warns about missing last_updated field', async () => {
      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: buf({ authorized_agents: [{ url: 'https://agent.example.com', authorized_for: 'Test', authorization_type: 'property_ids', property_ids: ['p1'] }] }),
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.field === 'last_updated')).toBe(true);
    });
  });

  describe('validateAgent', () => {
    it('validates required url field', async () => {
      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: buf({ authorized_agents: [{ authorized_for: 'Test' }] }),
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field.includes('.url') && e.message.includes('required'))).toBe(true);
    });

    it('validates url is a valid URL', async () => {
      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: buf({
          authorized_agents: [
            {
              url: 'not-a-valid-url',
              authorized_for: 'Test',
            },
          ],
        }),
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field.includes('.url') && e.message.includes('valid URL'))).toBe(true);
    });

    it('requires HTTPS for agent URLs', async () => {
      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: buf({
          authorized_agents: [
            {
              url: 'http://agent.example.com',
              authorized_for: 'Test',
            },
          ],
        }),
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('must use HTTPS'))).toBe(true);
    });

    it('validates required authorized_for field', async () => {
      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: buf({
          authorized_agents: [
            {
              url: 'https://agent.example.com',
            },
          ],
        }),
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field.includes('.authorized_for') && e.message.includes('required'))).toBe(true);
    });

    it('validates authorized_for is not empty', async () => {
      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: buf({
          authorized_agents: [
            {
              url: 'https://agent.example.com',
              authorized_for: '',
            },
          ],
        }),
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com');

      // Empty string is treated as missing/required in JavaScript (falsy check)
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field.includes('.authorized_for') && e.message.includes('required'))).toBe(true);
    });

    it('validates authorized_for length constraint', async () => {
      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: buf({
          authorized_agents: [
            {
              url: 'https://agent.example.com',
              authorized_for: 'a'.repeat(501),
            },
          ],
        }),
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('500 characters or less'))).toBe(true);
    });

    it('validates property_ids is an array', async () => {
      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: buf({
          authorized_agents: [
            {
              url: 'https://agent.example.com',
              authorized_for: 'Test',
              property_ids: 'not-an-array',
            },
          ],
        }),
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field.includes('.property_ids') && e.message.includes('must be an array'))).toBe(true);
    });

    it('warns about duplicate agent URLs', async () => {
      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: buf({
          authorized_agents: [
            {
              url: 'https://agent.example.com',
              authorized_for: 'Scope 1',
              authorization_type: 'property_ids',
              property_ids: ['p1'],
            },
            {
              url: 'https://agent.example.com',
              authorized_for: 'Scope 2',
              authorization_type: 'property_ids',
              property_ids: ['p2'],
            },
          ],
        }),
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(true); // Valid but with warning
      expect(result.warnings.some(w => w.message.includes('Duplicate agent URL'))).toBe(true);
    });

    // Issue #4476: validator was returning valid:true on wonderstruck.org-
    // style files that omit authorization_type. Per the v3 schema, every
    // authorized_agents[] entry must declare authorization_type plus a
    // matching non-empty selector — without that pairing, downstream
    // resolvers can't decide what the agent is authorized for, and
    // publishers see "valid" while consumers see "agent not authorized".
    it('rejects authorized_agents entries that omit authorization_type (issue #4476)', async () => {
      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: buf({
          $schema: 'https://adcontextprotocol.org/schemas/v3/adagents.json',
          authorized_agents: [
            { url: 'https://wonderstruck.sales-agent.scope3.com', authorized_for: 'Authorized for display banners' },
            { url: 'https://interchange.io', authorized_for: 'Authorized for display banners' },
          ],
          properties: [
            { property_id: 'main_site', property_type: 'website', name: 'Main site', identifiers: [{ type: 'domain', value: 'wonderstruck.org' }], tags: ['sites'] },
          ],
          last_updated: '2026-05-03T14:32:20.587Z',
        }),
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('wonderstruck.org');

      expect(result.valid).toBe(false);
      // Per-entry error with field path so publishers can locate the
      // missing field, plus enum list so they know which selectors to
      // choose from.
      expect(result.errors.some(e =>
        e.field === 'authorized_agents[0].authorization_type' &&
        e.message.includes('missing required field') &&
        e.message.includes('authorization_type') &&
        e.message.includes('property_ids') &&
        e.message.includes('signal_tags')
      )).toBe(true);
      expect(result.errors.some(e => e.field === 'authorized_agents[1].authorization_type')).toBe(true);
    });

    it('rejects authorized_agents entries whose authorization_type lacks a matching selector', async () => {
      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: buf({
          authorized_agents: [
            { url: 'https://agent.example.com', authorized_for: 'Test', authorization_type: 'property_ids' },
          ],
        }),
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.field === 'authorized_agents[0].property_ids' &&
        e.message.includes('missing or empty')
      )).toBe(true);
    });

    it('rejects authorized_agents entries whose authorization_type selector is an empty array', async () => {
      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: buf({
          authorized_agents: [
            { url: 'https://agent.example.com', authorized_for: 'Test', authorization_type: 'signal_tags', signal_tags: [] },
          ],
        }),
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.field === 'authorized_agents[0].signal_tags' &&
        e.message.includes('missing or empty')
      )).toBe(true);
    });
  });

  describe('validateAgentCards', () => {
    it('validates agent cards successfully', async () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://agent.example.com',
          authorized_for: 'Test',
        },
      ];

      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: buf({
          name: 'Test Agent',
          capabilities: ['media-buy'],
        }),
        headers: { 'content-type': 'application/json' },
      });

      const results = await manager.validateAgentCards(agents);

      expect(results).toHaveLength(1);
      expect(results[0].valid).toBe(true);
      expect(results[0].agent_url).toBe('https://agent.example.com');
      expect(results[0].card_endpoint).toBeDefined();
    });

    it('tries both standard and root endpoints', async () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://agent.example.com',
          authorized_for: 'Test',
        },
      ];

      let callCount = 0;
      mockedSafeFetch.mockImplementation((url) => {
        callCount++;
        if (url === 'https://agent.example.com/.well-known/agent-card.json') {
          return Promise.resolve({
            status: 404,
            data: {},
            headers: {},
          });
        }
        return Promise.resolve({
          status: 200,
          data: buf({ name: 'Agent' }),
          headers: { 'content-type': 'application/json' },
        });
      });

      const results = await manager.validateAgentCards(agents);

      expect(callCount).toBeGreaterThan(1);
      expect(results[0].valid).toBe(true);
    });

    it('detects missing agent cards', async () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://agent.example.com',
          authorized_for: 'Test',
        },
      ];

      // A2A endpoints (GET) return 404, MCP preflight (POST) fails so the
      // MCP path bails out before the live @adcp/sdk import.
      mockedSafeFetch.mockImplementation(async (_url, opts) => {
        if (opts?.method === 'POST') {
          throw new Error('Network error');
        }
        return { status: 404, data: buf({}), headers: {} };
      });

      const results = await manager.validateAgentCards(agents);

      expect(results[0].valid).toBe(false);
      // Error is prefixed with A2A: since both protocols are tried
      expect(results[0].errors.some(e => e.includes('No agent card found'))).toBe(true);
    }, 20000);

    it('detects wrong content-type for agent card', async () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://agent.example.com',
          authorized_for: 'Test',
        },
      ];

      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: buf({ name: 'Agent' }),
        headers: { 'content-type': 'text/plain' },
      });

      const results = await manager.validateAgentCards(agents);

      expect(results[0].valid).toBe(false);
      // SUT must hit the "JSON parsed but wrong content-type" branch (parsed
      // is an object, content-type isn't application/json) — not the
      // "couldn't parse at all" fallback. Pin the exact message so the test
      // doesn't silently start passing through the wrong path.
      expect(results[0].errors.some(e => e.includes('Should be application/json'))).toBe(true);
    }, 10000);

    it('detects HTML instead of JSON', async () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://agent.example.com',
          authorized_for: 'Test',
        },
      ];

      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: Buffer.from('<html><body>Website</body></html>'),
        headers: { 'content-type': 'text/html' },
      });

      const results = await manager.validateAgentCards(agents);

      expect(results[0].valid).toBe(false);
      expect(results[0].errors.some(e => e.includes('HTML instead of JSON'))).toBe(true);
    }, 10000);

    it('validates multiple agents in parallel', async () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://agent1.example.com',
          authorized_for: 'Test 1',
        },
        {
          url: 'https://agent2.example.com',
          authorized_for: 'Test 2',
        },
      ];

      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: buf({ name: 'Agent' }),
        headers: { 'content-type': 'application/json' },
      });

      const results = await manager.validateAgentCards(agents);

      expect(results).toHaveLength(2);
      // Pin valid:true so the parallel test exercises the JSON-parse success
      // path, not a silently-broken Buffer.from(plainObject) fallback.
      expect(results[0].valid).toBe(true);
      expect(results[1].valid).toBe(true);
      expect(results[0].agent_url).toBe('https://agent1.example.com');
      expect(results[1].agent_url).toBe('https://agent2.example.com');
    });
  });

  describe('createAdAgentsJson', () => {
    it('creates valid adagents.json with all options', () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://agent.example.com',
          authorized_for: 'Test authorization scope',
        },
      ];

      const json = manager.createAdAgentsJson(agents, true, true);
      const parsed = JSON.parse(json);

      expect(parsed.$schema).toBe('https://adcontextprotocol.org/schemas/v3/adagents.json');
      expect(parsed.authorized_agents).toEqual(agents);
      expect(parsed.last_updated).toBeDefined();
      expect(new Date(parsed.last_updated).toISOString()).toBe(parsed.last_updated);
    });

    it('creates adagents.json without schema', () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://agent.example.com',
          authorized_for: 'Test',
        },
      ];

      const json = manager.createAdAgentsJson(agents, false, true);
      const parsed = JSON.parse(json);

      expect(parsed.$schema).toBeUndefined();
    });

    it('creates adagents.json without timestamp', () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://agent.example.com',
          authorized_for: 'Test',
        },
      ];

      const json = manager.createAdAgentsJson(agents, true, false);
      const parsed = JSON.parse(json);

      expect(parsed.last_updated).toBeUndefined();
    });

    it('formats JSON with proper indentation', () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://agent.example.com',
          authorized_for: 'Test',
        },
      ];

      const json = manager.createAdAgentsJson(agents, true, true);

      expect(json).toContain('  '); // Contains 2-space indentation
      expect(json.split('\n').length).toBeGreaterThan(1); // Multiple lines
    });

    it('round-trips v3 agent fields (exclusive, countries, effective_from/until, signing_keys)', () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://agent.example.com',
          authorized_for: 'Premium inventory',
          exclusive: true,
          countries: ['US', 'CA', 'GB'],
          effective_from: '2025-01-01T00:00:00.000Z',
          effective_until: '2025-12-31T23:59:59.000Z',
          signing_keys: [{ kid: 'key-1', kty: 'OKP', crv: 'Ed25519', x: 'base64urlvalue' }],
        },
      ];

      const json = manager.createAdAgentsJson(agents, true, true);
      const parsed = JSON.parse(json);
      const agent = parsed.authorized_agents[0];

      expect(agent.exclusive).toBe(true);
      expect(agent.countries).toEqual(['US', 'CA', 'GB']);
      expect(agent.effective_from).toBe('2025-01-01T00:00:00.000Z');
      expect(agent.effective_until).toBe('2025-12-31T23:59:59.000Z');
      expect(agent.signing_keys).toHaveLength(1);
      expect(agent.signing_keys[0].kid).toBe('key-1');
      expect(agent.signing_keys[0].kty).toBe('OKP');
    });
  });

  describe('URL Reference Support', () => {
    it('follows URL reference to authoritative file', async () => {
      const referenceData = {
        $schema: 'https://adcontextprotocol.org/schemas/v2/adagents.json',
        authoritative_location: 'https://cdn.example.com/adagents.json',
        last_updated: '2025-01-15T10:00:00Z'
      };

      const authoritativeData = {
        $schema: 'https://adcontextprotocol.org/schemas/v3/adagents.json',
        authorized_agents: [
          {
            url: 'https://agent.example.com',
            authorized_for: 'Test authorization',
            authorization_type: 'property_ids',
            property_ids: ['p1'],
          },
        ],
        last_updated: '2025-01-15T09:00:00Z'
      };

      let callCount = 0;
      mockedSafeFetch.mockImplementation((url) => {
        callCount++;
        if (url.includes('/.well-known/adagents.json')) {
          return Promise.resolve({
            status: 200,
            data: buf(referenceData),
            headers: { 'content-type': 'application/json' },
          });
        } else if (url === 'https://cdn.example.com/adagents.json') {
          return Promise.resolve({
            status: 200,
            data: buf(authoritativeData),
            headers: { 'content-type': 'application/json' },
          });
        }
        return Promise.reject(new Error('Unexpected URL'));
      });

      const result = await manager.validateDomain('example.com');

      expect(callCount).toBe(2); // Two requests: initial + authoritative
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.discovery_method).toBe('authoritative_location');
    });

    it('rejects non-HTTPS authoritative locations', async () => {
      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: buf({
          authoritative_location: 'http://insecure.example.com/adagents.json',
        }),
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'authoritative_location' && e.message.includes('HTTPS'))).toBe(true);
    });

    it('rejects invalid authoritative locations', async () => {
      mockedSafeFetch.mockResolvedValue({
        status: 200,
        data: buf({
          authoritative_location: 'not-a-valid-url',
        }),
        headers: { 'content-type': 'application/json' },
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'authoritative_location' && e.message.includes('valid URL'))).toBe(true);
    });

    it('handles 404 from authoritative location', async () => {
      const referenceData = {
        authoritative_location: 'https://cdn.example.com/adagents.json',
      };

      mockedSafeFetch.mockImplementation((url) => {
        if (url.includes('/.well-known/adagents.json')) {
          return Promise.resolve({
            status: 200,
            data: buf(referenceData),
            headers: { 'content-type': 'application/json' },
          });
        } else {
          return Promise.resolve({
            status: 404,
            data: 'Not Found',
            headers: { 'content-type': 'text/html' },
          });
        }
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'authoritative_location' && e.message.includes('File not found'))).toBe(true);
    });

    it('prevents nested URL references (infinite loop protection)', async () => {
      const referenceData1 = {
        authoritative_location: 'https://cdn.example.com/adagents.json',
      };

      const referenceData2 = {
        authoritative_location: 'https://cdn2.example.com/adagents.json',
      };

      mockedSafeFetch.mockImplementation((url) => {
        if (url.includes('/.well-known/adagents.json')) {
          return Promise.resolve({
            status: 200,
            data: buf(referenceData1),
            headers: { 'content-type': 'application/json' },
          });
        } else if (url === 'https://cdn.example.com/adagents.json') {
          return Promise.resolve({
            status: 200,
            data: buf(referenceData2),
            headers: { 'content-type': 'application/json' },
          });
        }
        return Promise.reject(new Error('Unexpected URL'));
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('nested references not allowed'))).toBe(true);
    });

    it('handles network errors fetching authoritative file', async () => {
      const referenceData = {
        authoritative_location: 'https://cdn.example.com/adagents.json',
      };

      mockedSafeFetch.mockImplementation((url) => {
        if (url.includes('/.well-known/adagents.json')) {
          return Promise.resolve({
            status: 200,
            data: buf(referenceData),
            headers: { 'content-type': 'application/json' },
          });
        } else {
          return Promise.reject(new Error('Network error'));
        }
      });

      const result = await manager.validateDomain('example.com');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'authoritative_location')).toBe(true);
    });
  });

  describe('MCP Protocol Support', () => {
    it('falls back to MCP when A2A endpoints return 404', { timeout: 15000 }, async () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://mcp-agent.example.com/mcp',
          authorized_for: 'Test',
        },
      ];

      // A2A endpoints (GET) return 404, MCP preflight (POST) returns 200 with valid JSON-RPC
      mockedSafeFetch.mockImplementation(async (_url, opts) => {
        if (opts?.method === 'POST') {
          return {
            status: 200,
            data: buf({ jsonrpc: '2.0', result: {} }),
            headers: { 'content-type': 'application/json' },
          };
        }
        return { status: 404, data: buf({}), headers: {} };
      });

      // vi.doMock does not intercept dynamic imports inside the SUT.
      // The MCP path tries to use the real @adcp/sdk which will fail.
      // This test validates that combined error reporting works when both A2A and MCP fail.
      const results = await manager.validateAgentCards(agents);

      const postCall = mockedSafeFetch.mock.calls.find(([, opts]) => opts?.method === 'POST');
      expect(postCall).toBeDefined();
      expect(postCall?.[1]?.headers).toMatchObject({
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      });
      expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'AAO Registry Validator', version: '1.0.0' },
        },
        id: 1,
      });

      // With the real @adcp/sdk unable to connect, MCP validation will fail
      // and the result captures errors from both protocols
      expect(results[0].valid).toBe(false);
      expect(results[0].errors.some((e) => e.includes('A2A') || e.includes('agent card'))).toBe(true);
      expect(results[0].errors.some((e) => e.includes('MCP'))).toBe(true);
    });

    it('marks MCP agents as auth-required when the preflight returns 401', async () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://private-mcp.example.com/mcp',
          authorized_for: 'Test',
        },
      ];

      mockedSafeFetch.mockImplementation(async (_url, opts) => {
        if (opts?.method === 'POST') {
          return {
            status: 401,
            data: buf({ error: 'unauthorized' }),
            headers: { 'content-type': 'application/json' },
          };
        }
        return { status: 404, data: buf({}), headers: {} };
      });

      const results = await manager.validateAgentCards(agents);

      expect(results[0].valid).toBe(true);
      expect(results[0].oauth_required).toBe(true);
      expect(results[0].card_data).toMatchObject({
        protocol: 'mcp',
        requires_auth: true,
      });
    });

    it('returns combined errors when both A2A and MCP fail', async () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://broken-agent.example.com',
          authorized_for: 'Test',
        },
      ];

      // A2A endpoints (GET) return 404, MCP preflight (POST) fails
      mockedSafeFetch.mockImplementation(async (_url, opts) => {
        if (opts?.method === 'POST') {
          throw new Error('Network error');
        }
        return { status: 404, data: buf({}), headers: {} };
      });

      const results = await manager.validateAgentCards(agents);

      expect(results[0].valid).toBe(false);
      expect(results[0].errors.some((e) => e.includes('A2A') || e.includes('agent card'))).toBe(true);
      expect(results[0].errors.some((e) => e.includes('MCP'))).toBe(true);
    });
  });

  describe('validateProposed', () => {
    it('validates proposed agents without making HTTP requests', () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://agent.example.com',
          authorized_for: 'Test authorization scope',
          authorization_type: 'property_ids',
          property_ids: ['p1'],
        },
      ];

      const result = manager.validateProposed(agents);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.domain).toBe('proposed');
      expect(mockedSafeFetch).not.toHaveBeenCalled();
    });

    it('detects invalid agents in proposal', () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'http://insecure.example.com', // HTTP not HTTPS
          authorized_for: 'Test',
        },
      ];

      const result = manager.validateProposed(agents);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('must use HTTPS'))).toBe(true);
    });

    it('detects empty authorized_for in proposal', () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://agent.example.com',
          authorized_for: '',
        },
      ];

      const result = manager.validateProposed(agents);

      // Empty string is treated as missing/required in JavaScript (falsy check)
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field.includes('.authorized_for') && e.message.includes('required'))).toBe(true);
    });

    it('accepts valid v3 agent fields', () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://agent.example.com',
          authorized_for: 'Premium inventory',
          authorization_type: 'property_ids',
          property_ids: ['p1'],
          exclusive: true,
          countries: ['US', 'CA'],
          effective_from: '2025-01-01T00:00:00.000Z',
          effective_until: '2025-12-31T23:59:59.000Z',
          signing_keys: [{ kid: 'key-1', kty: 'OKP', crv: 'Ed25519', x: 'base64urlvalue' }],
        },
      ];

      const result = manager.validateProposed(agents);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects invalid country codes in proposal', () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://agent.example.com',
          authorized_for: 'Test',
          countries: ['us', 'USA'] as any,
        },
      ];

      const result = manager.validateProposed(agents);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field.includes('.countries') && e.message.includes('ISO 3166-1 alpha-2'))).toBe(true);
    });

    it('rejects effective_until before effective_from', () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://agent.example.com',
          authorized_for: 'Test',
          effective_from: '2025-06-01T00:00:00.000Z',
          effective_until: '2025-01-01T00:00:00.000Z',
        },
      ];

      const result = manager.validateProposed(agents);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field.includes('.effective_until'))).toBe(true);
    });

    it('rejects malformed signing_keys entries', () => {
      const agents: AuthorizedAgent[] = [
        {
          url: 'https://agent.example.com',
          authorized_for: 'Test',
          signing_keys: [{ kty: 'OKP' } as any],
        },
      ];

      const result = manager.validateProposed(agents);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field.includes('.signing_keys') && e.message.includes('kid'))).toBe(true);
    });

    it('accepts an empty authorized_agents array when catalog content is present (catalog-only mirror)', () => {
      const result = manager.validateProposed({
        agents: [],
        catalogEtag: 'meta-community-2026-06-04',
        properties: [
          {
            property_id: 'example_site',
            property_type: 'website',
            name: 'Example Site',
            identifiers: [{ type: 'domain', value: 'example.com' }],
            publisher_domain: 'example.com',
          },
        ] as any,
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      // The "no authorized agents" advisory must not fire for a catalog-only mirror.
      expect(result.warnings.some(w => w.field === 'authorized_agents')).toBe(false);
    });

    it('suppresses the no-agents warning for a formats-only catalog mirror', () => {
      const result = manager.validateProposed({
        agents: [],
        catalogEtag: 'meta-community-2026-06-04',
        formats: [
          {
            format_option_id: 'example_image',
            display_name: 'Example Image',
            format_kind: 'image',
          },
        ] as any,
      });

      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.field === 'authorized_agents')).toBe(false);
    });

    it('warns when authorized_agents is empty and there is no catalog content', () => {
      const result = manager.validateProposed({ agents: [] });

      // A file carrying neither sales authorization nor catalog content is
      // structurally valid but meaningless, so it warns (not errors).
      expect(result.warnings.some(w => w.field === 'authorized_agents')).toBe(true);
    });
  });

  describe('Signals Support', () => {
    describe('validateSignal', () => {
      it('validates a valid binary signal', async () => {
        mockedSafeFetch.mockResolvedValue({
          status: 200,
          data: buf({
            authorized_agents: [
              { url: 'https://agent.example.com', authorized_for: 'Test', authorization_type: 'property_ids', property_ids: ['p1'] },
            ],
            signals: [
              {
                id: 'likely_tesla_buyers',
                name: 'Likely Tesla Buyers',
                value_type: 'binary',
                category: 'purchase_intent',
              },
            ],
          }),
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('validates a valid categorical signal', async () => {
        mockedSafeFetch.mockResolvedValue({
          status: 200,
          data: buf({
            authorized_agents: [
              { url: 'https://agent.example.com', authorized_for: 'Test', authorization_type: 'property_ids', property_ids: ['p1'] },
            ],
            signals: [
              {
                id: 'vehicle_ownership',
                name: 'Vehicle Ownership',
                value_type: 'categorical',
                allowed_values: ['tesla', 'bmw', 'mercedes'],
              },
            ],
          }),
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('validates a valid numeric signal with range', async () => {
        mockedSafeFetch.mockResolvedValue({
          status: 200,
          data: buf({
            authorized_agents: [
              { url: 'https://agent.example.com', authorized_for: 'Test', authorization_type: 'property_ids', property_ids: ['p1'] },
            ],
            signals: [
              {
                id: 'purchase_propensity',
                name: 'Purchase Propensity Score',
                value_type: 'numeric',
                range: { min: 0, max: 100, unit: 'score' },
              },
            ],
          }),
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('detects missing signal id', async () => {
        mockedSafeFetch.mockResolvedValue({
          status: 200,
          data: buf({
            authorized_agents: [
              { url: 'https://agent.example.com', authorized_for: 'Test', authorization_type: 'property_ids', property_ids: ['p1'] },
            ],
            signals: [
              {
                name: 'Missing ID Signal',
                value_type: 'binary',
              },
            ],
          }),
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.field === 'signals[0].id' && e.message.includes('required'))).toBe(true);
      });

      it('detects invalid signal id pattern', async () => {
        mockedSafeFetch.mockResolvedValue({
          status: 200,
          data: buf({
            authorized_agents: [
              { url: 'https://agent.example.com', authorized_for: 'Test', authorization_type: 'property_ids', property_ids: ['p1'] },
            ],
            signals: [
              {
                id: 'invalid id with spaces',
                name: 'Invalid ID Signal',
                value_type: 'binary',
              },
            ],
          }),
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.field === 'signals[0].id' && e.message.includes('alphanumeric'))).toBe(true);
      });

      it('detects missing signal name', async () => {
        mockedSafeFetch.mockResolvedValue({
          status: 200,
          data: buf({
            authorized_agents: [
              { url: 'https://agent.example.com', authorized_for: 'Test', authorization_type: 'property_ids', property_ids: ['p1'] },
            ],
            signals: [
              {
                id: 'test_signal',
                value_type: 'binary',
              },
            ],
          }),
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.field === 'signals[0].name' && e.message.includes('required'))).toBe(true);
      });

      it('detects invalid value_type', async () => {
        mockedSafeFetch.mockResolvedValue({
          status: 200,
          data: buf({
            authorized_agents: [
              { url: 'https://agent.example.com', authorized_for: 'Test', authorization_type: 'property_ids', property_ids: ['p1'] },
            ],
            signals: [
              {
                id: 'test_signal',
                name: 'Test Signal',
                value_type: 'invalid_type',
              },
            ],
          }),
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.field === 'signals[0].value_type' && e.message.includes('binary, categorical, numeric'))).toBe(true);
      });

      it('warns about categorical signal without allowed_values', async () => {
        mockedSafeFetch.mockResolvedValue({
          status: 200,
          data: buf({
            authorized_agents: [
              { url: 'https://agent.example.com', authorized_for: 'Test', authorization_type: 'property_ids', property_ids: ['p1'] },
            ],
            signals: [
              {
                id: 'vehicle_type',
                name: 'Vehicle Type',
                value_type: 'categorical',
              },
            ],
          }),
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(true);
        expect(result.warnings.some(w => w.field === 'signals[0].allowed_values')).toBe(true);
      });

      it('validates numeric signal range min > max', async () => {
        mockedSafeFetch.mockResolvedValue({
          status: 200,
          data: buf({
            authorized_agents: [
              { url: 'https://agent.example.com', authorized_for: 'Test', authorization_type: 'property_ids', property_ids: ['p1'] },
            ],
            signals: [
              {
                id: 'score',
                name: 'Score',
                value_type: 'numeric',
                range: { min: 100, max: 0 },
              },
            ],
          }),
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.field === 'signals[0].range' && e.message.includes('cannot be greater'))).toBe(true);
      });

      it('validates standard signal category', async () => {
        mockedSafeFetch.mockResolvedValue({
          status: 200,
          data: buf({
            authorized_agents: [
              { url: 'https://agent.example.com', authorized_for: 'Test', authorization_type: 'property_ids', property_ids: ['p1'] },
            ],
            signals: [
              {
                id: 'test_signal',
                name: 'Test Signal',
                value_type: 'binary',
                category: 'purchase_intent',
              },
            ],
          }),
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(true);
        expect(result.warnings.filter(w => w.field === 'signals[0].category')).toHaveLength(0);
      });

      it('warns about non-standard signal category', async () => {
        mockedSafeFetch.mockResolvedValue({
          status: 200,
          data: buf({
            authorized_agents: [
              { url: 'https://agent.example.com', authorized_for: 'Test', authorization_type: 'property_ids', property_ids: ['p1'] },
            ],
            signals: [
              {
                id: 'test_signal',
                name: 'Test Signal',
                value_type: 'binary',
                category: 'my_custom_category',
              },
            ],
          }),
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(true);
        expect(result.warnings.some(w => w.field === 'signals[0].category' && w.message.includes('not a standard category'))).toBe(true);
      });

      it('errors when signal category is not a string', async () => {
        mockedSafeFetch.mockResolvedValue({
          status: 200,
          data: buf({
            authorized_agents: [
              { url: 'https://agent.example.com', authorized_for: 'Test', authorization_type: 'property_ids', property_ids: ['p1'] },
            ],
            signals: [
              {
                id: 'test_signal',
                name: 'Test Signal',
                value_type: 'binary',
                category: 123,
              },
            ],
          }),
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.field === 'signals[0].category' && e.message.includes('must be a string'))).toBe(true);
      });
    });

    describe('signal_tags validation', () => {
      it('validates valid signal_tags', async () => {
        mockedSafeFetch.mockResolvedValue({
          status: 200,
          data: buf({
            authorized_agents: [
              { url: 'https://agent.example.com', authorized_for: 'Test', authorization_type: 'property_ids', property_ids: ['p1'] },
            ],
            signals: [
              { id: 'test', name: 'Test', value_type: 'binary', tags: ['automotive'] },
            ],
            signal_tags: {
              automotive: { name: 'Automotive', description: 'Vehicle-related signals' },
            },
          }),
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(true);
      });

      it('warns about signal tags used but not defined', async () => {
        mockedSafeFetch.mockResolvedValue({
          status: 200,
          data: buf({
            authorized_agents: [
              { url: 'https://agent.example.com', authorized_for: 'Test', authorization_type: 'property_ids', property_ids: ['p1'] },
            ],
            signals: [
              { id: 'test', name: 'Test', value_type: 'binary', tags: ['undefined_tag'] },
            ],
          }),
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(true);
        expect(result.warnings.some(w => w.message.includes('undefined_tag'))).toBe(true);
      });

      it('detects duplicate signal IDs', async () => {
        mockedSafeFetch.mockResolvedValue({
          status: 200,
          data: buf({
            authorized_agents: [
              { url: 'https://agent.example.com', authorized_for: 'Test', authorization_type: 'property_ids', property_ids: ['p1'] },
            ],
            signals: [
              { id: 'duplicate_id', name: 'Signal 1', value_type: 'binary' },
              { id: 'duplicate_id', name: 'Signal 2', value_type: 'binary' },
            ],
          }),
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(true); // Warning, not error
        expect(result.warnings.some(w => w.message.includes('Duplicate signal ID'))).toBe(true);
      });
    });

    describe('signal authorization types', () => {
      it('validates signal_ids authorization type', async () => {
        mockedSafeFetch.mockResolvedValue({
          status: 200,
          data: buf({
            authorized_agents: [
              {
                url: 'https://agent.example.com',
                authorized_for: 'Automotive signals',
                authorization_type: 'signal_ids',
                signal_ids: ['likely_tesla_buyers'],
              },
            ],
            signals: [
              { id: 'likely_tesla_buyers', name: 'Likely Tesla Buyers', value_type: 'binary' },
            ],
          }),
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('validates signal_tags authorization type', async () => {
        mockedSafeFetch.mockResolvedValue({
          status: 200,
          data: buf({
            authorized_agents: [
              {
                url: 'https://agent.example.com',
                authorized_for: 'All automotive signals',
                authorization_type: 'signal_tags',
                signal_tags: ['automotive'],
              },
            ],
            signals: [
              { id: 'test', name: 'Test', value_type: 'binary', tags: ['automotive'] },
            ],
            signal_tags: {
              automotive: { name: 'Automotive', description: 'Vehicle signals' },
            },
          }),
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(true);
      });

      it('warns when signal_ids authorization has no matching signals', async () => {
        mockedSafeFetch.mockResolvedValue({
          status: 200,
          data: buf({
            authorized_agents: [
              {
                url: 'https://agent.example.com',
                authorized_for: 'Test',
                authorization_type: 'signal_ids',
                signal_ids: ['nonexistent_signal'],
              },
            ],
            signals: [
              { id: 'actual_signal', name: 'Actual Signal', value_type: 'binary' },
            ],
          }),
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(true);
        expect(result.warnings.some(w => w.message.includes('nonexistent_signal'))).toBe(true);
      });

      it('errors when signal_ids authorization type but no signal_ids array (v3 schema)', async () => {
        mockedSafeFetch.mockResolvedValue({
          status: 200,
          data: buf({
            authorized_agents: [
              {
                url: 'https://agent.example.com',
                authorized_for: 'Test',
                authorization_type: 'signal_ids',
              },
            ],
          }),
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        // v3 schema requires a non-empty signal_ids selector when
        // authorization_type is 'signal_ids' — see issue #4476.
        expect(result.valid).toBe(false);
        expect(result.errors.some(e =>
          e.field === 'authorized_agents[0].signal_ids' &&
          e.message.includes('missing or empty')
        )).toBe(true);
      });

      it('errors when signal_ids is not an array', async () => {
        mockedSafeFetch.mockResolvedValue({
          status: 200,
          data: buf({
            authorized_agents: [
              {
                url: 'https://agent.example.com',
                authorized_for: 'Test',
                signal_ids: 'not-an-array',
              },
            ],
          }),
          headers: { 'content-type': 'application/json' },
        });

        const result = await manager.validateDomain('polk.com');

        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.field.includes('.signal_ids') && e.message.includes('must be an array'))).toBe(true);
      });
    });

    describe('createAdAgentsJson with signals', () => {
      it('creates adagents.json with signals', () => {
        const agents: AuthorizedAgent[] = [
          {
            url: 'https://agent.example.com',
            authorized_for: 'All Polk automotive signals',
            authorization_type: 'signal_tags',
            signal_tags: ['automotive'],
          },
        ];

        const signals = [
          {
            id: 'likely_tesla_buyers',
            name: 'Likely Tesla Buyers',
            value_type: 'binary' as const,
            category: 'purchase_intent',
            tags: ['automotive'],
          },
        ];

        const signalTags = {
          automotive: { name: 'Automotive', description: 'Vehicle-related signals' },
        };

        const json = manager.createAdAgentsJson(agents, true, true, undefined, signals, signalTags);
        const parsed = JSON.parse(json);

        expect(parsed.signals).toHaveLength(1);
        expect(parsed.signals[0].id).toBe('likely_tesla_buyers');
        expect(parsed.signal_tags).toBeDefined();
        expect(parsed.signal_tags.automotive.name).toBe('Automotive');
      });

      it('creates adagents.json without signals when not provided', () => {
        const agents: AuthorizedAgent[] = [
          {
            url: 'https://agent.example.com',
            authorized_for: 'Test',
          },
        ];

        const json = manager.createAdAgentsJson(agents, true, true);
        const parsed = JSON.parse(json);

        expect(parsed.signals).toBeUndefined();
        expect(parsed.signal_tags).toBeUndefined();
      });

      it('creates adagents.json using options object', () => {
        const json = manager.createAdAgentsJson({
          agents: [
            {
              url: 'https://agent.example.com',
              authorized_for: 'All signals',
              authorization_type: 'signal_tags',
              signal_tags: ['automotive'],
            },
          ],
          signals: [
            {
              id: 'likely_ev_buyers',
              name: 'Likely EV Buyers',
              value_type: 'binary',
              category: 'purchase_intent',
              tags: ['automotive'],
            },
          ],
          signalTags: {
            automotive: { name: 'Automotive', description: 'Vehicle signals' },
          },
          includeSchema: true,
          includeTimestamp: false,
        });
        const parsed = JSON.parse(json);

        expect(parsed.$schema).toBe('https://adcontextprotocol.org/schemas/v3/adagents.json');
        expect(parsed.last_updated).toBeUndefined();
        expect(parsed.signals).toHaveLength(1);
        expect(parsed.signals[0].id).toBe('likely_ev_buyers');
        expect(parsed.signal_tags.automotive.name).toBe('Automotive');
      });

      it('options object includeSchema defaults to true', () => {
        const json = manager.createAdAgentsJson({
          agents: [
            {
              url: 'https://agent.example.com',
              authorized_for: 'Test',
            },
          ],
        });
        const parsed = JSON.parse(json);

        expect(parsed.$schema).toBe('https://adcontextprotocol.org/schemas/v3/adagents.json');
        expect(parsed.last_updated).toBeDefined();
      });

      it('creates adagents.json with formats, placements, and placement tags', () => {
        const json = manager.createAdAgentsJson({
          agents: [
            {
              url: 'https://agent.example.com',
              authorized_for: 'Homepage inventory',
              authorization_type: 'property_ids',
              property_ids: ['homepage'],
            },
          ],
          properties: [
            {
              property_id: 'homepage',
              property_type: 'website',
              name: 'Homepage',
              identifiers: [{ type: 'domain', value: 'example.com' }],
            },
          ],
          formats: [
            {
              format_option_id: 'homepage_mrec_image',
              format_kind: 'image',
              params: { width: 300, height: 250 },
            },
          ],
          placements: [
            {
              placement_id: 'homepage_mrec',
              name: 'Homepage MREC',
              property_ids: ['homepage'],
              format_options: [{ format_option_id: 'homepage_mrec_image' }],
            },
          ],
          placementTags: {
            homepage: { name: 'Homepage', description: 'Homepage placements' },
          },
          includeTimestamp: false,
        });
        const parsed = JSON.parse(json);

        expect(parsed.formats[0].format_option_id).toBe('homepage_mrec_image');
        expect(parsed.placements[0].format_options[0].format_option_id).toBe('homepage_mrec_image');
        expect(parsed.placement_tags.homepage.name).toBe('Homepage');
      });

      it('rejects placement format refs that do not resolve to top-level formats', () => {
        const result = manager.validateProposed({
          agents: [
            {
              url: 'https://agent.example.com',
              authorized_for: 'Homepage inventory',
              authorization_type: 'property_ids',
              property_ids: ['homepage'],
            },
          ],
          properties: [
            {
              property_id: 'homepage',
              property_type: 'website',
              name: 'Homepage',
              identifiers: [{ type: 'domain', value: 'example.com' }],
            },
          ],
          placements: [
            {
              placement_id: 'homepage_mrec',
              name: 'Homepage MREC',
              property_ids: ['homepage'],
              format_options: [{ format_option_id: 'missing_format' }],
            },
          ],
        });

        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.field === 'placements[0].format_options[0].format_option_id')).toBe(true);
      });
    });
  });
});
