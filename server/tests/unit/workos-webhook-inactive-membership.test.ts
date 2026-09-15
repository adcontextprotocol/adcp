import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const WEBHOOK_FILE = path.resolve(__dirname, '../../src/routes/workos-webhooks.ts');
const source = fs.readFileSync(WEBHOOK_FILE, 'utf-8');

describe('organization_membership webhook reconciliation', () => {
  const upsertStart = source.indexOf('async function upsertMembership(');
  const upsertEnd = source.indexOf('async function upsertUser(', upsertStart);
  const upsertHelper = source.slice(upsertStart, upsertEnd);
  const absentStart = upsertHelper.indexOf('if (!current) {');
  const absentEnd = upsertHelper.indexOf('// Fetch the user only after', absentStart);
  const providerAbsentBlock = upsertHelper.slice(absentStart, absentEnd);
  const updatedBlock = source.match(
    /case 'organization_membership\.updated': \{([\s\S]*?)break;/,
  )?.[1] ?? '';
  const deletedBlock = source.match(
    /case 'organization_membership\.deleted': \{([\s\S]*?)break;/,
  )?.[1] ?? '';

  it('reconciles both role updates and delete replays against current provider state', () => {
    expect(updatedBlock).toContain('await upsertMembership(membership)');
    expect(deletedBlock).toContain('await upsertMembership(membership)');
    expect(upsertHelper).toContain('currentProviderMembership(membership)');
  });

  it('deletes only the exact provider-confirmed absent membership without owner succession', () => {
    expect(providerAbsentBlock).toContain('deleteExactOrganizationMembership(');
    expect(providerAbsentBlock).toContain('membership.user_id,');
    expect(providerAbsentBlock).toContain('membership.organization_id,');
    expect(providerAbsentBlock).toContain('membership.id,');
    expect(providerAbsentBlock).not.toContain('getUser');
    expect(providerAbsentBlock).not.toContain('findSuccessorForPromotion');
    expect(providerAbsentBlock).not.toContain('updateOrganizationMembership');
    expect(providerAbsentBlock).not.toContain('setMembershipRole');
  });
});
