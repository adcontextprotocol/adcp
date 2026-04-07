/**
 * User-Agent strings for automated outbound requests to agent endpoints.
 * Follows RFC 9110 convention with a +URL suffix pointing to documentation.
 */

const INFO_URL = 'https://agenticadvertising.org/docs/monitoring';

export const AAO_UA_HEALTH_CHECK = `AAO-HealthCheck/1.0 (+${INFO_URL})`;
export const AAO_UA_DISCOVERY = `AAO-Discovery/1.0 (+${INFO_URL})`;
export const AAO_UA_COMPLIANCE = `AAO-ComplianceCheck/1.0 (+${INFO_URL})`;
export const AAO_UA_VALIDATOR = `AAO-Validator/1.0 (+${INFO_URL})`;
