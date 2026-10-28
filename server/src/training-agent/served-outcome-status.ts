/**
 * One table for the task outcomes AdCP 3.1 moved out of the top-level
 * `status` key.
 *
 * In 3.0 these responses carried a domain outcome in `status`. From 3.1
 * `status` is the envelope task status (`enums/task-status.json`) and the
 * outcome has its own field (#4897). Handlers emit the 3.1 shape; the
 * transport adapters project it onto a served 3.0 here, before the SDK
 * shapes the response to the served release.
 */

import { servesOutcomeInEnvelopeStatus } from './types.js';

/** Tool name → the field that carries its outcome from 3.1. */
export const OUTCOME_FIELD_RENAMED_FROM_STATUS: Readonly<Record<string, string>> = Object.freeze({
  acquire_rights: 'rights_status',
  check_governance: 'verdict',
  creative_approval: 'approval_status',
  report_plan_outcome: 'outcome_state',
});

/**
 * Shapes a handler result for the served release: on a served 3.0 the
 * outcome is also carried in `status`, as the 3.0 schemas define it. The 3.1
 * field stays: the 3.0 response schemas are open, and in-process readers use
 * it. Results for other tools and releases, and results without the outcome
 * field (errors), are returned unchanged.
 */
export function projectTaskOutcomeForRelease<T>(toolName: string, result: T, servedVersion: string | undefined): T {
  const field = OUTCOME_FIELD_RENAMED_FROM_STATUS[toolName];
  if (!field || !servesOutcomeInEnvelopeStatus(servedVersion)) return result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  if (typeof record[field] !== 'string') return result;
  return { ...record, status: record[field] } as T;
}
