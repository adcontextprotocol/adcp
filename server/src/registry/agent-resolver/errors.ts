/**
 * Error class for the AAO hosted agent resolver.
 *
 * The `code` strings match the `request_signature_*` family from
 * `docs/building/implementation/security.mdx` and the spec at
 * `specs/capabilities-brand-url.md` §"Error codes". `detail` carries the
 * structured fields for that code so callers can fix the misconfiguration
 * without log archaeology.
 */
export type AgentResolverErrorCode =
  | "request_signature_brand_url_missing"
  | "request_signature_capabilities_unreachable"
  | "request_signature_brand_json_unreachable"
  | "request_signature_brand_origin_mismatch"
  | "request_signature_agent_not_in_brand_json"
  | "request_signature_brand_json_ambiguous"
  | "request_signature_key_origin_mismatch"
  | "request_signature_key_origin_missing"
  | "request_signature_jwks_unreachable"
  | "request_signature_invalid_agent_url"
  | "request_signature_oversize_response";

export interface AgentResolverErrorDetail {
  // Common
  agent_url?: string;
  brand_url?: string;
  http_status?: number;
  dns_error?: string;
  last_attempt_at?: string;
  // Origin mismatch
  agent_etld1?: string;
  brand_url_etld1?: string;
  // Ambiguity
  matched_count?: number;
  matched_entries?: { url: string; id?: string }[];
  // Key-origin mismatch / missing
  purpose?: string;
  expected_origin?: string;
  actual_origin?: string;
  posture?: string;
  // jwks fetch
  jwks_uri?: string;
  // Generic
  reason?: string;
}

export class AgentResolverError extends Error {
  readonly code: AgentResolverErrorCode;
  readonly detail: AgentResolverErrorDetail;
  /** HTTP status the route should serve. Per spec, failures use 502 unless
   * upstream itself returned a 4xx that we want to surface. */
  readonly httpStatus: number;

  constructor(
    code: AgentResolverErrorCode,
    detail: AgentResolverErrorDetail,
    httpStatus = 502,
  ) {
    super(code);
    this.name = "AgentResolverError";
    this.code = code;
    this.detail = detail;
    this.httpStatus = httpStatus;
  }
}
