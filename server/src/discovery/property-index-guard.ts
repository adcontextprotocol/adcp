import { getPropertyIndex } from "@adcp/client";
import { createLogger } from "../logger.js";

const log = createLogger("property-index-guard");

let hardened = false;

/**
 * @adcp/client's PropertyIndex.addProperty assumes property.identifiers is iterable,
 * but adagents.json files in the wild sometimes omit the field entirely. Replace
 * a missing/non-array value with [] before delegating, so the property still lands
 * in the agent index even though it won't have any identifier-key entries.
 *
 * Remove this once @adcp/client guards the iteration upstream.
 */
export function hardenPropertyIndex(): void {
  if (hardened) return;
  hardened = true;

  const index = getPropertyIndex();
  const original = index.addProperty.bind(index);

  index.addProperty = function patchedAddProperty(property, agentUrl, publisherDomain) {
    const identifiers = (property as { identifiers?: unknown }).identifiers;
    if (!Array.isArray(identifiers)) {
      log.warn(
        { agentUrl, publisherDomain, propertyName: property?.name, propertyId: property?.property_id },
        "Property missing identifiers array; coercing to empty",
      );
      return original({ ...property, identifiers: [] }, agentUrl, publisherDomain);
    }
    return original(property, agentUrl, publisherDomain);
  };
}

export interface SanitizedAdagentsProperty {
  property_id?: string;
  property_type: string;
  name: string;
  identifiers: Array<{ type: string; value: string }>;
  tags?: string[];
  publisher_domain?: string;
}

/**
 * Validate a property entry from a publisher's adagents.json before we hand it
 * to the federated-index DB writer. Real-world manifests sometimes omit
 * required fields (property_type/name) or ship a non-array identifiers value;
 * upsertProperty would otherwise fail the entire crawl with a NOT NULL
 * violation or a TypeError. Returns null for properties that can't be
 * recovered so the caller can skip them and keep crawling.
 */
export function sanitizeAdagentsProperty(
  raw: unknown,
  context: { publisherDomain: string; agentUrl: string },
): SanitizedAdagentsProperty | null {
  if (!raw || typeof raw !== "object") {
    log.warn(context, "Skipping property: not an object");
    return null;
  }
  const prop = raw as Record<string, unknown>;
  const propertyType = typeof prop.property_type === "string" ? prop.property_type : "";
  const name = typeof prop.name === "string" ? prop.name : "";

  if (!propertyType || !name) {
    log.warn(
      {
        ...context,
        propertyId: typeof prop.property_id === "string" ? prop.property_id : undefined,
        hasPropertyType: !!propertyType,
        hasName: !!name,
      },
      "Skipping property: missing required property_type or name",
    );
    return null;
  }

  const identifiers = Array.isArray(prop.identifiers)
    ? (prop.identifiers as Array<{ type: string; value: string }>)
    : [];

  return {
    property_id: typeof prop.property_id === "string" ? prop.property_id : undefined,
    property_type: propertyType,
    name,
    identifiers,
    tags: Array.isArray(prop.tags) ? (prop.tags as string[]) : undefined,
    publisher_domain: typeof prop.publisher_domain === "string" ? prop.publisher_domain : undefined,
  };
}
