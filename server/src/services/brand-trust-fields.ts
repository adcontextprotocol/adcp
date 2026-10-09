/**
 * Trust fields in brand.json — the parts a verifier uses to decide who may
 * act for a domain, rather than what the brand looks like.
 *
 * AAO serves registry rows as brand.json (`/brands/:domain/brand.json`,
 * `/brand/:id/brand.json`). Only rows where control of the domain has been
 * demonstrated may carry trust fields there: a brand.json crawled from the
 * domain itself, or a hosted row owned by a verified organization. Community
 * and enriched rows are curated or scraped identity data; publishing
 * `authorized_operators`, agent keys, or portfolio claims from them would let
 * any registry editor speak for a domain they do not control.
 */

interface ProvenanceRow {
  source_type?: string | null;
  domain_verified?: boolean | null;
  workos_organization_id?: string | null;
}

type Manifest = Record<string, unknown>;

/** Trust keys that may appear at the document root. */
const ROOT_TRUST_KEYS = [
  'agents',
  'brand_agent',
  'rights_agent',
  'authorized_operators',
  'identity_relying_parties',
  'brand_refs',
] as const;

/** Trust keys that may appear on `house` and on each `brands[]` entry. */
const NESTED_TRUST_KEYS = ['agents', 'brand_agent', 'rights_agent', 'identity_relying_parties'] as const;

/** Mirrors DOMAIN_CONTROL_VERIFIED_SQL in db/brand-db.ts. */
export function isDomainControlVerified(row: ProvenanceRow): boolean {
  return row.source_type === 'brand_json'
    || (row.domain_verified === true && !!row.workos_organization_id);
}

function isRecord(value: unknown): value is Manifest {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withoutKeys(obj: Manifest, keys: readonly string[]): Manifest {
  const out = { ...obj };
  for (const key of keys) delete out[key];
  return out;
}

/**
 * Remove every trust field from a manifest. Pure; returns a new object.
 */
export function stripBrandTrustFields(manifest: Manifest): Manifest {
  const out = withoutKeys(manifest, ROOT_TRUST_KEYS);
  if (isRecord(out.house)) {
    out.house = withoutKeys(out.house, NESTED_TRUST_KEYS);
  }
  if (Array.isArray(out.brands)) {
    out.brands = out.brands.map((b) => (isRecord(b) ? withoutKeys(b, NESTED_TRUST_KEYS) : b));
  }
  return out;
}

/**
 * Remove the fields a signature verifier or relationship-trust resolver
 * relies on, while keeping URL-only agent listings for discovery.
 *
 * AAO's member-profile flow publishes an organization's hostname-verified
 * agents (`type`, `url`, `id`, `description` — never keys) into its registry
 * row, so those listings stay. Keys, operator delegation, relying parties,
 * portfolio claims, and the deprecated `brand_agent` / `rights_agent`
 * pointers (whose URL origin is itself a default key source) do not.
 */
export function stripUnattestedTrustFields(manifest: Manifest): Manifest {
  const out = withoutKeys(manifest, ['authorized_operators', 'identity_relying_parties', 'brand_refs']);
  const scrubAgents = (container: Manifest): Manifest => {
    const next = withoutKeys(container, ['identity_relying_parties', 'brand_agent', 'rights_agent']);
    if (Array.isArray(next.agents)) {
      next.agents = next.agents.map((a) => (isRecord(a) ? withoutKeys(a, ['jwks_uri']) : a));
    }
    return next;
  };
  const scrubbed = scrubAgents(out);
  if (isRecord(scrubbed.house)) scrubbed.house = scrubAgents(scrubbed.house);
  if (Array.isArray(scrubbed.brands)) {
    scrubbed.brands = scrubbed.brands.map((b) => (isRecord(b) ? scrubAgents(b) : b));
  }
  return scrubbed;
}

/** The manifest AAO may publish as brand.json for this row. */
export function publicBrandJsonManifest(row: ProvenanceRow, manifest: Manifest): Manifest {
  return isDomainControlVerified(row) ? manifest : stripUnattestedTrustFields(manifest);
}

/**
 * Replace the submitted manifest's trust fields with the prior manifest's.
 *
 * Content edits (community wiki edits, the brand builder) must not add,
 * change, or drop trust fields: those are written only by dedicated paths
 * (member-profile agent publishing, the owner's hosted-brand API, the
 * crawler). Carrying the prior values over also keeps a logo or color edit
 * from silently wiping an organization's agents.
 */
export function preserveBrandTrustFields(submitted: Manifest, prior: Manifest | null | undefined): Manifest {
  const out = stripBrandTrustFields(submitted);
  if (!prior) return out;

  for (const key of ROOT_TRUST_KEYS) {
    if (key in prior) out[key] = prior[key];
  }

  if (isRecord(prior.house) && isRecord(out.house)) {
    const house = { ...out.house };
    for (const key of NESTED_TRUST_KEYS) {
      if (key in prior.house) house[key] = prior.house[key];
    }
    out.house = house;
  }

  if (Array.isArray(prior.brands) && Array.isArray(out.brands)) {
    const priorById = new Map<string, Manifest>();
    for (const b of prior.brands) {
      if (isRecord(b) && typeof b.id === 'string') priorById.set(b.id, b);
    }
    out.brands = out.brands.map((b) => {
      if (!isRecord(b) || typeof b.id !== 'string') return b;
      const priorBrand = priorById.get(b.id);
      if (!priorBrand) return b;
      const next = { ...b };
      for (const key of NESTED_TRUST_KEYS) {
        if (key in priorBrand) next[key] = priorBrand[key];
      }
      return next;
    });
  }

  return out;
}
