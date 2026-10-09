import { describe, expect, it } from 'vitest';
import {
  classifyReservation,
  DURABLE_RESERVATION_RESULT,
  type AuditedToolCall,
} from '../../../src/certification/durable-outcome-reconciliation.js';

function call(overrides: Partial<AuditedToolCall> = {}): AuditedToolCall {
  return {
    message_id: 'message-1',
    sequence_number: 1,
    name: 'complete_certification_module',
    input: { module_id: 'C3', scores: { protocol_fluency: 87 } },
    result: DURABLE_RESERVATION_RESULT,
    is_error: true,
    ...overrides,
  };
}

describe('classifyReservation', () => {
  it('reports a crash without a later exact receipt as orphaned', () => {
    expect(classifyReservation(call(), [])).toEqual({
      status: 'orphaned_unknown',
      receipt_message_id: null,
      receipt_sequence_number: null,
    });
  });

  it('settles a certification gate rejection from its trusted marker', () => {
    const receipt = call({
      message_id: 'message-2',
      sequence_number: 2,
      result: 'NOT COMPLETED: Module C3 — missing evidence.',
      result_status: 'error',
      durable_outcome: 'known',
    });
    expect(classifyReservation(call(), [receipt])).toEqual({
      status: 'settled_known_handler_outcome',
      receipt_message_id: 'message-2',
      receipt_sequence_number: 2,
    });
  });

  it('does not trust the marker for an unallowlisted mutation', () => {
    const reservation = call({ name: 'schedule_meeting' });
    const receipt = call({
      message_id: 'message-2',
      sequence_number: 2,
      name: 'schedule_meeting',
      result: 'Calendar provider unavailable.',
      result_status: 'error',
      durable_outcome: 'known',
    });
    expect(classifyReservation(reservation, [receipt]).status).toBe('orphaned_unknown');
  });

  it('ignores a later receipt with different input', () => {
    const receipt = call({
      message_id: 'message-2',
      sequence_number: 2,
      input: { module_id: 'C3', scores: { protocol_fluency: 88 } },
      result: 'Module C3 completed!',
      is_error: false,
      result_status: 'ok',
    });
    expect(classifyReservation(call(), [receipt]).status).toBe('orphaned_unknown');
  });

  it('recognizes a legacy non-empty successful receipt', () => {
    const receipt = call({
      message_id: 'message-2',
      sequence_number: 2,
      result: 'Module C3 completed!',
      is_error: false,
      result_status: 'ok',
    });
    expect(classifyReservation(call(), [receipt]).status).toBe('settled_success');
  });
});

