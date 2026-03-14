/**
 * In-memory preview store with TTL expiration.
 *
 * Stores rendered HTML previews keyed by preview ID.
 * Previews expire after a configurable TTL (default 1 hour).
 */

const PREVIEW_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_STORE_SIZE = 5000;

interface StoredPreview {
  html: string;
  expiresAt: number;
}

const store = new Map<string, StoredPreview>();

export function storePreview(id: string, html: string): Date {
  if (store.size >= MAX_STORE_SIZE) {
    const oldest = store.keys().next().value;
    if (oldest) store.delete(oldest);
  }
  const expiresAt = Date.now() + PREVIEW_TTL_MS;
  store.set(id, { html, expiresAt });
  return new Date(expiresAt);
}

export function getPreview(id: string): string | null {
  const entry = store.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(id);
    return null;
  }
  return entry.html;
}

export function cleanExpiredPreviews(): void {
  const now = Date.now();
  for (const [id, entry] of store) {
    if (now > entry.expiresAt) {
      store.delete(id);
    }
  }
}
