/**
 * The registry's canonical key for an agent URL (#7830).
 *
 * Every store that keys on an agent URL — `catalog_agent_authorizations`,
 * `adagents_authorization_overrides`, `agent_registry_metadata`,
 * `agent_contexts`, `member_profiles.agents[].url` — and every reader that
 * looks a row up by agent URL MUST go through `registryAgentUrlKey`. The key
 * is AdCP URL canonicalization (docs/reference/url-canonicalization) with one
 * registry-local rule, documented on the function below.
 *
 * This module deliberately has no database imports: the migration script, the
 * read-only audit, the crawler, and the HTTP readers all share one algorithm,
 * and a SQL re-implementation would drift. SQL-side canonicalization of agent
 * URLs is therefore banned — queries take keys the app already computed.
 */
import { canonicalTargetUri } from '@adcp/sdk/signing';

/** Exact-match sentinel for "any agent"; never a URL. */
export const REGISTRY_AGENT_URL_WILDCARD = '*';

/**
 * Characters a canonical authority may contain. WHATWG parsing only rejects
 * its own forbidden-host set, which still lets `"`, backtick, `{` and `}`
 * through; the spec's UTS-46 pin (`UseSTD3ASCIIRules=true`) rejects them.
 * Narrowing here rather than at UTS-46 strictness keeps `_` and the
 * sub-delims that existing registry hosts rely on. Brackets and `:` are for
 * IPv6 literals and ports.
 *
 * This MUST stay in step with `chk_caa_agent_url_canonical` and
 * `chk_aao_agent_url_canonical` (migration 625): a key this accepts but the
 * constraint rejects is a publisher-triggerable write failure. The
 * integration test fuzzes the printable range to hold the two together.
 */
const CANONICAL_AUTHORITY = /^[a-z0-9._~!$&'()+,;=:[\]-]+$/;

/**
 * Characters that must never reach a stored key. Beyond C0 and DEL: the C1
 * block, and the Cf characters that are invisible or reorder the rendering
 * of the text around them. A zero-width space makes two keys that look
 * identical in every moderator UI; a bidi override reverses how a URL reads
 * in the UI that decides whether to suppress it. `[[:cntrl:]]` in the CHECK
 * covers C0/C1 but not Cf, so the app is the only place this can be closed.
 */
const FORBIDDEN_IN_KEY =
  /[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;

/**
 * RFC 3986 §6.2.2.2: percent-encoded unreserved characters are equivalent to
 * the characters themselves, and the hex digits are case-insensitive.
 */
function normalizePercentEncoding(value: string): string {
  return value
    .replace(/%([0-9a-fA-F]{2})/g, (match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      const unreserved = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
        || (code >= 0x30 && code <= 0x39)
        || code === 0x2d || code === 0x2e || code === 0x5f || code === 0x7e;
      return unreserved ? String.fromCharCode(code) : match;
    })
    .replace(/%([0-9a-fA-F]{2})/g, (_match, hex: string) => `%${hex.toUpperCase()}`);
}

/**
 * The pre-#7830 key: lowercase the whole URL, strip every trailing slash.
 *
 * Frozen on purpose. It is the only way to recognise a key written by the old
 * writer, so the migration and the collision audit keep it; nothing else may
 * call it. It merges agents the spec says are distinct (path case, trailing
 * slash), which is the bug #7830 fixes.
 */
export function legacyRegistryAgentUrlKey(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === REGISTRY_AGENT_URL_WILDCARD) return REGISTRY_AGENT_URL_WILDCARD;
  if (trimmed.includes('*')) return null;
  if (/[\s\u0000-\u001f]/.test(trimmed)) return null;
  let canonical = trimmed.toLowerCase();
  while (canonical.endsWith('/')) canonical = canonical.slice(0, -1);
  return canonical.length === 0 ? null : canonical;
}

/**
 * The registry key for `raw`, or `null` when `raw` cannot be a registry agent.
 *
 * AdCP URL canonicalization via the SDK's `canonicalTargetUri` (profile 3.2):
 * lowercase scheme and host, IDN host to its A-label, drop the default port,
 * resolve dot segments, drop the fragment, and normalize percent-encoding in
 * both the path and the query. Path case and a non-root trailing slash are
 * significant — `/mcp` and `/mcp/` are different agents, which is the whole
 * point of #7830.
 *
 * Registry-local rule: THE PATH NEVER ENDS IN A SLASH. `https://agent.example/`
 * keys as `https://agent.example`, and `https://agent.example/mcp/` keys as
 * `https://agent.example/mcp`. The one exception is a root path carrying a
 * query, where the `/` is kept so the query still reads as a query:
 * `https://agent.example/?t=1`.
 *
 * This DIVERGES FROM THE SPEC, deliberately and only for registry identity.
 * RFC 3986 and docs/reference/url-canonicalization treat `/mcp` and `/mcp/`
 * as different resources, and for authorization matching they stay different
 * — see the warning below. For identity they are one agent: an operator who
 * registers `https://x.example/mcp/` and a publisher who writes
 * `https://x.example/mcp` mean the same endpoint, and in production every
 * single registry-key collision is exactly that pair.
 *
 * AUTHORIZATION MATCHING MUST NOT USE THIS FUNCTION. Whether an
 * `adagents.json` entry authorizes a given agent URL is decided by
 * `canonicalTargetUri` with the trailing slash significant (#7829,
 * `server/src/validator.ts`). Those paths take the URL as registered, via
 * `declaredAgentUrl`, never the key.
 *
 * Classification of every store and path this key touches:
 *
 *   IDENTITY — folds. The registry's own projections and per-agent state:
 *     catalog_agent_authorizations.agent_url_canonical and the
 *     adagents_authorization_overrides mirror of it, agent_registry_metadata,
 *     agent_compliance_status, agent_verification_badges,
 *     agent_storyboard_status, the capability/health/inventory snapshots,
 *     agent_contexts, discovered_agents, member_profiles.agents[].url.
 *     Every one of these answers "which agent is this row about".
 *
 *   AUTHORIZATION — spec-exact, never folds. `AgentValidator.validate` and
 *     its callers (`find_agents_for_property` in mcp-tools.ts,
 *     properties.ts), which compare against a publisher's live
 *     adagents.json. They take `declaredAgentUrl(agent)`.
 *
 *   RAW-MATCHED — untouched. agent_publisher_authorizations and
 *     agent_property_authorizations, whose readers compare `agent_url`
 *     against the caller's input directly (#3177 dual-read).
 *
 * `catalog_agent_authorizations` is the one store that could be read either
 * way: it is an identity-keyed projection of manifests. Its key folds, and
 * its raw `agent_url` is preserved unchanged and exposed on both the
 * `/registry/authorizations` snapshot and the `authorization.*` change feed,
 * so a consumer that needs the spec-exact answer has the bytes to compute
 * it. The registry's own reads of it are identity reads.
 *
 * Returns `null` — never a best-effort string — for anything that is not an
 * absolute http(s) URL, carries userinfo, or contains a wildcard, backslash,
 * whitespace, or control character. Callers that need a lookup value for a
 * rejected input use `?? raw`; writers skip the row.
 *
 * Three deliberate divergences, because this is a producer-side key rather
 * than a signature comparison:
 *
 *   - Userinfo is REJECTED, not stripped. A registry key must never be
 *     derived from a URL carrying credentials: the raw URL is stored next to
 *     the key and surfaces in registry API responses, and silently keying it
 *     the same as the credential-free URL hides the leak instead of
 *     surfacing it. The writer logs and skips the row.
 *   - A raw non-ASCII (U-label) host is CONVERTED to its A-label, not
 *     rejected. The comparer rule exists so a verifier cannot be tricked by
 *     a normalization differential; here the point is that a publisher who
 *     writes `https://bücher.example` and one who writes
 *     `https://xn--bcher-kva.example` get one registry row. Conversion is
 *     WHATWG's UTS-46 profile rather than the spec's `CheckHyphens` /
 *     `UseSTD3ASCIIRules` pin, so the authority is additionally checked
 *     against `CANONICAL_AUTHORITY` above.
 *   - Percent-encoding in the QUERY is normalized, which the SDK's 3.2
 *     profile deliberately does not do — see the call site.
 */
export function registryAgentUrlKey(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === REGISTRY_AGENT_URL_WILDCARD) return REGISTRY_AGENT_URL_WILDCARD;
  // Embedded wildcards would make the key readable as a glob; backslashes are
  // silently folded to '/' by WHATWG parsing, so a key computed from one would
  // not round-trip. Whitespace and control characters (including DEL) make the
  // stored key unmatchable by any caller that re-canonicalizes the same URL.
  if (trimmed.length === 0) return null;
  if (trimmed.includes('*') || trimmed.includes('\\')) return null;
  if (FORBIDDEN_IN_KEY.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    // `new URL('https:agent.example')` parses; the registry only keys
    // authority-form URLs.
    if (!trimmed.includes('://')) return null;
    if (url.username || url.password) return null;
    // The SDK's 3.2 profile takes the path and query from the raw bytes it is
    // handed, so hand it the WHATWG-normalized authority (which supplies the
    // IDN A-label and drops a default port) spliced onto the original suffix.
    const authorityStart = trimmed.indexOf('://') + 3;
    const suffixOffset = trimmed.slice(authorityStart).search(/[/?#]/);
    if (suffixOffset === 0) return null; // empty authority
    const authorityEnd = suffixOffset < 0 ? undefined : authorityStart + suffixOffset;
    if (trimmed.slice(authorityStart, authorityEnd).includes('@')) return null;
    if (!CANONICAL_AUTHORITY.test(url.host)) return null;
    const suffix = suffixOffset < 0 ? '' : trimmed.slice(authorityStart + suffixOffset);
    // The SDK's 3.2 profile appends the query byte for byte, deliberately,
    // so an RFC 9421 signature base stays faithful to what was sent. A
    // registry key cannot afford that: `?x=%7e`, `?x=%7E` and `?x=~` are one
    // URL under docs/reference/url-canonicalization step 6, and three keys
    // would be three agents. Normalize what the SDK left alone. The path it
    // already normalized is unaffected — the transform is idempotent.
    const canonical = normalizePercentEncoding(
      canonicalTargetUri(`${url.protocol}//${url.host}${suffix}`, '3.2'));
    // Fold the trailing slash off the path. `?` can only introduce the query
    // in a canonical target URI — a literal '?' inside a path is
    // percent-encoded by WHATWG parsing — so splitting on the first one
    // separates path from query safely.
    const queryAt = canonical.indexOf('?');
    const query = queryAt < 0 ? '' : canonical.slice(queryAt);
    let path = queryAt < 0 ? canonical : canonical.slice(0, queryAt);
    while (path.endsWith('/')) path = path.slice(0, -1);
    if (query === '') return path;
    // Stripping a ROOT path leaves `scheme://authority`, and
    // `https://a.example?t=1` would not read as a query against a path, so
    // put that one slash back. A stripped non-root path needs nothing.
    const authorityOnly = `${url.protocol}//${url.host}`;
    return path === authorityOnly ? `${path}/${query}` : `${path}${query}`;
  } catch {
    return null;
  }
}

/**
 * Key for a lookup: the registry key, falling back to the raw input when the
 * input cannot be keyed. Mirrors the `registryAgentUrlKey(x) ?? x` the read
 * paths have always used, so a historical row stored under an unkeyable value
 * is still reachable.
 */
export function registryAgentUrlLookupKey(raw: string): string {
  return registryAgentUrlKey(raw) ?? raw;
}

/**
 * The spec-exact identity of an agent URL: AdCP URL canonicalization with
 * NOTHING folded that the spec keeps — a trailing slash is significant.
 * Returns null for a URL the algorithm rejects, which then matches nothing.
 *
 * This is the comparison `AgentValidator` makes against a publisher's
 * `adagents.json` (#7829), and `validator.ts` calls straight through to it so
 * the two can never drift. The registry's directory reads use it to filter
 * the rows an identity-key lookup returned, so the directory can never
 * report an authorization the validator would deny.
 *
 * Contrast `registryAgentUrlKey`, which folds the trailing slash so one agent
 * has one row. Key for the index, this for the answer.
 */
export function specExactAgentUrl(raw: string): string | null {
  try {
    return canonicalTargetUri(raw);
  } catch {
    return null;
  }
}

/**
 * Whether `rowAgentUrl` — a raw, publisher- or member-declared URL stored
 * next to an identity key — is spec-exactly the same agent as `callerUrl`.
 *
 * The `'*'` wildcard is an exact-match sentinel, not a URL: it is the same
 * agent as `'*'` and nothing else. An identity-key lookup never returns
 * wildcard rows for a non-wildcard caller anyway, since their key is `'*'`.
 */
export function isSpecExactAgentMatch(rowAgentUrl: string, callerUrl: string): boolean {
  const left = rowAgentUrl.trim();
  const right = callerUrl.trim();
  if (left === REGISTRY_AGENT_URL_WILDCARD || right === REGISTRY_AGENT_URL_WILDCARD) {
    return left === right;
  }
  const canonicalLeft = specExactAgentUrl(left);
  return canonicalLeft !== null && canonicalLeft === specExactAgentUrl(right);
}

/**
 * The URL to hand to anything that decides AUTHORIZATION — the spec-exact
 * comparison in `AgentValidator`, where a trailing slash is significant
 * (#7829). Never the registry key: the key folds the trailing slash for
 * identity, so matching a publisher's `adagents.json` against it would
 * authorize `/mcp` for an entry that says `/mcp/` and vice versa.
 *
 * `declared_url` is set only where the key folded something away, so the
 * fallback is the overwhelmingly common case.
 */
export function declaredAgentUrl(agent: { url: string; declared_url?: string }): string {
  return agent.declared_url ?? agent.url;
}

/**
 * Every spelling of `raw` a registry-keyed store may legitimately hold for
 * the one agent `raw` identifies.
 *
 * Readers of a store whose key lives inside JSONB — `member_profiles.agents[]`
 * is the only one — cannot fold the stored side in SQL: canonicalizing agent
 * URLs in the database is banned (see the module header), and the fold is not
 * expressible as a `jsonb` containment anyway. Such a reader can only ask for
 * the spellings that fold to the same key, which is what this returns.
 *
 * The registry's fold over AdCP canonicalization is exactly the trailing
 * slash on the PATH, so the set is the key, the key's path carrying the slash
 * the fold removed, and the caller's own spelling when it differs from both
 * (the `?? raw` fallback {@link registryAgentUrlLookupKey} makes, generalized
 * to the whole set — a row written before the key existed is still reachable
 * by the spelling the caller already has). The slash goes back on the path,
 * not on the end of the key, so a query-bearing URL gets
 * `https://a.example/mcp/?t=1` rather than a slash inside its query. A root
 * path is the mirror case: its key keeps the one slash only so the query
 * still reads as a query, so there the sibling is the spelling WITHOUT it.
 *
 * Every returned spelling is verified to key back to the same identity, so a
 * lookup built from this set can never reach a second agent. An input the key
 * rejects yields just that input, matching `registryAgentUrlLookupKey`.
 *
 * NOT a complete inverse of the key, and cannot be: AdCP canonicalization
 * also folds host case, the default port, dot segments, IDN and
 * percent-encoding, and `legacyRegistryAgentUrlKey` additionally lowercased
 * the path. A row holding one of those spellings is still unreachable —
 * `scripts/migrate-registry-agent-url-keys.ts` is the tool for those, not a
 * read-side guess.
 *
 * AUTHORIZATION MATCHING MUST NOT USE THIS. Like `registryAgentUrlKey` itself
 * it folds `/mcp` and `/mcp/` together; whether an `adagents.json` entry
 * authorizes a URL stays spec-exact (#7829) via `declaredAgentUrl`.
 */
export function registryAgentUrlKeySpellings(raw: string): string[] {
  const trimmed = raw.trim();
  const key = registryAgentUrlKey(trimmed);
  if (key === null) return [raw];
  // `key` was computed from `trimmed`, so the caller's spelling is already
  // verified to be this agent.
  const spellings = new Set<string>([key, trimmed]);
  const queryAt = key.indexOf('?');
  const path = queryAt < 0 ? key : key.slice(0, queryAt);
  const queryPart = queryAt < 0 ? '' : key.slice(queryAt);
  // A key's path ends in a slash only in the root-with-query case the fold
  // puts back; everywhere else the fold stripped it.
  const sibling = path.endsWith('/')
    ? `${path.slice(0, -1)}${queryPart}`
    : `${path}/${queryPart}`;
  if (registryAgentUrlKey(sibling) === key) spellings.add(sibling);
  return [...spellings];
}
