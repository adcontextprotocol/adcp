import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { isRegistryDomain } from '../server/src/services/registry-domain.js';
import { CatalogResolveRequestSchema } from '../server/src/schemas/catalog-resolve.js';

const schemaRoot = resolve(import.meta.dirname, '../static/schemas/source');
const ajv = new Ajv({ strict: false });
ajv.addSchema(JSON.parse(readFileSync(`${schemaRoot}/enums/identifier-types.json`, 'utf8')));
const validate = ajv.compile(JSON.parse(readFileSync(`${schemaRoot}/core/identifier.json`, 'utf8')));

describe('property identifier hostnames', () => {
  it('enforces the same rules in list creation, updates, exclusions, and resolved pages', async () => {
    const schemaAt = (path: string) => JSON.parse(readFileSync(`${schemaRoot}/${path}`, 'utf8'));
    const compiler = new Ajv({ strict: false, loadSchema: async uri => schemaAt(uri.replace('/schemas/', '').split('#')[0]) });
    addFormats(compiler);
    const create = await compiler.compileAsync(schemaAt('property/create-property-list-request.json'));
    const update = await compiler.compileAsync(schemaAt('property/update-property-list-request.json'));
    const getResponse = await compiler.compileAsync(schemaAt('property/get-property-list-response.json'));
    for (const [value, expected] of [['*.publisher.example', true], ['https://publisher.example/path', false]] as const) {
      const identifier = { type: 'domain', value };
      const sources = [{ selection_type: 'identifiers', identifiers: [identifier] }];
      const request = { name: 'Property list', list_id: 'pl_test', idempotency_key: 'test-property-list-1234' };
      expect(create({ ...request, base_properties: sources })).toBe(expected);
      expect(update({ ...request, base_properties: sources })).toBe(expected);
      expect(create({ ...request, filters: { exclude_identifiers: [identifier] } })).toBe(expected);
      expect(update({ ...request, filters: { exclude_identifiers: [identifier] } })).toBe(expected);
      expect(getResponse({ status: 'completed', list: { list_id: 'pl_test', name: 'Property list' }, identifiers: [identifier] })).toBe(expected);
    }
  });

  it.each(['example.com', 'news.publisher.example', '*.example.com', 'xn--bcher-kva.example', 'a-b.example', '3news.example'])(
    'accepts a domain selector: %s', value => expect(validate({ type: 'domain', value })).toBe(true),
  );

  it.each([
    'https://www.example.com/path', 'example.com/path', 'example.com:443',
    'example.com?query', 'example.com#fragment', ' example.com', 'example.com ',
    'example.com\n', 'Example.com', 'example.com.', 'example..com',
    '-news.example', 'news-.example', 'news_site.example', 'localhost', '',
    '*example.com', 'news.*.example', '*.*.example', 'bücher.example',
    `${'a'.repeat(64)}.example`,
  ])('rejects malformed domain and subdomain values: %s', value => {
    for (const type of ['domain', 'subdomain']) expect(validate({ type, value }), `${type}: ${value}`).toBe(false);
    expect(isRegistryDomain(value, { sandbox: true, wildcard: true })).toBe(false);
  });

  it('permits wildcard selectors only for domain and enforces hostname length without the prefix', () => {
    expect(validate({ type: 'subdomain', value: '*.example.com' })).toBe(false);
    const hostname = [63, 63, 63, 61].map(length => 'a'.repeat(length)).join('.');
    expect(hostname).toHaveLength(253);
    for (const prefix of ['', '*.']) {
      expect(validate({ type: 'domain', value: prefix + hostname })).toBe(true);
      expect(validate({ type: 'domain', value: prefix + hostname + 'a' })).toBe(false);
    }
    expect(validate({ type: 'subdomain', value: hostname })).toBe(true);
  });

  it('leaves other identifier types unchanged', () => {
    expect(validate({ type: 'rss_url', value: 'https://publisher.example/feed.xml' })).toBe(true);
    expect(validate({ type: 'station_id', value: 'Pinnacle Radio' })).toBe(true);
  });

  it.each(['publisher.example', 'publisher.test', 'publisher.invalid', 'site.localhost', 'site.local', 'site.onion', 'example.com', 'news.example.net', '*.example.org'])(
    'restricts reserved test names to sandbox contributions: %s', value => {
      expect(isRegistryDomain(value, { wildcard: true })).toBe(false);
      expect(isRegistryDomain(value, { sandbox: true, wildcard: true })).toBe(true);
    },
  );

  it('keeps production hostnames distinct from reserved suffix lookalikes', () => {
    expect(isRegistryDomain('publisher.example.com.evil.com')).toBe(true);
    expect(isRegistryDomain('testpublisher.com')).toBe(true);
    expect(isRegistryDomain('127.0.0.1', { sandbox: true })).toBe(false);
    expect(isRegistryDomain('*.publisher.com')).toBe(false);
  });

  it('rejects a mixed production batch atomically and requires a JSON boolean sandbox flag', () => {
    const body = {
      identifiers: [{ type: 'domain', value: 'publisher.com' }, { type: 'domain', value: 'publisher.example' }],
      provenance: { type: 'agency_allowlist' },
    };
    expect(CatalogResolveRequestSchema.safeParse(body).success).toBe(false);
    expect(CatalogResolveRequestSchema.safeParse({ ...body, sandbox: true }).success).toBe(true);
    for (const sandbox of ['true', 'false', null, 1]) {
      expect(CatalogResolveRequestSchema.safeParse({ ...body, sandbox }).success).toBe(false);
    }
  });
});
