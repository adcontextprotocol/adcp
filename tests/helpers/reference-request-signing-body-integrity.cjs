const REQUIRED_MODES = new Set([
  'required_for',
  'protocol_methods_required_for',
]);
const WARN_MODES = new Set([
  'warn_for',
  'protocol_methods_warn_for',
]);

function usesUniversalBodyIntegrity(profile) {
  const match = /^(\d+)\.(\d+)(?:-|$)/.exec(profile);
  if (!match) throw new Error(`invalid endpoint_profile: ${profile}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 3 || (major === 3 && minor >= 2);
}

function fallbackOrUnauthenticated(input) {
  if (input.fallback_auth_valid) {
    return { action: 'accept_with_warning', authentication_source: 'fallback', verified_signer_identity: false };
  }
  return { action: 'reject_unauthenticated', verified_signer_identity: false };
}

/**
 * Canonical post-parse policy evaluator for the AdCP request-signing profile.
 * Inputs are verifier facts produced before dispatch; outputs are the normative
 * transport/authentication decision. Cryptographic parsing and verification are
 * deliberately outside this small policy layer and have their own wire vectors.
 */
function evaluateBodyIntegrity(input) {
  const universalBodyIntegrity = usesUniversalBodyIntegrity(input.endpoint_profile);

  if (input.signature_header_state === 'malformed_pair') {
    return { action: 'reject', error_code: 'request_signature_header_malformed', verified_signer_identity: false };
  }

  if (!input.signature_present) {
    if (input.fallback_auth_valid) {
      return { action: 'accept', authentication_source: 'fallback', verified_signer_identity: false };
    }
    if (REQUIRED_MODES.has(input.mode)) {
      return { action: 'reject', error_code: 'request_signature_required', verified_signer_identity: false };
    }
    return { action: 'reject_unauthenticated', verified_signer_identity: false };
  }

  if (universalBodyIntegrity && input.has_body && !input.covers_content_digest) {
    if (WARN_MODES.has(input.mode)) return fallbackOrUnauthenticated(input);
    return { action: 'reject', error_code: 'request_signature_components_incomplete', verified_signer_identity: false };
  }

  if (input.cryptographic_signature_valid === false) {
    if (WARN_MODES.has(input.mode)) return fallbackOrUnauthenticated(input);
    return { action: 'reject', error_code: 'request_signature_invalid', verified_signer_identity: false };
  }

  if (input.covers_content_digest && input.digest_matches_body === false) {
    if (WARN_MODES.has(input.mode)) return fallbackOrUnauthenticated(input);
    return { action: 'reject', error_code: 'request_signature_digest_mismatch', verified_signer_identity: false };
  }

  return { action: 'accept', authentication_source: 'signature', verified_signer_identity: true };
}

module.exports = { evaluateBodyIntegrity, usesUniversalBodyIntegrity };
