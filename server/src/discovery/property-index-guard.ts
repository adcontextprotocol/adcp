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
