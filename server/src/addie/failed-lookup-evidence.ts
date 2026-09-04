import type { ToolExecution } from './model-providers/tool-orchestration.js';
import { TOOL_SETS } from './tool-sets.js';

/**
 * Safe terminal text used when the model has no successful source result to
 * ground an answer. Keep this provider-neutral so every delivery adapter can
 * apply the same boundary.
 */
export const FAILED_LOOKUP_EVIDENCE_RESPONSE =
  "I couldn't verify that because every source lookup failed. I don't have enough evidence to answer or provide a link right now. Please try again.";

const SOURCE_LOOKUP_TOOL_NAMES = new Set([
  ...TOOL_SETS.knowledge.tools,
  ...TOOL_SETS.community_research.tools,
  ...TOOL_SETS.schema_reference.tools.filter((name) => name !== 'validate_json'),
  ...TOOL_SETS.partner_directory.tools.filter((name) => name !== 'request_introduction'),
  ...TOOL_SETS.agent_publisher_directory.tools,
  'web_search',
]);

export interface FailedLookupEvidenceResult {
  text: string;
  enforced: boolean;
  reason: string | null;
  failedToolNames: string[];
}

/**
 * Replace provider prose only when the execution ledger proves that every
 * completed operation was a source lookup and every lookup failed. A
 * successful lookup retains its grounded response, while any non-lookup
 * operation disables replacement so a completed mutation is never hidden.
 */
export function enforceFailedLookupEvidenceBoundary(
  text: string,
  toolExecutions: readonly ToolExecution[],
): FailedLookupEvidenceResult {
  if (
    toolExecutions.length === 0
    || !toolExecutions.every((execution) => SOURCE_LOOKUP_TOOL_NAMES.has(execution.tool_name))
    || toolExecutions.some((execution) => !execution.is_error)
  ) {
    return {
      text,
      enforced: false,
      reason: null,
      failedToolNames: [],
    };
  }

  const failedToolNames = [...new Set(toolExecutions.map((execution) => execution.tool_name))].sort();
  return {
    text: FAILED_LOOKUP_EVIDENCE_RESPONSE,
    enforced: true,
    reason: `Failed lookup evidence boundary enforced (${failedToolNames.join(', ')})`,
    failedToolNames,
  };
}
