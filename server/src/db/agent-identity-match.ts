/**
 * Identity-keyed matching against `member_profiles.agents[]` (#8322).
 *
 * `member_profiles.agents` is the one registry store whose agent-URL key
 * lives inside JSONB, so SQL cannot fold the stored side: canonicalizing
 * agent URLs in the database is banned (see the header of
 * `registry-agent-url-key.ts`), and the fold is not expressible as a `jsonb`
 * containment anyway. A reader can only ask for every spelling that folds to
 * the same identity key — `registryAgentUrlKeySpellings` — and OR the
 * containment tests together, which is what this builds.
 *
 * Why the ownership and badge predicates fold at all. After #8249 and #7830
 * made `/mcp` and `/mcp/` one agent, every per-agent surface addresses the
 * agent by its folded key, while an owner's profile may hold either spelling
 * (rows predate the fold, and the admin profile writer produced unkeyed rows
 * until this change). An owner who registered the other spelling was then
 * denied on their own agent: no dashboard, no compliance refresh, no badge.
 * Folding IDENTITY here is what `registryAgentUrlKey`'s own classification
 * calls for — `member_profiles.agents[].url` is listed under IDENTITY.
 *
 * What this does NOT change:
 *
 *   - **Org scoping.** Every caller keeps its `workos_organization_id` /
 *     `organization_memberships` predicate exactly as it was. Folding widens
 *     which SPELLING of one agent a profile may hold, never which profile a
 *     user may reach. A member still gains nothing over an agent that only
 *     another org registered.
 *   - **`declared_url`.** The containment payload keys on `url` only, so the
 *     spec-exact AUTHORIZATION spelling (#7829) can never decide identity.
 *   - **Authorization matching.** Whether an `adagents.json` entry authorizes
 *     an agent URL stays spec-exact via `declaredAgentUrl` — the validator,
 *     the directory reads, `/publishers` and `/domains` must not use this.
 */
import { registryAgentUrlKeySpellings } from './registry-agent-url-key.js';

/** A parenthesized `OR` of `@>` tests plus the parameters it refers to. */
export interface AgentIdentityContainment {
  /** e.g. `(mp.agents @> $2::jsonb OR mp.agents @> $3::jsonb)` */
  sql: string;
  /**
   * JSONB payloads, in placeholder order. `params[0]` is always the payload
   * an exact-match reader would have used — the identity key, or the raw
   * input when the key rejects it — so a query that has to pick ONE row out
   * of several can order by `<column> @> $<primaryPlaceholder>::jsonb DESC`
   * and keep choosing what it chose before the fold.
   */
  params: string[];
  /** Placeholder index of `params[0]`; equals the `firstPlaceholder` given. */
  primaryPlaceholder: number;
  /** The next free placeholder index for the rest of the query. */
  nextPlaceholder: number;
}

/**
 * Column references are code-controlled in every call site; refuse anything
 * that is not a bare identifier (optionally alias-qualified) so this can
 * never become a SQL-injection seam if a future caller passes input through.
 */
const SAFE_COLUMN = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

/**
 * `(<column> @> $n::jsonb OR …)` matching a profile that holds ANY spelling
 * of `agentUrl`'s registry identity, with the payloads to bind.
 *
 * `firstPlaceholder` is the 1-based index of the first parameter this filter
 * owns; callers that already bind an org id or user id pass the next free
 * index and read `nextPlaceholder` back for whatever follows. The SQL text is
 * assembled from placeholder indexes only — no caller-supplied string reaches
 * it. Always parenthesized, so an `AND` added later cannot rebind against the
 * `OR` and silently widen the predicate.
 *
 * One `@>` per spelling rather than a single `?|`/`@?` so the GIN index on
 * `member_profiles.agents` (migration 014) still serves the lookup. The
 * spelling set is small by construction (at most three).
 */
export function agentIdentityContainment(
  column: string,
  agentUrl: string,
  firstPlaceholder: number,
): AgentIdentityContainment {
  if (!SAFE_COLUMN.test(column)) {
    throw new Error(`Unsafe agents column reference: ${column}`);
  }
  // Non-empty by contract: an input the key rejects yields just that input.
  const spellings = registryAgentUrlKeySpellings(agentUrl);
  const sql = `(${spellings
    .map((_, i) => `${column} @> $${firstPlaceholder + i}::jsonb`)
    .join(' OR ')})`;
  return {
    sql,
    params: spellings.map((spelling) => JSON.stringify([{ url: spelling }])),
    primaryPlaceholder: firstPlaceholder,
    nextPlaceholder: firstPlaceholder + spellings.length,
  };
}
