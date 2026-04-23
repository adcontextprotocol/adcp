// Matches any RFC 4122-shaped hex string (no version/variant nibble check).
// Intentional: callers guard Postgres UUID columns, and Postgres accepts any
// well-formed hex UUID — tightening to a specific version would reject IDs
// that the database already stores.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): boolean {
  return typeof value === 'string' && UUID_REGEX.test(value);
}
