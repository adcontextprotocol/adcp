import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  DISTRIBUTION_IDENTIFIER_TYPE_VALUES,
  isValidDistributionIdentifierType,
  normalizeCollectionDistributionIdentifier,
} from '../../../src/services/collection-identifier-normalization.js';

describe('social distribution identifier types', () => {
  it.each([
    'instagram_account_id',
    'instagram_handle',
    'facebook_page_id',
    'facebook_page_handle',
    'snapchat_profile_id',
    'snapchat_handle',
    'x_user_id',
    'x_handle',
  ])('accepts %s', (type) => {
    expect(isValidDistributionIdentifierType(type)).toBe(true);
  });

  it.each(['instagram_handle', 'facebook_page_handle', 'snapchat_handle', 'x_handle', 'youtube_channel_handle'])(
    'normalizes %s to @ plus the lowercased name',
    (type) => {
      expect(normalizeCollectionDistributionIdentifier(type, '  JuniperVale ')).toEqual({ type, value: '@junipervale' });
      expect(normalizeCollectionDistributionIdentifier(type, '@JuniperVale')).toEqual({ type, value: '@junipervale' });
    },
  );

  it('keeps stable IDs as sent, trimmed', () => {
    expect(normalizeCollectionDistributionIdentifier('instagram_account_id', ' 17841400000000000 ')).toEqual({
      type: 'instagram_account_id',
      value: '17841400000000000',
    });
    expect(normalizeCollectionDistributionIdentifier('x_user_id', '783214')).toEqual({ type: 'x_user_id', value: '783214' });
  });
});

describe('distribution identifier type parity with the schema enum', () => {
  const schema = JSON.parse(readFileSync(
    join(process.cwd(), 'static/schemas/source/enums/distribution-identifier-type.json'),
    'utf8',
  ));
  const schemaValues: string[] = schema.enum;

  it('matches the schema enum as a set', () => {
    const server = new Set<string>(DISTRIBUTION_IDENTIFIER_TYPE_VALUES);
    const missing = schemaValues.filter((v) => !server.has(v));
    const extra = [...server].filter((v) => !schemaValues.includes(v));
    expect(
      { missing, extra },
      `server list is missing [${missing.join(', ')}] and has extra [${extra.join(', ')}] vs distribution-identifier-type.json`,
    ).toEqual({ missing: [], extra: [] });
  });

  it.each(schemaValues)('accepts schema value %s', (type) => {
    expect(isValidDistributionIdentifierType(type)).toBe(true);
  });

  it('rejects a value outside the schema enum', () => {
    expect(isValidDistributionIdentifierType('myspace_id')).toBe(false);
  });
});
