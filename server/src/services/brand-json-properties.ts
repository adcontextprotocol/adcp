/**
 * Extract publisher-shaped properties from a brand.json manifest.
 *
 * brand.json may carry properties in two shapes:
 *   - top-level `properties[]` (single-brand manifest, written by the
 *     parse_brand_properties / import_brand_properties tools)
 *   - `brands[].properties[]` (multi-brand house manifest, walked by the
 *     network-consistency reporter)
 *
 * Both are accepted. Each property has `{ identifier, type?, relationship? }`.
 * The result is shaped to match `PublisherPropertySchema` so callers of
 * `/api/registry/publisher` see a consistent payload regardless of source.
 */
export interface PublisherPropertyFromBrandJson {
  type: string;
  name: string;
  identifiers: Array<{ type: string; value: string }>;
  tags: string[];
  source: "brand_json";
}

interface RawBrandJsonProperty {
  identifier?: unknown;
  type?: unknown;
  relationship?: unknown;
}

function readPropertyArray(value: unknown): RawBrandJsonProperty[] {
  return Array.isArray(value) ? (value as RawBrandJsonProperty[]) : [];
}

/**
 * Hard cap on the number of brand.json properties we'll walk per request.
 * Brand.json is publisher- or community-controlled and has no inherent
 * size limit — a house manifest with thousands of `brands[].properties[]`
 * entries would otherwise stall the publisher endpoint. Excess entries
 * are silently dropped after the cap; deduping happens before the cap, so
 * the result is the first N unique identifiers in document order.
 */
const MAX_BRAND_JSON_PROPERTIES = 5000;

/**
 * Inferred identifier shape for a property type. brand.json's `identifier`
 * field is a single string; we map it to the structured identifier shape
 * the registry uses. For non-website types we don't know the canonical
 * identifier kind (ios_bundle vs android_package vs roku_app_id, etc.),
 * so we fall back to a generic `{type: <propType>, value: id}` pair so
 * the value is preserved rather than dropped.
 */
function deriveIdentifiers(propType: string, id: string): Array<{ type: string; value: string }> {
  if (propType === "website") return [{ type: "domain", value: id }];
  return [{ type: propType, value: id }];
}

export function extractPublisherPropertiesFromBrandJson(
  manifest: Record<string, unknown> | null | undefined,
): PublisherPropertyFromBrandJson[] {
  if (!manifest || typeof manifest !== "object") return [];

  const seen = new Map<string, PublisherPropertyFromBrandJson>();

  function ingest(p: RawBrandJsonProperty): boolean {
    if (typeof p.identifier !== "string" || !p.identifier) return false;
    const id = p.identifier.toLowerCase();
    if (seen.has(id)) return false;

    const propType = typeof p.type === "string" && p.type ? p.type : "website";
    const relationship = typeof p.relationship === "string" ? p.relationship : undefined;

    const tags: string[] = [];
    if (relationship) tags.push(`relationship:${relationship}`);

    seen.set(id, {
      type: propType,
      name: id,
      identifiers: deriveIdentifiers(propType, id),
      tags,
      source: "brand_json",
    });
    return true;
  }

  // Walk top-level shape first, then house shape. Stop the moment we hit
  // the cap so a maliciously oversized manifest can't burn CPU.
  for (const p of readPropertyArray(manifest.properties)) {
    if (seen.size >= MAX_BRAND_JSON_PROPERTIES) return Array.from(seen.values());
    ingest(p);
  }

  const brands = Array.isArray(manifest.brands) ? manifest.brands : [];
  for (const b of brands) {
    if (!b || typeof b !== "object") continue;
    for (const p of readPropertyArray((b as Record<string, unknown>).properties)) {
      if (seen.size >= MAX_BRAND_JSON_PROPERTIES) return Array.from(seen.values());
      ingest(p);
    }
  }

  return Array.from(seen.values());
}
