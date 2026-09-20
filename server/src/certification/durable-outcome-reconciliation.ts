import { hasDurableHandlerOutcome } from '../addie/side-effect-claims.js';

export const DURABLE_RESERVATION_RESULT = 'External action dispatch reserved; outcome unknown.';

export interface AuditedToolCall {
  message_id: string;
  sequence_number: number;
  name: string;
  input: unknown;
  result: unknown;
  is_error?: boolean;
  result_status?: string;
  durable_outcome?: string;
}

export interface ReservationClassification {
  status: 'settled_known_handler_outcome' | 'settled_success' | 'orphaned_unknown';
  receipt_message_id: string | null;
  receipt_sequence_number: number | null;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(',')}}`;
}

function isLegacySuccessReceipt(call: AuditedToolCall): boolean {
  return call.result_status === 'ok'
    && call.is_error === false
    && typeof call.result === 'string'
    && call.result.length > 0
    && call.result !== 'The tool returned no content.'
    && call.result !== DURABLE_RESERVATION_RESULT;
}

/**
 * Classify an exact mutation reservation without treating model prose as
 * evidence. Only application-owned checkpoint fields can settle it.
 */
export function classifyReservation(
  reservation: AuditedToolCall,
  chronologicalCalls: readonly AuditedToolCall[],
): ReservationClassification {
  const inputKey = canonicalJson(reservation.input);
  const receipts = chronologicalCalls.filter((candidate) => (
    candidate.sequence_number > reservation.sequence_number
    && candidate.name === reservation.name
    && canonicalJson(candidate.input) === inputKey
  ));

  const known = receipts.find((candidate) => (
    candidate.durable_outcome === 'known'
    && hasDurableHandlerOutcome(candidate.name)
  ));
  if (known) {
    return {
      status: 'settled_known_handler_outcome',
      receipt_message_id: known.message_id,
      receipt_sequence_number: known.sequence_number,
    };
  }

  const success = receipts.find(isLegacySuccessReceipt);
  if (success) {
    return {
      status: 'settled_success',
      receipt_message_id: success.message_id,
      receipt_sequence_number: success.sequence_number,
    };
  }

  return {
    status: 'orphaned_unknown',
    receipt_message_id: null,
    receipt_sequence_number: null,
  };
}

