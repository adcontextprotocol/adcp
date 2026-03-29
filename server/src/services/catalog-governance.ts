/**
 * Catalog Governance — dispute triage, corroboration checks, link auditing.
 *
 * Core principle: adding links is hard, removing suspicious links is easy.
 *
 * Three layers of protection:
 * 1. Auto-link only for authoritative/strong evidence
 * 2. Corroboration requirement for medium/weak assertions
 * 3. Dispute-first suspension: medium/weak links suspended immediately on dispute
 */

import { CatalogDatabase } from '../db/catalog-db.js';
import { CatalogDisputesDatabase, type DisputeType } from '../db/catalog-disputes-db.js';
import { query } from '../db/client.js';

const catalogDb = new CatalogDatabase();
const disputesDb = new CatalogDisputesDatabase();

export interface DisputeInput {
  dispute_type: DisputeType;
  subject_type: string;      // 'identifier', 'property_rid', 'link'
  subject_value: string;     // the identifier or rid being disputed
  reported_by: string;       // member_id
  reported_by_email?: string;
  claim: string;
  evidence?: string;
}

export interface TriageResult {
  dispute_id: string;
  action_taken: 'link_suspended' | 'queued_for_review' | 'escalated';
  reason: string;
}

/**
 * File a dispute and perform automatic triage.
 *
 * Triage rules:
 * - identifier_link disputes on medium/weak confidence → suspend immediately
 * - identifier_link disputes on authoritative/strong → queue for review (no suspension)
 * - classification disputes → queue for review (no immediate change)
 * - false_merge disputes → queue for review
 */
export async function fileDispute(input: DisputeInput): Promise<TriageResult> {
  const dispute = await disputesDb.createDispute(input);

  if (input.dispute_type === 'identifier_link') {
    // Check the confidence of the disputed link
    const linkConfidence = await getIdentifierLinkConfidence(input.subject_value);

    if (linkConfidence && (linkConfidence === 'medium' || linkConfidence === 'weak')) {
      // Suspend immediately — safe default for low-confidence links
      const [identType, ...identParts] = input.subject_value.split(':');
      const identValue = identParts.join(':');

      if (identType && identValue) {
        await catalogDb.suspendIdentifierLink(identType, identValue, input.claim, input.reported_by);
      }

      await disputesDb.updateDisputeStatus(dispute.id, 'investigating');

      return {
        dispute_id: dispute.id,
        action_taken: 'link_suspended',
        reason: `Link suspended immediately (confidence: ${linkConfidence}). Pending review.`,
      };
    }

    if (linkConfidence && (linkConfidence === 'authoritative' || linkConfidence === 'strong')) {
      // Do NOT suspend — authoritative/strong links require review first
      await disputesDb.updateDisputeStatus(dispute.id, 'investigating');

      return {
        dispute_id: dispute.id,
        action_taken: 'queued_for_review',
        reason: `Link has ${linkConfidence} confidence. Queued for review without suspension.`,
      };
    }
  }

  // All other dispute types: queue for review
  await disputesDb.updateDisputeStatus(dispute.id, 'investigating');

  return {
    dispute_id: dispute.id,
    action_taken: 'queued_for_review',
    reason: 'Queued for review.',
  };
}

/**
 * Resolve a dispute after review (by Addie or admin).
 */
export async function resolveDispute(
  disputeId: string,
  verdict: 'upheld' | 'rejected',
  resolution: string,
  resolvedBy: string
): Promise<void> {
  const dispute = await disputesDb.getDispute(disputeId);
  if (!dispute) throw new Error(`Dispute not found: ${disputeId}`);

  if (verdict === 'upheld') {
    // Dispute was correct — make the change permanent
    if (dispute.dispute_type === 'identifier_link') {
      // Link stays suspended (was already suspended during triage, or now gets suspended)
      const [identType, ...identParts] = dispute.subject_value.split(':');
      const identValue = identParts.join(':');
      if (identType && identValue) {
        await catalogDb.suspendIdentifierLink(identType, identValue, resolution, resolvedBy);
      }
    }
    await disputesDb.updateDisputeStatus(disputeId, 'resolved', resolution, resolvedBy);
  } else {
    // Dispute was incorrect — reinstate if suspended
    if (dispute.dispute_type === 'identifier_link') {
      const [identType, ...identParts] = dispute.subject_value.split(':');
      const identValue = identParts.join(':');
      if (identType && identValue) {
        await catalogDb.reinstateIdentifierLink(identType, identValue, resolvedBy);
      }
    }
    await disputesDb.updateDisputeStatus(disputeId, 'rejected', resolution, resolvedBy);
  }
}

/**
 * Escalate a dispute to human admin.
 */
export async function escalateDispute(disputeId: string, reason: string): Promise<void> {
  await disputesDb.updateDisputeStatus(disputeId, 'escalated', reason, 'system:addie');
}

/**
 * Get the confidence level of an identifier link.
 * Returns null if the identifier is not linked.
 */
async function getIdentifierLinkConfidence(subjectValue: string): Promise<string | null> {
  // subject_value format: "identifier_type:identifier_value"
  const [identType, ...identParts] = subjectValue.split(':');
  const identValue = identParts.join(':');

  if (!identType || !identValue) return null;

  const result = await query<{ confidence: string }>(
    `SELECT confidence FROM catalog_identifiers
     WHERE identifier_type = $1 AND identifier_value = $2`,
    [identType, identValue]
  );

  return result.rows[0]?.confidence ?? null;
}

/**
 * Audit links: find medium/weak links with no corroboration after N days.
 * Run as a daily cron job. Flags links for review.
 */
export async function auditUncorroboratedLinks(maxAgeDays: number = 30): Promise<{
  flagged: number;
  identifiers: Array<{ type: string; value: string; property_rid: string; age_days: number }>;
}> {
  const result = await query<{
    identifier_type: string;
    identifier_value: string;
    property_rid: string;
    age_days: number;
  }>(
    `SELECT ci.identifier_type, ci.identifier_value, ci.property_rid,
            EXTRACT(DAY FROM NOW() - ci.created_at)::int AS age_days
     FROM catalog_identifiers ci
     WHERE ci.confidence IN ('medium', 'weak')
       AND ci.disputed = FALSE
       AND ci.created_at < NOW() - ($1 || ' days')::interval
       AND NOT EXISTS (
         SELECT 1 FROM catalog_facts cf
         WHERE cf.fact_type = 'linking'
           AND cf.subject_value = ci.identifier_type || ':' || ci.identifier_value
           AND cf.object_value = ci.property_rid::text
           AND cf.actor != (
             SELECT cf2.actor FROM catalog_facts cf2
             WHERE cf2.fact_type = 'linking'
               AND cf2.subject_value = ci.identifier_type || ':' || ci.identifier_value
               AND cf2.object_value = ci.property_rid::text
             ORDER BY cf2.created_at ASC
             LIMIT 1
           )
           AND cf.superseded_by IS NULL
       )`,
    [maxAgeDays]
  );

  return {
    flagged: result.rows.length,
    identifiers: result.rows.map(r => ({
      type: r.identifier_type,
      value: r.identifier_value,
      property_rid: r.property_rid,
      age_days: r.age_days,
    })),
  };
}
