import { createHash } from 'node:crypto';
import { canonicalize } from '@adcp/sdk';

/**
 * Hash the business payload authorized by an intent token.
 *
 * governance_context is added only after approval and envelope context is
 * transport correlation. Routing lives on check_governance.target_agent, not
 * inside this downstream payload. Everything else — including
 * idempotency_key — remains bound so a token cannot be replayed for a
 * different mutation.
 */
export function computeGovernedPayloadHash(payload: Record<string, unknown>): string {
  const businessPayload = Object.fromEntries(
    Object.entries(payload).filter(([key]) =>
      key !== 'governance_context' && key !== 'context'),
  );
  return createHash('sha256')
    .update(canonicalize(businessPayload))
    .digest('base64url');
}

/**
 * Exact report_plan_outcome replay identity. The retry key and transport
 * correlation context are metadata; governance_context is deliberately kept
 * because it is one member of the security-critical settlement tuple.
 */
export function computeGovernanceOutcomeHash(payload: Record<string, unknown>): string {
  const replayPayload = Object.fromEntries(
    Object.entries(payload).filter(([key]) => key !== 'idempotency_key' && key !== 'context'),
  );
  return createHash('sha256')
    .update(canonicalize(replayPayload))
    .digest('base64url');
}

/** Exact report_plan_adjustment replay identity. */
export function computeGovernanceAdjustmentHash(payload: Record<string, unknown>): string {
  const replayPayload = Object.fromEntries(
    Object.entries(payload).filter(([key]) => key !== 'idempotency_key' && key !== 'context'),
  );
  return createHash('sha256')
    .update(canonicalize(replayPayload))
    .digest('base64url');
}

/**
 * Portable digest for a seller delivery statement. The seller-assigned
 * resource identifier is included so the same metrics cannot be replayed
 * against another governed resource. The digest field itself is excluded.
 */
export function computeDeliveryStatementDigest(
  sellerReference: string,
  deliveryMetrics: Record<string, unknown>,
): string {
  const statement = Object.fromEntries(
    Object.entries(deliveryMetrics).filter(([key]) => key !== 'statement_digest'),
  );
  return `sha256:${createHash('sha256')
    .update(canonicalize({ seller_reference: sellerReference, delivery_metrics: statement }))
    .digest('hex')}`;
}
