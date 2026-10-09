/**
 * Recover safe onboarding operations and durably surface ambiguous ones.
 *
 * Manual-reconciliation rows must not be replayed automatically because the
 * provider/local authority outcome is uncertain. The recurring scan creates a
 * deduplicated operator escalation instead, so those rows cannot remain silent.
 */
import type { WorkOS } from '@workos-inc/node';
import { getAuthorizationEnforcementWorkos } from '../../auth/workos-client.js';
import { createEscalation } from '../../db/escalation-db.js';
import {
  listManualOrganizationOnboardingOperations,
  reconcilePendingOrganizationOnboarding,
  type OrganizationOnboardingReconciliationResult,
} from '../../services/organization-bootstrap.js';

export type OrganizationOnboardingRecoveryJobResult =
  OrganizationOnboardingReconciliationResult & {
    manualScanned: number;
    manualQueued: number;
  };

export async function runOrganizationOnboardingReconciliationJob(
  workos: WorkOS = getAuthorizationEnforcementWorkos(),
  pendingLimit = 2,
  manualLimit = 10,
): Promise<OrganizationOnboardingRecoveryJobResult> {
  const result: OrganizationOnboardingRecoveryJobResult = {
    ...await reconcilePendingOrganizationOnboarding(workos, pendingLimit),
    manualScanned: 0,
    manualQueued: 0,
  };
  const manualOperations = await listManualOrganizationOnboardingOperations(manualLimit);
  result.manualScanned = manualOperations.length;

  for (const operation of manualOperations) {
    await createEscalation({
      workos_user_id: operation.authenticatedWorkosUserId,
      category: 'needs_human_action',
      priority: 'high',
      summary: `Organization onboarding operation ${operation.id} requires reconciliation`,
      addie_context: [
        `Operation ${operation.id} is durably fenced in manual_reconciliation.`,
        `Provider organization: ${operation.workosOrganizationId ?? 'not durably recorded'}.`,
        `Reason: ${operation.lastErrorCode ?? 'provider/local state divergence'}.`,
        'Do not replay ownership from email, canonical person, or a linked credential.',
        'Compare the exact authenticated WorkOS credential, provider organization and owner membership, and local organization state before resolving.',
      ].join(' '),
      dedup_key: `organization-onboarding-reconciliation:${operation.id}`,
    });
    result.manualQueued += 1;
  }

  return result;
}
