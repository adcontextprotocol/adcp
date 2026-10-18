import { z } from 'zod';
import { isRegistryDomain } from '../services/registry-domain.js';

// Shared by runtime validation and the generated OpenAPI request contract.
export const CatalogResolveRequestSchema = z.object({
  identifiers: z.array(z.object({
    type: z.string().min(1),
    value: z.string().min(1),
  })).min(1).max(10000).describe('Identifiers to resolve (and, in resolve mode, contribute). Max 10,000 per call for all callers.'),
  provenance: z.object({
    type: z.enum([
      'agency_allowlist', 'publisher_declaration', 'impression_log',
      'ssp_inventory', 'deal_history', 'crawl', 'data_partner', 'member_assertion',
    ]).describe('How the caller knows these identifiers — the trust/audit envelope on the fact. Determines the confidence the catalog assigns. crawl is reserved for server-side pipelines; callers use the others.'),
    context: z.string().optional().describe('Optional free-text annotation (campaign, dataset).'),
  }),
  mode: z.enum(['resolve', 'lookup']).default('resolve').describe(
    'resolve (default) contributes identifiers, creates missing catalog entries, and logs activity; authentication is required. lookup is a public read with no writes or activity logging.',
  ),
  sandbox: z.boolean().default(false).describe(
    'Simulate contributions without storing properties, identifiers, facts, or activity. Reads existing catalog data; new handles are ephemeral. Reserved test domains are allowed only in sandbox mode.',
  ),
}).superRefine((request, ctx) => {
  request.identifiers.forEach((identifier, index) => {
    if ((identifier.type === 'domain' || identifier.type === 'subdomain')
      && !isRegistryDomain(identifier.value, { sandbox: request.sandbox, wildcard: identifier.type === 'domain' })) {
      ctx.addIssue({
        code: 'custom',
        path: ['identifiers', index, 'value'],
        message: 'Expected a lowercase hostname without a URL, port, whitespace, or trailing dot; reserved domains require sandbox: true',
      });
    }
  });
});
