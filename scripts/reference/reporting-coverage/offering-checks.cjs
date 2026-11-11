'use strict';

/**
 * Reference for the seller-side offering checks an SDK runs before it enables
 * experimental principal-level reporting subscriptions
 * (media_buy.reporting_subscriptions), written from the spec text:
 *
 * - SUBSCRIPTIONS_REQUIRE_STANDARD_DIMENSIONS: sync_principal and
 *   core/reporting-delivery-offering.json standard_dimensions, "Sellers
 *   advertising subscriptions MUST publish standard_dimensions on every
 *   offering."
 * - SUBSCRIPTIONS_REQUIRE_ACCOUNT_ID_KEY: core/reporting-delivery-offering.json
 *   x-adcp-validation subscription_rows, "MUST publish, on every offering with
 *   method, a reporting_profile whose row schema (schema_uri) declares
 *   account_id as a required string property, and whose primary_keys include
 *   account_id ... Core offerings ... are exempt."
 *
 * The codes are frozen in
 * static/compliance/source/test-vectors/reporting-subscriptions/error-codes.json,
 * and offering-checks.json beside it holds the vectors.
 */

/**
 * Every failure, in offering order and, per offering, in the order above.
 * rowSchemas maps a reporting_profile.schema_uri to the row schema an SDK
 * fetched for it; a schema it does not have is not checked.
 */
function checkOfferings(offerings, rowSchemas = {}) {
  const failures = [];
  for (const offering of offerings) {
    if (!Array.isArray(offering.standard_dimensions)) {
      failures.push({ code: 'SUBSCRIPTIONS_REQUIRE_STANDARD_DIMENSIONS', offering_id: offering.offering_id });
    }
    if (offering.method === undefined) continue; // Core offerings are exempt.
    const profile = offering.reporting_profile ?? {};
    if (!(profile.primary_keys ?? []).includes('account_id')) {
      failures.push({ code: 'SUBSCRIPTIONS_REQUIRE_ACCOUNT_ID_KEY', offering_id: offering.offering_id, missing: 'primary_key' });
    }
    const rowSchema = rowSchemas[profile.schema_uri];
    if (rowSchema !== undefined && !declaresRequiredString(rowSchema, 'account_id')) {
      failures.push({ code: 'SUBSCRIPTIONS_REQUIRE_ACCOUNT_ID_KEY', offering_id: offering.offering_id, missing: 'row_schema' });
    }
  }
  return failures;
}

/** The row schema lists the property in required and declares it with type "string". */
function declaresRequiredString(schema, name) {
  const property = schema?.properties?.[name];
  return Array.isArray(schema?.required) && schema.required.includes(name) && property?.type === 'string';
}

module.exports = { checkOfferings };
