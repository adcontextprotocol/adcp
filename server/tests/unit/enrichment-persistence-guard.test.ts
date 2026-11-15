import { describe, expect, it } from 'vitest';
import {
  classifyEnrichmentDomain,
  decideEnrichmentPersistence,
  getRegistrableDomain,
  isReservedDomain,
} from '../../src/services/enrichment-persistence-guard.js';

describe('enrichment persistence guard (#9024)', () => {
  describe('reserved names', () => {
    it.each([
      'example.com',
      'example.net',
      'example.org',
      'novabrands-ai-9384-20260918t0035z.example.org',
      'shop.example.com',
      'acme.example',
      'acme.test',
      'acme.invalid',
      'acme.localhost',
      'HTTPS://Sub.Example.Org/path',
    ])('treats %s as reserved', (domain) => {
      expect(isReservedDomain(domain)).toBe(true);
      expect(classifyEnrichmentDomain(domain).rejection).toBe('reserved_name');
    });

    it.each(['acme.com', 'notexample.com', 'example.co', 'myexample.org', 'test.com'])(
      'does not treat %s as reserved',
      (domain) => {
        expect(isReservedDomain(domain)).toBe(false);
      },
    );
  });

  describe('registrable domains', () => {
    it('finds the eTLD+1 with the Public Suffix List', () => {
      expect(getRegistrableDomain('e2e-1787388722440-443399.novabrands.com')).toBe('novabrands.com');
      expect(getRegistrableDomain('shop.acme.co.uk')).toBe('acme.co.uk');
      expect(getRegistrableDomain('acme.co.uk')).toBe('acme.co.uk');
      expect(getRegistrableDomain('www.acme.com')).toBe('acme.com');
    });

    it('rejects subdomains and accepts registrable domains', () => {
      expect(classifyEnrichmentDomain('sandbox.novabrands.com')).toMatchObject({
        domain: 'sandbox.novabrands.com',
        registrable_domain: 'novabrands.com',
        rejection: 'not_registrable_domain',
      });
      expect(classifyEnrichmentDomain('novabrands.com').rejection).toBeUndefined();
      expect(classifyEnrichmentDomain('acme.co.uk').rejection).toBeUndefined();
      // www. is the apex in this registry, matching canonicalizeBrandDomain.
      expect(classifyEnrichmentDomain('www.acme.com')).toMatchObject({ domain: 'acme.com' });
      expect(classifyEnrichmentDomain('www.acme.com').rejection).toBeUndefined();
    });

    it('rejects names that are not domains', () => {
      expect(classifyEnrichmentDomain('localhost').rejection).toBe('invalid_domain');
      expect(classifyEnrichmentDomain('co.uk').rejection).toBe('not_registrable_domain');
      expect(classifyEnrichmentDomain('').rejection).toBe('invalid_domain');
    });
  });

  describe('decideEnrichmentPersistence', () => {
    it('saves an authenticated lookup of a registrable domain that Brandfetch answered for itself', () => {
      expect(decideEnrichmentPersistence({
        requestedDomain: 'acme.com',
        brandfetchDomain: 'acme.com',
        authenticated: true,
      })).toEqual({ persist: true, domain: 'acme.com' });
    });

    it('never saves a reserved name, even for an authenticated caller', () => {
      expect(decideEnrichmentPersistence({
        requestedDomain: 'novabrands-20260918-233121.example.org',
        brandfetchDomain: 'novabrands-20260918-233121.example.org',
        authenticated: true,
      })).toMatchObject({ persist: false, reason: 'reserved_name' });
    });

    it('never saves a subdomain, under itself or under its parent', () => {
      const decision = decideEnrichmentPersistence({
        requestedDomain: 'e2e-1787388722440-443399.novabrands.com',
        brandfetchDomain: 'novabrands.com',
        authenticated: true,
      });
      expect(decision).toEqual({
        persist: false,
        domain: 'e2e-1787388722440-443399.novabrands.com',
        reason: 'not_registrable_domain',
        registrable_domain: 'novabrands.com',
      });
    });

    it('does not save a result Brandfetch answered with another domain', () => {
      expect(decideEnrichmentPersistence({
        requestedDomain: 'novabrands.net',
        brandfetchDomain: 'novabrands.com',
        authenticated: true,
      })).toMatchObject({ persist: false, reason: 'brand_domain_mismatch' });
    });

    it('ignores a www. difference in the Brandfetch domain', () => {
      expect(decideEnrichmentPersistence({
        requestedDomain: 'acme.com',
        brandfetchDomain: 'www.acme.com',
        authenticated: true,
      })).toEqual({ persist: true, domain: 'acme.com' });
    });

    it('does not let an unauthenticated lookup create a record', () => {
      expect(decideEnrichmentPersistence({
        requestedDomain: 'acme.com',
        brandfetchDomain: 'acme.com',
        authenticated: false,
        existingRecord: null,
      })).toMatchObject({ persist: false, reason: 'unauthenticated' });
    });

    it('lets an unauthenticated lookup refresh an enriched record that already exists', () => {
      expect(decideEnrichmentPersistence({
        requestedDomain: 'acme.com',
        brandfetchDomain: 'acme.com',
        authenticated: false,
        existingRecord: { source_type: 'enriched' },
      })).toEqual({ persist: true, domain: 'acme.com' });
    });

    it('does not let an unauthenticated lookup overwrite a stronger record', () => {
      expect(decideEnrichmentPersistence({
        requestedDomain: 'acme.com',
        brandfetchDomain: 'acme.com',
        authenticated: false,
        existingRecord: { source_type: 'community' },
      })).toMatchObject({ persist: false, reason: 'unauthenticated' });
    });
  });
});
