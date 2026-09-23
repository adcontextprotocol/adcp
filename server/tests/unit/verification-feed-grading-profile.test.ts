import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('../../src/db/encryption.js', () => ({
  decrypt: vi.fn(),
  encrypt: vi.fn(),
  deriveKey: vi.fn(),
}));

import { CatalogEventsDatabase } from '../../src/db/catalog-events-db.js';
import { ComplianceDatabase } from '../../src/db/compliance-db.js';
import { getClient } from '../../src/db/client.js';

const mockedGetClient = vi.mocked(getClient);
const eventSchema = JSON.parse(readFileSync(
  resolve(__dirname, '../../../static/schemas/source/core/registry-event.json'),
  'utf8',
));
const ajv = new Ajv({ strict: false, allErrors: true });

function gradingProfileSchema(eventType: string): object {
  const branch = eventSchema.oneOf.find(
    (candidate: any) => candidate.properties?.event_type?.const === eventType,
  );
  return branch.properties.payload.properties.grading_profile;
}

describe('verification change feed grading provenance', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('publishes the grading profile on earned and lost events', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [{
            role: 'media-buy',
            adcp_version: '3.1',
            verified_specialisms: ['sales-non-guaranteed'],
            grading_profile: 'spec',
            generation: '4',
          }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [{
            role: 'creative',
            adcp_version: '3.1',
            grading_profile: 'legacy',
            generation: '4',
          }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }),
      release: vi.fn(),
    };
    mockedGetClient.mockResolvedValue(client as never);
    const writeEvent = vi.spyOn(CatalogEventsDatabase.prototype, 'writeEvent')
      .mockResolvedValue(undefined as never);

    await new ComplianceDatabase().publishVerificationChangeEventsIfCurrent(
      'https://seller.example.test/mcp',
      [{ role: 'media-buy', adcp_version: '3.1' }],
      [{ role: 'creative', adcp_version: '3.1', reason: 'Compliance failed' }],
      'test',
    );

    expect(writeEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      event_type: 'agent.verification_earned',
      payload: expect.objectContaining({ grading_profile: 'spec' }),
    }), client);
    expect(writeEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      event_type: 'agent.verification_lost',
      payload: expect.objectContaining({ grading_profile: 'legacy' }),
    }), client);
  });

  it('constrains feed grading profiles to Legacy or Strict Spec', () => {
    const validateEarnedProfile = ajv.compile(gradingProfileSchema('agent.verification_earned'));
    const validateLostProfile = ajv.compile(gradingProfileSchema('agent.verification_lost'));

    expect(validateEarnedProfile('spec')).toBe(true);
    expect(validateLostProfile('legacy')).toBe(true);
    expect(validateEarnedProfile('sandbox')).toBe(false);
    expect(validateLostProfile('sandbox')).toBe(false);
  });
});
