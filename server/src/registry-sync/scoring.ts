/**
 * Shared relevance scoring constants.
 *
 * Used by both the server SQL (agent-inventory-profiles-db.ts) and the
 * client-side AgentIndex (agent-index.ts). Keep these in sync — the whole
 * point of RegistrySync is that local queries match server results.
 *
 * score = matched_dimensions / total_query_dimensions
 *       + ln(property_count + 1) * PROPERTY_COUNT_WEIGHT
 *       + (has_tmp ? TMP_BOOST : 0)
 */

export const PROPERTY_COUNT_WEIGHT = 0.1;
export const TMP_BOOST = 0.05;
