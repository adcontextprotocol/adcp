# Community Brand Logo Uploads

## Problem

The brand registry enriches brands via Brandfetch, but the results are often wrong. Chime (the fintech company) resolves as "Chime Interactive" (a digital agency). Community members frequently have access to official brand assets — press kits, brand portals, direct relationships — but there's no way to contribute them. The only logo sources today are Brandfetch CDN URLs and self-hosted `brand.json` files, neither of which the community controls.

Separately, the existing `brand_logo_cache` table uses a `(domain, idx)` composite key where `idx` is the positional index from the Brandfetch logo array. This is a fragile design — re-enrichment can overwrite logos, there's no stable identifier for a logo, and the URL structure (`/logos/brands/chime.com/0`) exposes an implementation detail that means nothing to consumers.

## Goals

1. Replace the integer index scheme with UUID-based logo identity.
2. Members can upload logo files for any brand in the registry.
3. Logos are tagged semantically so consumers select by purpose, not position.
4. Uploads go through review before replacing enriched logos.
5. The system tracks provenance — who uploaded what, when, and from where.

## Design Principles

- **Community-sourced beats auto-enriched.** Approved community uploads take precedence over Brandfetch data.
- **Logos are identified by UUID, selected by tags.** No more positional indices.
- **Review before publish.** Logos are brand identity — wrong logos cause real harm. Pending uploads are visible to admins only.
- **Provenance is permanent.** Every logo knows where it came from and who put it there.
- **Content-type is truth, not trust.** File types are determined from magic bytes, not client claims.

---

## Data Model

### Replace `brand_logo_cache` with `brand_logos`

Drop the `(domain, idx)` scheme. Each logo gets a UUID.

```sql
CREATE TABLE brand_logos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL,
  content_type TEXT NOT NULL,
  data BYTEA NOT NULL,
  storage_type TEXT NOT NULL DEFAULT 'inline'
    CHECK (storage_type IN ('inline', 's3')),
  storage_key TEXT,
  sha256 TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  width INTEGER,
  height INTEGER,
  source TEXT NOT NULL DEFAULT 'brandfetch'
    CHECK (source IN ('brandfetch', 'community', 'brand_owner', 'brand_json')),
  review_status TEXT NOT NULL DEFAULT 'approved'
    CHECK (review_status IN ('pending', 'approved', 'rejected', 'deleted')),
  uploaded_by_user_id VARCHAR(255),
  uploaded_by_email VARCHAR(255),
  upload_note TEXT CHECK (length(upload_note) <= 500),
  original_filename TEXT CHECK (length(original_filename) <= 255),
  review_note TEXT CHECK (length(review_note) <= 500),
  reviewed_by_user_id VARCHAR(255),
  reviewed_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_brand_logos_domain ON brand_logos (domain);
CREATE INDEX idx_brand_logos_domain_status ON brand_logos (domain, review_status);
CREATE INDEX idx_brand_logos_tags ON brand_logos USING GIN (tags);
CREATE INDEX idx_brand_logos_pending ON brand_logos (created_at)
  WHERE review_status = 'pending';
CREATE UNIQUE INDEX idx_brand_logos_dedup ON brand_logos (domain, sha256)
  WHERE review_status IN ('pending', 'approved');

CREATE TRIGGER update_brand_logos_updated_at
  BEFORE UPDATE ON brand_logos
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
```

The dedup index covers `pending` and `approved` only — a rejected logo can be resubmitted (e.g., same content with corrected tags). Deleted logos are excluded from dedup entirely.

### Tag Vocabulary

Tags describe what a logo is and how to use it. Consumers pick logos by filtering tags rather than guessing indices. Tags are validated at the application layer on upload — unknown tags are rejected.

The vocabulary aligns with the existing `BrandLogo` type in `types.ts`. The `BrandLogo` type's structured fields (`orientation`, `background`, `variant`) are replaced by freeform tags. The TypeScript type must be updated: add `symbol` to `variant`, and the resolve API maps tags back to the typed fields for backwards compatibility with existing consumers until they migrate to tag-based selection.

**Variant tags** (what it is):
- `icon` — small mark, works at 16-64px
- `wordmark` — the brand name rendered as a logo
- `full-lockup` — icon + wordmark combined
- `symbol` — standalone symbol/mark without text
- `primary` — the brand's primary logo
- `secondary` — alternate version

**Shape tags** (aspect ratio, maps to `BrandLogo.orientation`):
- `square` — roughly 1:1
- `horizontal` — wider than tall (e.g. 4:1)
- `vertical` — taller than wide
- `stacked` — icon above wordmark

**Background tags** (where it works, maps to `BrandLogo.background`):
- `light-bg` — designed for white/light backgrounds
- `dark-bg` — designed for dark backgrounds
- `transparent-bg` — has alpha channel, works on any background

**Use-case tags**:
- `favicon` — site icon
- `social` — sized for social media (OG images, profile pics)

### Domain Normalization

Logos are keyed by `discovered_brands.domain` (the discovery key), not `canonical_domain`. The upload and serving paths must normalize to this form. If `chime.com` redirects to `www.chime.com`, logos are stored under whichever domain appears in `discovered_brands.domain`.

---

## Migration from `brand_logo_cache`

The migration must run in a single transaction and handle three things: data transfer, URL rewrite, and backwards-compatible redirects.

Requires the `pgcrypto` extension for `digest()`.

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

BEGIN;

-- Step 1: Build mapping of old (domain, idx) to new UUIDs
CREATE TEMP TABLE logo_migration_map AS
SELECT gen_random_uuid() AS new_id, domain, idx
FROM brand_logo_cache;

-- Step 2: Insert into new table with mapped IDs
-- Tags are backfilled from brand_manifest.logos where available
INSERT INTO brand_logos (id, domain, content_type, data, sha256, source, review_status, created_at, updated_at)
SELECT
  m.new_id,
  c.domain,
  c.content_type,
  c.data,
  encode(digest(c.data, 'sha256'), 'hex'),
  'brandfetch',
  'approved',
  c.fetched_at,
  c.fetched_at
FROM brand_logo_cache c
JOIN logo_migration_map m ON c.domain = m.domain AND c.idx = m.idx;

-- Step 3: Backfill tags from brand_manifest.logos arrays and rewrite URLs
-- This iterates each discovered_brands row with a manifest, walks the logos
-- array, matches URLs to the migration map, backfills tags, and rewrites URLs.
DO $$
DECLARE
  brand RECORD;
  logo RECORD;
  logo_entry JSONB;
  new_logos JSONB;
  matched_id UUID;
  old_url TEXT;
  new_url TEXT;
  logo_tags TEXT[];
  i INT;
BEGIN
  FOR brand IN
    SELECT domain, brand_manifest
    FROM discovered_brands
    WHERE brand_manifest IS NOT NULL
      AND brand_manifest->'logos' IS NOT NULL
  LOOP
    new_logos := '[]'::jsonb;
    FOR i IN 0..jsonb_array_length(brand.brand_manifest->'logos') - 1
    LOOP
      logo_entry := brand.brand_manifest->'logos'->i;
      old_url := logo_entry->>'url';

      -- Try to match URL pattern /logos/brands/{domain}/{idx}
      SELECT m.new_id INTO matched_id
      FROM logo_migration_map m
      WHERE m.domain = brand.domain
        AND old_url LIKE '%/logos/brands/' || brand.domain || '/' || m.idx::text;

      IF matched_id IS NOT NULL THEN
        -- Rewrite URL to UUID-based path
        new_url := '/logos/brands/' || brand.domain || '/' || matched_id::text;
        logo_entry := jsonb_set(logo_entry, '{url}', to_jsonb(new_url));

        -- Backfill tags onto brand_logos row
        SELECT ARRAY(
          SELECT jsonb_array_elements_text(logo_entry->'tags')
        ) INTO logo_tags;
        IF logo_tags IS NOT NULL AND array_length(logo_tags, 1) > 0 THEN
          UPDATE brand_logos SET tags = logo_tags
          WHERE id = matched_id;
        END IF;
      END IF;

      new_logos := new_logos || jsonb_build_array(logo_entry);
    END LOOP;

    UPDATE discovered_brands
    SET brand_manifest = jsonb_set(brand_manifest, '{logos}', new_logos)
    WHERE domain = brand.domain;
  END LOOP;
END $$;

-- Step 5: Create redirect mapping table for backwards compatibility
CREATE TABLE brand_logo_redirects (
  domain TEXT NOT NULL,
  old_idx INT NOT NULL,
  new_id UUID NOT NULL REFERENCES brand_logos(id),
  PRIMARY KEY (domain, old_idx)
);

INSERT INTO brand_logo_redirects (domain, old_idx, new_id)
SELECT domain, idx, new_id FROM logo_migration_map;

-- Step 6: Validate row counts match
DO $$
DECLARE
  old_count INT;
  new_count INT;
BEGIN
  SELECT count(*) INTO old_count FROM brand_logo_cache;
  SELECT count(*) INTO new_count FROM brand_logos;
  IF old_count != new_count THEN
    RAISE EXCEPTION 'Row count mismatch: brand_logo_cache=%, brand_logos=%', old_count, new_count;
  END IF;
END $$;

-- Step 7: Drop old table
DROP TABLE brand_logo_cache;

COMMIT;
```

The `brand_logo_redirects` table enables 301 redirects from old `/:idx` URLs to `/:uuid` URLs. The redirect endpoint should remain active for 90 days, then be removed along with the table.

---

## API

### `POST /api/brands/:domain/logos`

Upload a logo for a brand. Requires authentication + membership.

**Request:** `multipart/form-data`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | binary | yes | PNG, JPEG, SVG, WebP, or GIF. Max 5 MB. |
| `tags` | string | yes | Comma-separated tags from the vocabulary above. Validated against allowlist. |
| `note` | string | no | Source attribution (max 500 chars): "From Chime press kit", "Official brand portal" |

**Response:**

```json
{
  "success": true,
  "domain": "chime.com",
  "logo_id": "a1b2c3d4-...",
  "review_status": "pending",
  "url": "/logos/brands/chime.com/a1b2c3d4-..."
}
```

**Behavior:**
- Determines content type from magic bytes using `file-type` library, not the client-provided MIME type
- Rejects files where magic bytes don't match an allowed image type (PNG, JPEG, WebP, GIF)
- SVG files (detected by XML declaration or `<svg` opening tag) are sanitized with DOMPurify using SVG profile: `FORBID_TAGS: ['foreignObject', 'use']`, `FORBID_ATTR: ['xlink:href']`, strip all event handlers and external references
- Computes SHA-256 hash; rejects duplicates for the same domain (unique index)
- Extracts dimensions for raster images
- Validates tags against the allowed vocabulary; rejects unknown tags
- Stores in `brand_logos` with `source = 'community'`, `review_status = 'pending'`
- If brand doesn't exist in `discovered_brands`, creates it with `source_type = 'community'`, `review_status = 'pending'`
- Creates a brand revision noting the logo upload
- Ban check via the unified ban system (not the nonexistent `brand_creation_bans`)

### `GET /logos/brands/:domain/:id`

Serve a logo by UUID. Replaces the old `/:idx` endpoint.

- Validates `:domain` parameter against the existing domain pattern (`/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/`) carried forward from the current logo endpoint
- Returns binary image data with appropriate `Content-Type` and 30-day cache headers
- All responses include `Content-Security-Policy: default-src 'none'`, `X-Content-Type-Options: nosniff`, and `Content-Disposition: inline` (matches the pattern in the perspective asset endpoint)
- Only serves `review_status = 'approved'` logos publicly
- Returns 404 for pending/rejected/deleted logos (admins see all except deleted)

**Backwards compatibility:** If `:id` is a small integer (not a UUID), check `brand_logo_redirects` and return a 301 redirect to the UUID-based URL. Remove this after 90 days.

### `GET /api/brands/:domain/logos`

List all logos for a brand. Supports server-side tag filtering.

**Query parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `tags` | string | Comma-separated. Returns only logos matching all specified tags. |

**Response:**

```json
{
  "domain": "chime.com",
  "logos": [
    {
      "id": "a1b2c3d4-...",
      "content_type": "image/svg+xml",
      "source": "brandfetch",
      "review_status": "approved",
      "tags": ["wordmark", "light-bg"],
      "url": "/logos/brands/chime.com/a1b2c3d4-..."
    },
    {
      "id": "e5f6g7h8-...",
      "content_type": "image/png",
      "source": "community",
      "review_status": "pending",
      "tags": ["wordmark", "square", "light-bg"],
      "width": 1200,
      "height": 1200,
      "upload_note": "From Chime press kit",
      "url": "/logos/brands/chime.com/e5f6g7h8-..."
    }
  ]
}
```

**Visibility rules:**
- Public (unauthenticated): approved logos only, no `uploaded_by` fields
- Authenticated members: approved logos only, no `uploaded_by` fields
- Admins: all logos including pending/rejected, with `uploaded_by_email` visible

No pagination — the 10-logo-per-brand cap keeps response sizes small. If the cap changes, add cursor-based pagination.

### `POST /api/brands/:domain/logos/:id/review`

Admin-only. Approve, reject, or delete a logo.

**Request:**

```json
{
  "action": "approve" | "reject" | "delete",
  "note": "optional reason"
}
```

**Behavior:**
- `approve`: Sets `review_status = 'approved'`, rebuilds `brand_manifest.logos` on the `discovered_brands` row using the priority ordering
- `reject`: Sets `review_status = 'rejected'`, records `review_note`
- `delete`: Sets `review_status = 'deleted'` and `deleted_at = now()`. Logo URL returns 404 immediately. Binary data is retained for audit but excluded from all queries.
- All actions record `reviewed_by_user_id`, `reviewed_at`, and create a brand revision

### Admin Review Queue

Pending uploads surface through the existing admin notification system. The query:

```sql
SELECT bl.*, db.brand_name
FROM brand_logos bl
LEFT JOIN discovered_brands db ON bl.domain = db.domain
WHERE bl.review_status = 'pending'
ORDER BY bl.created_at ASC;
```

The partial index on `created_at WHERE review_status = 'pending'` keeps this fast.

---

## Logo Selection in brand.json / Resolve API

The `brand_manifest.logos` array on `discovered_brands` is rebuilt whenever a logo is approved, rejected-after-approval, or deleted. The resolve API returns logos in priority order:

1. **brand_owner** — uploaded by a verified domain owner
2. **community** (approved) — uploaded by a member, reviewed by admin
3. **brandfetch** — auto-enriched

When a community logo has overlapping tags with a Brandfetch logo, the community logo replaces it. Replacement uses subset matching: if a community logo's tags are a superset of (or equal to) a Brandfetch logo's tags, the Brandfetch logo is removed. Logos with non-overlapping tags coexist. For example, a community `['wordmark', 'light-bg']` replaces a Brandfetch `['wordmark', 'light-bg']` but does not affect a Brandfetch `['symbol', 'dark-bg']`.

Consumers don't need to understand provenance — they get a clean `logos` array with tags and URLs.

### Hosted Brands

Community members can upload logos for any domain, including those with `hosted_brands` entries. The behavior depends on verification status:

- **Verified hosted brand** (`domain_verified = true`): The brand owner controls their `brand_json`. Community uploads are stored in `brand_logos` and visible in the list endpoint as suggestions, but do not modify `hosted_brands.brand_json`. The resolve API returns the owner's logos.
- **Unverified hosted brand** (`domain_verified = false`): Treated the same as discovered brands. Community uploads go through normal review and, once approved, are reflected in the resolve API response. The `hosted_brands.brand_json.logos` array is rebuilt on approval using the same priority ordering as discovered brands.

---

## Addie Integration

### `upload_brand_logo` tool

Addie can upload logos on behalf of a user during conversation.

```typescript
{
  name: "upload_brand_logo",
  description: "Upload a logo file for a brand in the registry. The logo will be pending review.",
  inputSchema: {
    domain: string,     // required — brand domain
    logo_url: string,   // required — URL to fetch the logo from (press kit, brand portal, etc.)
    tags: string[],     // required — at least one tag from the vocabulary
    note: string        // optional — provenance ("From Chime press kit")
  }
}
```

**Security requirements for URL fetch:**
- Validate protocol before fetching: reject `http:` URLs, allow `https:` only
- Must use `safeFetch` from `utils/url-security.ts` (validates against private IP ranges, metadata endpoints)
- 5 MB response size limit enforced via streaming (do not buffer entire response before checking)
- Content-type validation on the HTTP response before storing
- 10-second timeout
- Follow redirects cautiously (max 3, re-validate each hop via `safeFetch`)
- Known residual risk: DNS rebinding between `validateHostResolution` and `fetch`. Network-layer controls (security group blocking RFC 1918 ranges) are the proper defense-in-depth.

The `upload_note` and `original_filename` fields must not be included in LLM context without sanitization, as they are user-provided free text (indirect prompt injection vector).

---

## Changes to logo-cdn.ts

The `downloadAndCacheLogos` function writes to `brand_logos` instead of `brand_logo_cache`. The `isSafeLogoUrl` restriction (Brandfetch-only) stays for the Brandfetch download path.

```typescript
export function getLogoUrl(domain: string, logoId: string): string {
  return `${BASE_URL}/logos/brands/${encodeURIComponent(domain)}/${logoId}`;
}

export async function getLogo(domain: string, logoId: string): Promise<CachedLogo | null> {
  const result = await query<{ content_type: string; data: Buffer }>(
    `SELECT content_type, data FROM brand_logos
     WHERE domain = $1 AND id = $2 AND review_status = 'approved'`,
    [domain, logoId]
  );
  if (result.rows.length === 0) return null;
  return result.rows[0];
}
```

---

## Guardrails

- **Magic byte validation:** Content type determined by `file-type` library, not client MIME type. SVGs validated by XML/`<svg` detection.
- **SVG sanitization:** DOMPurify with SVG profile. Forbid `<foreignObject>`, `<use>` with external refs, event handlers, XML entities. Admin preview renders SVGs in a sandboxed iframe (`sandbox=""`).
- **CSP on all logo responses:** `Content-Security-Policy: default-src 'none'` on every response from the logo serving endpoint, regardless of content type.
- **Content-type sniffing prevention:** `X-Content-Type-Options: nosniff` on all logo responses.
- **Rate limiting:** 10 uploads per hour per user.
- **Size limits:** 5 MB per file, max 10 logos per brand.
- **Deduplication:** SHA-256 hash with unique index per domain prevents duplicate uploads.
- **Ban check:** Uses the unified ban system, not `brand_creation_bans` (which does not exist).
- **No overwrites:** Uploads always create new entries. Admins can soft-delete old ones.
- **Revision tracking:** Logo changes create `brand_revisions` entries for auditability.
- **Text field limits:** `upload_note` max 500 chars, `original_filename` max 255 chars, `review_note` max 500 chars. All HTML-escaped in admin UI rendering.
- **Serving rate limiting:** Logo serving endpoint should use an in-memory LRU cache (bounded to 100 MB or ~200 entries) in front of database reads to prevent BYTEA query abuse.

---

## Storage Path

Binary data is stored as PostgreSQL BYTEA (`storage_type = 'inline'`). This is acceptable at current scale (thousands of brands, max 10 logos each). The `storage_type` and `storage_key` columns exist for future migration to object storage (S3/R2) when BYTEA becomes a bottleneck for backups, WAL replication, or VACUUM pressure. The API contract does not change when storage moves — the serving endpoint abstracts this.

---

## Out of Scope

- **Bulk upload / ZIP archives** — single file at a time for now.
- **Logo generation / AI** — not synthesizing logos, only storing real ones.
- **Brand owner self-service verification** — existing domain verification flow handles this separately.
- **Public upload without membership** — members only to maintain quality.
