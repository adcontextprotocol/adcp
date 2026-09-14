import type { LearnerProgress } from '../db/certification-db.js';
import type { StoredToolCall } from './stream-tool-checkpoints.js';
import { classifyActiveCertificationProgress, type ActiveCertificationKind } from './slack-tool-selection.js';

type Progress = Pick<LearnerProgress, 'module_id' | 'status' | 'addie_thread_id'>;
interface HistoryMessage {
  role: string;
  delivery_status?: string;
  tool_calls?: readonly StoredToolCall[] | null;
}

/**
 * Keep an authenticated web lesson executable when it resumes in another chat,
 * or when placement has not created a progress row yet. Only owned progress
 * and actual tool receipts from the authorized thread establish this context;
 * user text and assistant claims cannot enroll a learner or grant credentials.
 */
export function resolveWebCertificationContext(
  progress: readonly Progress[],
  history: readonly HistoryMessage[],
  externalId: string,
  threadId: string,
): { kind: ActiveCertificationKind | null; moduleId?: string } {
  const active = progress.filter(entry => entry.status === 'in_progress');
  const bound = active.filter(entry =>
    entry.addie_thread_id === externalId || entry.addie_thread_id === threadId,
  );
  const moduleIds = new Set(bound.map(entry => entry.module_id));
  let placement = false;

  for (const message of history) {
    if (message.role !== 'assistant' || message.delivery_status === 'interrupted') continue;
    for (const call of message.tool_calls ?? []) {
      // Reservations and rejected/unknown calls are not evidence of an active
      // workflow. Legacy successful receipts may omit result_status.
      if (call.is_error !== false || (call.result_status && call.result_status !== 'ok')) continue;
      const input = call.input && typeof call.input === 'object' && !Array.isArray(call.input)
        ? call.input as Record<string, unknown> : {};
      if (call.name === 'test_out_modules' && Array.isArray(input.module_ids)) {
        placement ||= input.module_ids.some(id => typeof id === 'string'
          && !progress.some(entry => entry.module_id === id.toUpperCase()
            && ['completed', 'tested_out'].includes(entry.status)));
      } else if (call.name === 'get_learner_progress') {
        // The user actually consulted their learning state in this chat. An
        // unfinished module elsewhere alone must not hijack unrelated chats.
        for (const entry of active) moduleIds.add(entry.module_id);
      } else if ([
        'start_certification_module', 'checkpoint_teaching_progress',
        'get_build_phase_instructions', 'start_certification_exam',
      ].includes(call.name) && typeof input.module_id === 'string') {
        const moduleId = input.module_id.toUpperCase();
        if (active.some(entry => entry.module_id === moduleId)) moduleIds.add(moduleId);
      }
    }
  }

  const moduleKind = classifyActiveCertificationProgress(active.filter(entry => moduleIds.has(entry.module_id)));
  const kind = placement
    ? moduleKind === 'learning' || moduleKind === 'mixed' ? 'mixed' : 'assessment'
    : moduleKind;
  return { kind, ...(moduleIds.size === 1 ? { moduleId: [...moduleIds][0] } : {}) };
}
