export type EngineErrorCode =
  | 'INVALID_SEED'
  | 'UNKNOWN_PRODUCT'
  | 'INVALID_TARGETING'
  | 'INVALID_BOOKING'
  | 'SOLD_OUT'
  | 'BOOKING_NOT_FOUND'
  | 'DUPLICATE_BOOKING'
  | 'CLOCK_BACKWARDS';

/** A refusal the host maps onto its own error vocabulary. */
export class EngineError extends Error {
  constructor(readonly code: EngineErrorCode, message: string) {
    super(message);
    this.name = 'EngineError';
  }
}
