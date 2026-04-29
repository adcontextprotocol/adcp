// Opaque offset-encoded cursors for in-memory paginated reads. Real backends
// would carry stable resource keys; an offset is sufficient for the training
// agent because the underlying iteration order is stable for every read this
// powers (Map insertion order, static catalog order). base64url keeps the
// token URL-safe and visibly opaque. The `kind` prefix scopes a cursor to a
// specific list endpoint so a caller can't move a list_creatives cursor onto
// list_accounts and accidentally land at a meaningful offset.
export function encodeOffsetCursor(kind: string, offset: number): string {
  return Buffer.from(`${kind}:offset:${offset}`).toString('base64url');
}

// Returns null when the cursor is present but malformed (or scoped to a
// different list endpoint). The caller MUST surface INVALID_REQUEST in that
// case — silently restarting from offset 0 would teach a sloppy pattern
// (corrupt cursors duplicate items the caller already saw). An absent
// cursor returns 0 (start of pagination).
export function decodeOffsetCursor(kind: string, cursor: string | undefined): number | null {
  if (!cursor) return 0;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = new RegExp(`^${kind}:offset:(\\d+)$`).exec(decoded);
    if (!m) return null;
    const n = Number.parseInt(m[1], 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}
