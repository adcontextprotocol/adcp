/**
 * The registry's agent-URL key (#7830).
 *
 * The key is AdCP URL canonicalization, so the cases that matter are the ones
 * where the old `lower(trim(url))`-and-strip-slashes rule disagreed with the
 * spec: path case, a non-root trailing slash, a default port, dot segments,
 * percent-encoding and IDN hosts. Each of those is a class of agent the old
 * key either merged with another agent or failed to match at all.
 */
import { describe, expect, it } from 'vitest';
import {
  legacyRegistryAgentUrlKey,
  registryAgentUrlKey,
  registryAgentUrlKeySpellings,
  registryAgentUrlLookupKey,
} from '../../src/db/registry-agent-url-key.js';
import { canonicalizeAgentUrl } from '../../src/db/publisher-db.js';

describe('registryAgentUrlKey', () => {
  it('lowercases the scheme and host and trims surrounding whitespace', () => {
    expect(registryAgentUrlKey(' HTTPS://Agent.Example/mcp ')).toBe('https://agent.example/mcp');
  });

  it('keeps path case significant, so case variants are different agents', () => {
    expect(registryAgentUrlKey('https://agent.example/tenants/Acme/mcp'))
      .toBe('https://agent.example/tenants/Acme/mcp');
    expect(registryAgentUrlKey('https://agent.example/tenants/Acme/mcp'))
      .not.toBe(registryAgentUrlKey('https://agent.example/tenants/acme/mcp'));
    // The old key merged them. That is the bug.
    expect(legacyRegistryAgentUrlKey('https://agent.example/tenants/Acme/mcp'))
      .toBe(legacyRegistryAgentUrlKey('https://agent.example/tenants/acme/mcp'));
  });

  it('folds a trailing slash off the path, at the root and below it', () => {
    // Registry identity only: /mcp and /mcp/ are one agent. Authorization
    // matching keeps them distinct — registry-identity-vs-authorization.test.ts.
    expect(registryAgentUrlKey('https://agent.example/mcp/')).toBe('https://agent.example/mcp');
    expect(registryAgentUrlKey('https://agent.example/mcp')).toBe('https://agent.example/mcp');
    expect(registryAgentUrlKey('https://agent.example/MCP///')).toBe('https://agent.example/MCP');
    expect(registryAgentUrlKey('https://agent.example/')).toBe('https://agent.example');
    expect(registryAgentUrlKey('https://agent.example')).toBe('https://agent.example');
    expect(registryAgentUrlKey('https://agent.example//')).toBe('https://agent.example');
    expect(registryAgentUrlKey('https://agent.example/'))
      .toBe(legacyRegistryAgentUrlKey('https://agent.example/'));
  });

  it('keeps the root slash when a query follows it, and drops it below the root', () => {
    // Without the slash `https://agent.example?t=1` would not read as a
    // query against a path.
    expect(registryAgentUrlKey('https://agent.example/?t=1')).toBe('https://agent.example/?t=1');
    expect(registryAgentUrlKey('https://agent.example/mcp/?t=1'))
      .toBe('https://agent.example/mcp?t=1');
  });

  it('drops a default port and keeps a non-default one', () => {
    expect(registryAgentUrlKey('https://agent.example:443/mcp')).toBe('https://agent.example/mcp');
    expect(registryAgentUrlKey('http://agent.example:80/mcp')).toBe('http://agent.example/mcp');
    expect(registryAgentUrlKey('https://agent.example:8443/mcp'))
      .toBe('https://agent.example:8443/mcp');
    expect(registryAgentUrlKey('https://[::1]:443/mcp')).toBe('https://[::1]/mcp');
  });

  it('resolves dot segments', () => {
    expect(registryAgentUrlKey('https://agent.example/a/./b/../c')).toBe('https://agent.example/a/c');
  });

  it('decodes percent-encoded unreserved characters and uppercases the rest', () => {
    expect(registryAgentUrlKey('https://agent.example/%7Euser')).toBe('https://agent.example/~user');
    expect(registryAgentUrlKey('https://agent.example/%7euser')).toBe('https://agent.example/~user');
    expect(registryAgentUrlKey('https://agent.example/%2f')).toBe('https://agent.example/%2F');
  });

  it('converts an IDN host to its A-label', () => {
    expect(registryAgentUrlKey('https://bücher.example/mcp'))
      .toBe('https://xn--bcher-kva.example/mcp');
    expect(registryAgentUrlKey('https://bücher.example/mcp'))
      .toBe(registryAgentUrlKey('https://xn--bcher-kva.example/mcp'));
  });

  it('drops a fragment and a fully-qualifying root label', () => {
    expect(registryAgentUrlKey('https://agent.example/mcp#frag')).toBe('https://agent.example/mcp');
    expect(registryAgentUrlKey('https://agent.example./mcp')).toBe('https://agent.example/mcp');
    expect(registryAgentUrlKey('https://agent.example../mcp')).toBeNull();
  });

  it('preserves the query byte for byte, including a bare trailing "?"', () => {
    expect(registryAgentUrlKey('https://agent.example/mcp?b=2&a=1'))
      .toBe('https://agent.example/mcp?b=2&a=1');
    // adcp-client#3084: an empty query is part of the target URI, so the
    // root-slash rule does not apply and the '/' stays.
    expect(registryAgentUrlKey('https://agent.example?')).toBe('https://agent.example/?');
    expect(registryAgentUrlKey('https://agent.example/mcp?')).toBe('https://agent.example/mcp?');
  });

  it('passes the wildcard sentinel through and rejects any other wildcard', () => {
    expect(registryAgentUrlKey('*')).toBe('*');
    expect(registryAgentUrlKey(' * ')).toBe('*');
    for (const raw of ['**', '*.example.com', 'https://agent.example/*']) {
      expect(registryAgentUrlKey(raw)).toBeNull();
    }
  });

  it('rejects anything that cannot be a registry agent URL', () => {
    const rejected = [
      '', '   ',
      'agent.example/mcp',            // no scheme
      'https:agent.example/mcp',      // no authority form
      'ftp://agent.example/x',        // not http(s)
      'https:///mcp',                 // empty authority
      'https://user:pw@agent.example/mcp',
      'https://@agent.example/mcp',
      'https://agent.example\\mcp',   // backslash folds to '/' under WHATWG
      'https://agent.example/m cp',
      'https://agent.example/m\tcp',
      'https://agent.example/m\u007fcp',
    ];
    for (const raw of rejected) {
      expect(registryAgentUrlKey(raw), raw).toBeNull();
    }
  });

  it('is idempotent — keying a key returns the same key', () => {
    const raws = [
      'HTTPS://Agent.Example:443/a/./b/../%7Ec/',
      'https://agent.example/mcp/',
      'https://agent.example',
      'https://agent.example/mcp?',
      '*',
    ];
    for (const raw of raws) {
      const key = registryAgentUrlKey(raw);
      expect(key, raw).not.toBeNull();
      expect(registryAgentUrlKey(key as string), raw).toBe(key);
    }
  });

  it('falls back to the raw input only in the lookup helper', () => {
    expect(registryAgentUrlLookupKey('agent.example/mcp')).toBe('agent.example/mcp');
    expect(registryAgentUrlLookupKey('https://Agent.Example/')).toBe('https://agent.example');
  });

  it('is the function publisher-db exports as canonicalizeAgentUrl', () => {
    expect(canonicalizeAgentUrl).toBe(registryAgentUrlKey);
  });
});

describe('legacyRegistryAgentUrlKey', () => {
  it('reproduces the pre-migration key exactly', () => {
    expect(legacyRegistryAgentUrlKey(' HTTPS://Agent.Example/MCP/// '))
      .toBe('https://agent.example/mcp');
    expect(legacyRegistryAgentUrlKey('https://agent.example/mcp#frag'))
      .toBe('https://agent.example/mcp#frag');
    expect(legacyRegistryAgentUrlKey('*')).toBe('*');
    expect(legacyRegistryAgentUrlKey('***')).toBeNull();
    expect(legacyRegistryAgentUrlKey('')).toBeNull();
    expect(legacyRegistryAgentUrlKey('///')).toBeNull();
    // It accepted values that are not URLs at all — the reason unkeyable rows
    // exist in the registry today.
    expect(legacyRegistryAgentUrlKey('agent.example/mcp')).toBe('agent.example/mcp');
  });
});

describe('registryAgentUrlKeySpellings', () => {
  it('returns the folded key and the trailing-slash spelling of one agent', () => {
    expect(new Set(registryAgentUrlKeySpellings('https://agent.example/mcp')))
      .toEqual(new Set(['https://agent.example/mcp', 'https://agent.example/mcp/']));
    expect(new Set(registryAgentUrlKeySpellings('https://agent.example/mcp/')))
      .toEqual(new Set(['https://agent.example/mcp', 'https://agent.example/mcp/']));
  });

  it('keeps the caller spelling when canonicalization changed more than the slash', () => {
    expect(new Set(registryAgentUrlKeySpellings(' HTTPS://Agent.Example:443/MCP/ ')))
      .toEqual(new Set([
        'https://agent.example/MCP',
        'HTTPS://Agent.Example:443/MCP/',
        'https://agent.example/MCP/',
      ]));
  });

  it('covers the root path, whose key carries no slash at all', () => {
    expect(new Set(registryAgentUrlKeySpellings('https://agent.example/')))
      .toEqual(new Set(['https://agent.example', 'https://agent.example/']));
  });

  it('never widens past one agent: every spelling keys back to the same identity', () => {
    for (const raw of [
      'https://agent.example/mcp',
      'https://agent.example/mcp/',
      'https://agent.example',
      'https://agent.example/?t=1',
      'https://agent.example?t=1',
      'https://agent.example/mcp?t=1',
      'https://agent.example/mcp//',
      'https://agent.example/a/../mcp',
      'https://bücher.example/mcp/',
      '*',
    ]) {
      const key = registryAgentUrlKey(raw);
      const spellings = registryAgentUrlKeySpellings(raw);
      expect(spellings.length).toBeGreaterThan(0);
      expect(new Set(spellings).size).toBe(spellings.length);
      for (const spelling of spellings) {
        expect(registryAgentUrlKey(spelling)).toBe(key);
      }
    }
  });

  it('puts the slash back on the path, never inside the query', () => {
    expect(new Set(registryAgentUrlKeySpellings('https://agent.example/mcp?t=1')))
      .toEqual(new Set(['https://agent.example/mcp?t=1', 'https://agent.example/mcp/?t=1']));
    expect(registryAgentUrlKeySpellings('https://agent.example/mcp?t=1'))
      .not.toContain('https://agent.example/mcp?t=1/');
  });

  it('inverts the root-with-query case, whose key keeps the slash for the query', () => {
    expect(new Set(registryAgentUrlKeySpellings('https://agent.example/?t=1')))
      .toEqual(new Set(['https://agent.example/?t=1', 'https://agent.example?t=1']));
  });

  it('grows no second spelling for the wildcard sentinel', () => {
    expect(registryAgentUrlKeySpellings('*')).toEqual(['*']);
  });

  it('falls back to the raw input for a URL the key rejects, like the lookup key', () => {
    expect(registryAgentUrlKeySpellings('agent.example/mcp')).toEqual(['agent.example/mcp']);
    expect(registryAgentUrlKeySpellings('agent.example/mcp'))
      .toContain(registryAgentUrlLookupKey('agent.example/mcp'));
  });
});
