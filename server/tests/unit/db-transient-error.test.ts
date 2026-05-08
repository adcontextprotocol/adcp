import { describe, it, expect } from 'vitest';
import { isTransientConnectionError } from '../../src/db/client.js';

function errWithCode(code: string, message = ''): Error {
  const e = new Error(message);
  (e as any).code = code;
  return e;
}

describe('isTransientConnectionError', () => {
  it('matches pg error codes that should be retried', () => {
    expect(isTransientConnectionError(errWithCode('ECONNRESET'))).toBe(true);
    expect(isTransientConnectionError(errWithCode('EPIPE'))).toBe(true);
    expect(isTransientConnectionError(errWithCode('57P01'))).toBe(true);
    expect(isTransientConnectionError(errWithCode('57P03'))).toBe(true);
    expect(isTransientConnectionError(errWithCode('08006'))).toBe(true);
    expect(isTransientConnectionError(errWithCode('08003'))).toBe(true);
  });

  it('matches pg-pool messages that have no error code', () => {
    expect(isTransientConnectionError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(
      isTransientConnectionError(new Error('Connection terminated due to connection timeout')),
    ).toBe(true);
  });

  it('matches even when the message is wrapped with extra prefix or suffix', () => {
    expect(
      isTransientConnectionError(new Error('error: Connection terminated unexpectedly')),
    ).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isTransientConnectionError(new Error('relation "foo" does not exist'))).toBe(false);
    expect(isTransientConnectionError(errWithCode('23505', 'duplicate key'))).toBe(false);
    expect(isTransientConnectionError(null)).toBe(false);
    expect(isTransientConnectionError('string error')).toBe(false);
    expect(isTransientConnectionError(undefined)).toBe(false);
  });
});
