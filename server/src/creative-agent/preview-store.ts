/**
 * In-memory preview store with TTL expiration.
 *
 * Stores rendered HTML previews keyed by preview ID.
 * Previews expire after a configurable TTL (default 1 hour).
 */

const PREVIEW_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_STORE_SIZE = 5000;
const MAX_ASSET_STORE_SIZE = 1000;
const MAX_ASSETS_PER_SCOPE = 8;
const MAX_ASSETS_PER_PRINCIPAL = 64;
export const MAX_PREVIEW_ASSET_BYTES = 10 * 1_000_000;
const MAX_ASSET_CACHE_BYTES = 256 * 1024 * 1024;
const MAX_ASSET_CACHE_BYTES_PER_PRINCIPAL = 64 * 1024 * 1024;

interface StoredPreview {
  html: string;
  expiresAt: number;
}

export interface CachedPreviewAsset {
  path: string;
  contentType: string;
  size: number;
}

interface StoredPreviewAsset {
  sourceUrl: string;
  scopeId: string;
  principalId: string;
  expiresAt: number;
  cached?: CachedPreviewAsset;
  download?: Promise<CachedPreviewAsset>;
  reservedBytes?: number;
  lastAccessedAt?: number;
  activeUses: number;
}

const store = new Map<string, StoredPreview>();
const assetStore = new Map<string, StoredPreviewAsset>();
const assetScopeCounts = new Map<string, number>();
const assetPrincipalCounts = new Map<string, number>();
const assetPrincipalCacheBytes = new Map<string, number>();
let assetCacheBytes = 0;

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

export function storePreviewAsset(
  id: string,
  sourceUrl: string,
  scopeId: string,
  principalId = scopeId,
): Date | null {
  const scopeCount = assetScopeCounts.get(scopeId) ?? 0;
  const principalCount = assetPrincipalCounts.get(principalId) ?? 0;
  // Never evict another preview's live tokens. New previews fail closed when
  // the global, per-principal, or per-preview token quota is exhausted.
  if (assetStore.size >= MAX_ASSET_STORE_SIZE
    || scopeCount >= MAX_ASSETS_PER_SCOPE
    || principalCount >= MAX_ASSETS_PER_PRINCIPAL) return null;
  const expiresAt = Date.now() + PREVIEW_TTL_MS;
  assetStore.set(id, { sourceUrl, scopeId, principalId, expiresAt, activeUses: 0 });
  assetScopeCounts.set(scopeId, scopeCount + 1);
  assetPrincipalCounts.set(principalId, principalCount + 1);
  return new Date(expiresAt);
}

function adjustPrincipalCacheBytes(principalId: string, delta: number): void {
  const next = Math.max(0, (assetPrincipalCacheBytes.get(principalId) ?? 0) + delta);
  if (next > 0) assetPrincipalCacheBytes.set(principalId, next);
  else assetPrincipalCacheBytes.delete(principalId);
}

function releaseCachedFile(entry: StoredPreviewAsset): void {
  if (entry.reservedBytes) {
    assetCacheBytes -= entry.reservedBytes;
    adjustPrincipalCacheBytes(entry.principalId, -entry.reservedBytes);
    entry.reservedBytes = undefined;
  }
  if (entry.cached?.path) {
    const path = entry.cached.path;
    entry.cached = undefined;
    void import('node:fs/promises').then(({ unlink }) => unlink(path).catch(() => {}));
  }
}

function removePreviewAsset(id: string, entry: StoredPreviewAsset): void {
  assetStore.delete(id);
  const remaining = (assetScopeCounts.get(entry.scopeId) ?? 1) - 1;
  if (remaining > 0) assetScopeCounts.set(entry.scopeId, remaining);
  else assetScopeCounts.delete(entry.scopeId);
  const principalRemaining = (assetPrincipalCounts.get(entry.principalId) ?? 1) - 1;
  if (principalRemaining > 0) assetPrincipalCounts.set(entry.principalId, principalRemaining);
  else assetPrincipalCounts.delete(entry.principalId);
  releaseCachedFile(entry);
}

export function getPreviewAssetSource(id: string): string | null {
  const entry = assetStore.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    removePreviewAsset(id, entry);
    return null;
  }
  return entry.sourceUrl;
}

/**
 * Return the token's cached download, or atomically start one. Reserving the
 * maximum size before download bounds aggregate disk use even when upstreams
 * omit Content-Length. Concurrent requests for one token share one promise.
 */
export function getOrCreatePreviewAssetDownload(
  id: string,
  maxBytes: number,
  loader: (sourceUrl: string) => Promise<CachedPreviewAsset>,
): Promise<CachedPreviewAsset> | null {
  const entry = assetStore.get(id);
  if (!entry || Date.now() > entry.expiresAt) {
    if (entry) removePreviewAsset(id, entry);
    return null;
  }
  entry.activeUses += 1;
  entry.lastAccessedAt = Date.now();
  if (entry.cached) return Promise.resolve(entry.cached);
  if (entry.download) return entry.download;

  let principalBytes = assetPrincipalCacheBytes.get(entry.principalId) ?? 0;
  if (principalBytes + maxBytes > MAX_ASSET_CACHE_BYTES_PER_PRINCIPAL) {
    const principalEvictable = [...assetStore.values()]
      .filter(candidate => candidate.principalId === entry.principalId
        && candidate.cached && candidate.activeUses === 0)
      .sort((left, right) => (left.lastAccessedAt ?? 0) - (right.lastAccessedAt ?? 0));
    for (const candidate of principalEvictable) {
      releaseCachedFile(candidate);
      principalBytes = assetPrincipalCacheBytes.get(entry.principalId) ?? 0;
      if (principalBytes + maxBytes <= MAX_ASSET_CACHE_BYTES_PER_PRINCIPAL) break;
    }
  }
  if (principalBytes + maxBytes > MAX_ASSET_CACHE_BYTES_PER_PRINCIPAL) {
    entry.activeUses -= 1;
    return null;
  }
  if (assetCacheBytes + maxBytes > MAX_ASSET_CACHE_BYTES) {
    const evictable = [...assetStore.values()]
      .filter(candidate => candidate.cached && candidate.activeUses === 0)
      .sort((left, right) => (left.lastAccessedAt ?? 0) - (right.lastAccessedAt ?? 0));
    for (const candidate of evictable) {
      releaseCachedFile(candidate);
      if (assetCacheBytes + maxBytes <= MAX_ASSET_CACHE_BYTES) break;
    }
  }
  if (assetCacheBytes + maxBytes > MAX_ASSET_CACHE_BYTES) {
    entry.activeUses -= 1;
    return null;
  }

  assetCacheBytes += maxBytes;
  adjustPrincipalCacheBytes(entry.principalId, maxBytes);
  entry.reservedBytes = maxBytes;
  entry.download = loader(entry.sourceUrl).then(asset => {
    if (assetStore.get(id) !== entry) {
      void import('node:fs/promises').then(({ unlink }) => unlink(asset.path).catch(() => {}));
      assetCacheBytes -= entry.reservedBytes ?? 0;
      adjustPrincipalCacheBytes(entry.principalId, -(entry.reservedBytes ?? 0));
      entry.reservedBytes = undefined;
      return asset;
    }
    assetCacheBytes -= maxBytes - asset.size;
    adjustPrincipalCacheBytes(entry.principalId, -(maxBytes - asset.size));
    entry.reservedBytes = asset.size;
    entry.cached = asset;
    entry.download = undefined;
    return asset;
  }).catch(error => {
    assetCacheBytes -= entry.reservedBytes ?? 0;
    adjustPrincipalCacheBytes(entry.principalId, -(entry.reservedBytes ?? 0));
    entry.reservedBytes = undefined;
    entry.download = undefined;
    throw error;
  });
  return entry.download;
}

export function releasePreviewAssetDownload(id: string): void {
  const entry = assetStore.get(id);
  if (entry && entry.activeUses > 0) entry.activeUses -= 1;
}

export function cleanExpiredPreviews(): void {
  const now = Date.now();
  for (const [id, entry] of store) {
    if (now > entry.expiresAt) {
      store.delete(id);
    }
  }
  for (const [id, entry] of assetStore) {
    if (now > entry.expiresAt) {
      removePreviewAsset(id, entry);
    }
  }
}
