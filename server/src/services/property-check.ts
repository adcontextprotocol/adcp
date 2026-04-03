import { DomainClassificationsDatabase } from '../db/domain-classifications-db.js';
import { PropertyDatabase } from '../db/property-db.js';
import { CatalogDatabase } from '../db/catalog-db.js';

export interface CheckResultRemove {
  input: string;
  canonical: string;
  reason: 'duplicate' | 'blocked';
  domain_type?: string;
  blocked_reason?: string;
}

export interface CheckResultModify {
  input: string;
  canonical: string;
  reason: string;
}

export interface CheckResultAssess {
  domain: string;
}

export interface CheckResultOk {
  domain: string;
  source: string;
}

export interface CheckResult {
  summary: {
    total: number;
    remove: number;
    modify: number;
    assess: number;
    ok: number;
  };
  remove: CheckResultRemove[];
  modify: CheckResultModify[];
  assess: CheckResultAssess[];
  ok: CheckResultOk[];
}

const domainClassificationsDb = new DomainClassificationsDatabase();
const propertyDb = new PropertyDatabase();
const catalogDb = new CatalogDatabase();

interface NormalizeResult {
  canonical: string;
  reason: string | null; // null means unchanged
}

/**
 * Normalize a raw domain input to its canonical form.
 * Returns the canonical form and the reason code if the input was changed.
 */
function normalizeDomain(raw: string): NormalizeResult {
  const trimmed = raw.trim();

  // Strip protocol, path, query, fragment, trailing slash
  let canonical = trimmed
    .replace(/^https?:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.$/, '')   // trailing FQDN dot
    .replace(/\/$/, '')
    .toLowerCase();

  let reason: string | null = null;

  if (canonical.startsWith('www.')) {
    canonical = canonical.slice(4);
    reason = 'www_stripped';
  } else if (canonical.startsWith('m.')) {
    canonical = canonical.slice(2);
    reason = 'm_stripped';
  } else if (canonical !== trimmed.replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '').replace(/\.$/, '').replace(/\/$/, '').toLowerCase()) {
    reason = 'normalized';
  }

  return { canonical, reason };
}

export class PropertyCheckService {
  async check(domains: string[]): Promise<CheckResult> {
    const remove: CheckResultRemove[] = [];
    const modify: CheckResultModify[] = [];
    const assess: CheckResultAssess[] = [];
    const ok: CheckResultOk[] = [];

    // Step 1: normalize all inputs, track modifications, deduplicate
    const canonicalToFirstInput = new Map<string, string>(); // canonical → first input seen
    const toCheck: string[] = [];

    for (const input of domains) {
      if (!input || typeof input !== 'string') continue;

      const { canonical, reason } = normalizeDomain(input);
      if (!canonical) continue;

      if (canonicalToFirstInput.has(canonical)) {
        remove.push({ input, canonical, reason: 'duplicate' });
        continue;
      }

      canonicalToFirstInput.set(canonical, input);

      if (reason !== null) {
        modify.push({ input, canonical, reason });
      }

      toCheck.push(canonical);
    }

    if (toCheck.length === 0) {
      return {
        summary: { total: domains.length, remove: remove.length, modify: modify.length, assess: 0, ok: 0 },
        remove, modify, assess, ok,
      };
    }

    // Step 2: batch check against domain classifications
    const blocked = await domainClassificationsDb.checkDomains(toCheck);
    const afterBlockedCheck: string[] = [];

    for (const canonical of toCheck) {
      const blockedEntry = blocked.get(canonical);
      if (blockedEntry) {
        remove.push({
          input: canonicalToFirstInput.get(canonical) ?? canonical,
          canonical,
          reason: 'blocked',
          domain_type: blockedEntry.domain_type,
          blocked_reason: blockedEntry.reason ?? undefined,
        });
      } else {
        afterBlockedCheck.push(canonical);
      }
    }

    if (afterBlockedCheck.length === 0) {
      return {
        summary: { total: domains.length, remove: remove.length, modify: modify.length, assess: 0, ok: 0 },
        remove, modify, assess, ok,
      };
    }

    // Step 3: check against catalog + legacy registry
    const catalogInput = afterBlockedCheck.map(d => ({ type: 'domain', value: d }));
    const [catalogResults, catalogClassifications, registryResults] = await Promise.all([
      catalogDb.batchLookupIdentifiers(catalogInput),
      catalogDb.batchGetClassifications(afterBlockedCheck.map(d => `domain:${d}`)),
      propertyDb.checkDomainsInRegistry(afterBlockedCheck),
    ]);

    for (const canonical of afterBlockedCheck) {
      const catalogMatch = catalogResults.get(`domain:${canonical}`);
      const classification = catalogClassifications.get(`domain:${canonical}`);
      const registrySource = registryResults.get(canonical);

      // Catalog says ad_infra → remove
      if (catalogMatch?.classification === 'ad_infra' || catalogMatch?.classification === 'publisher_mask' ||
          classification === 'ad_infra' || classification === 'publisher_mask') {
        remove.push({
          input: canonicalToFirstInput.get(canonical) ?? canonical,
          canonical,
          reason: 'blocked',
          domain_type: catalogMatch?.classification || classification || 'ad_infra',
        });
      } else if (registrySource) {
        ok.push({ domain: canonical, source: registrySource });
      } else if (catalogMatch) {
        ok.push({ domain: canonical, source: 'catalog' });
      } else {
        assess.push({ domain: canonical });
      }
    }

    return {
      summary: {
        total: domains.length,
        remove: remove.length,
        modify: modify.length,
        assess: assess.length,
        ok: ok.length,
      },
      remove,
      modify,
      assess,
      ok,
    };
  }
}
