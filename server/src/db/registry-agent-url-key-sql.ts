/**
 * A SQL twin of `registryAgentUrlKey`, for read-only auditing (#7830).
 *
 * The TypeScript helper is the only implementation that writes keys — this
 * file never does. It exists so a maintainer can measure a production
 * database from a psql session, before deploying anything, and get the same
 * grouping the migration will produce rather than an over-reporting
 * approximation.
 *
 * A SQL twin of a spec algorithm is exactly the kind of drift #7830 is about,
 * so it is fenced two ways:
 *
 *   1. It is exact only on the subset `NOT_SQL_COMPUTABLE` excludes — URLs
 *      with no non-ASCII bytes, no percent-encoding and no dot segments.
 *      Everything else has to be checked by hand, and the audit says so
 *      rather than guessing.
 *   2. `registry-agent-url-key-sql.test.ts` runs a corpus through both
 *      implementations against a real Postgres and fails if they disagree
 *      anywhere outside that excluded subset.
 */

/**
 * The helper trims first and only then looks for whitespace, so every rule
 * below works on the trimmed value — otherwise a stored URL with surrounding
 * spaces reads as unkeyable here and keyable there.
 */
const TRIMMED = (column: string) => `btrim(${column})`;
/** Trimmed, fragment-stripped input. */
const FRAGMENTLESS = (column: string) => `regexp_replace(${TRIMMED(column)}, '#.*$', '')`;
const SCHEME = (column: string) =>
  `lower(substring(${FRAGMENTLESS(column)} from '^([A-Za-z][A-Za-z0-9+.-]*)://'))`;
const RAW_AUTHORITY = (column: string) =>
  `substring(${FRAGMENTLESS(column)} from '^[A-Za-z][A-Za-z0-9+.-]*://([^/?#]*)')`;
const SUFFIX = (column: string) =>
  `substring(${FRAGMENTLESS(column)} from '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*(.*)$')`;

/**
 * Lowercase the authority, drop the scheme's default port, and drop a single
 * root-label dot. Bracketed IPv6 literals keep their brackets; the dot rule
 * does not apply to them.
 */
const AUTHORITY = (column: string) => `
  CASE WHEN lower(${RAW_AUTHORITY(column)}) LIKE '[%'
       THEN regexp_replace(lower(${RAW_AUTHORITY(column)}),
              CASE WHEN ${SCHEME(column)} = 'https' THEN ':443$' ELSE ':80$' END, '')
       ELSE regexp_replace(
              regexp_replace(lower(${RAW_AUTHORITY(column)}),
                CASE WHEN ${SCHEME(column)} = 'https' THEN ':443$' ELSE ':80$' END, ''),
              '\\.$', '')
  END`;

/**
 * Rows this twin cannot key exactly, because the WHATWG/SDK pipeline does
 * something SQL cannot reproduce: IDN A-label conversion and percent-encoding
 * of non-ASCII path bytes, percent-encoding normalization, and dot-segment
 * resolution. An audit must report these separately and have them looked at.
 */
export const NOT_SQL_COMPUTABLE = (column: string) => `(
  ${column} IS NOT NULL AND ${TRIMMED(column)} <> '*' AND (
       ${TRIMMED(column)} !~ '^[[:ascii:]]*$'
    OR ${TRIMMED(column)} ~ '%'
    OR ${TRIMMED(column)} ~ '(^|/)\\.\\.?(/|$)'
  ))`;

/**
 * Rows `registryAgentUrlKey` returns null for: not an absolute http(s) URL,
 * userinfo, an empty authority or an empty DNS label, a wildcard that is not
 * the bare sentinel, a backslash, whitespace or a control character, or an
 * authority character outside the canonical class. Only meaningful on the
 * subset NOT_SQL_COMPUTABLE excludes — a non-ASCII host is keyable by the
 * real helper and is reported there instead.
 */
export const UNKEYABLE = (column: string) => `(
  ${column} IS NULL
  OR btrim(${column}) = ''
  OR (${TRIMMED(column)} <> '*' AND NOT ${NOT_SQL_COMPUTABLE(column)} AND (
       ${TRIMMED(column)} ~ '\\*'
    OR ${TRIMMED(column)} ~ '\\\\'
    OR ${TRIMMED(column)} ~ '[[:space:][:cntrl:]]'
    OR ${TRIMMED(column)} !~ '^[Hh][Tt][Tt][Pp][Ss]?://'
    OR coalesce(${RAW_AUTHORITY(column)}, '') = ''
    OR ${RAW_AUTHORITY(column)} ~ '@'
    OR lower(${RAW_AUTHORITY(column)}) ~ '[^a-z0-9._~!$&''()+,;=:\\[\\]-]'
    OR ${AUTHORITY(column)} ~ '(^|\\.)\\.'
    OR ${AUTHORITY(column)} ~ '\\.$'
  )))`;

/**
 * The registry key, matching `registryAgentUrlKey` on the subset above.
 * NULL where `UNKEYABLE` is true, so a NULL from this expression and a null
 * from the helper mean the same thing.
 *
 * Path case is significant; a trailing slash is not — the path is stripped of
 * trailing slashes, and a root path keeps its '/' only when a query follows.
 * See the registry-local rule on `registryAgentUrlKey`.
 */
const PATH = (column: string) =>
  `regexp_replace(split_part(${SUFFIX(column)}, '?', 1), '/+$', '')`;
const QUERY = (column: string) => `
  CASE WHEN strpos(${SUFFIX(column)}, '?') = 0 THEN ''
       ELSE substr(${SUFFIX(column)}, strpos(${SUFFIX(column)}, '?')) END`;

export const REGISTRY_KEY = (column: string) => `(
  CASE
    WHEN ${UNKEYABLE(column)} THEN NULL
    WHEN ${TRIMMED(column)} = '*' THEN '*'
    WHEN ${NOT_SQL_COMPUTABLE(column)} THEN NULL
    ELSE ${SCHEME(column)} || '://' || ${AUTHORITY(column)} || ${PATH(column)} ||
      CASE WHEN ${QUERY(column)} = '' THEN ''
           WHEN ${PATH(column)} = '' THEN '/' || ${QUERY(column)}
           ELSE ${QUERY(column)} END
  END)`;
