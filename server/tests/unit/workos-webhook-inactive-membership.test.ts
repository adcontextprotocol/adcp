import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const WEBHOOK_FILE = path.resolve(__dirname, '../../src/routes/workos-webhooks.ts');
const source = fs.readFileSync(WEBHOOK_FILE, 'utf-8');

describe('non-active organization_membership webhook handling', () => {
  const nonActiveBlock = source.match(
    /if \(membership\.status !== 'active'\) \{([\s\S]*?)\n\s{2}\}/,
  )?.[1] ?? '';

  const localDeleteHelper = source.match(
    /async function deleteInactiveMembershipCache[\s\S]*?\n\}/,
  )?.[0] ?? '';

  it('routes non-active membership updates through local cache deletion only', () => {
    expect(nonActiveBlock).toContain('deleteInactiveMembershipCache(membership)');
    expect(nonActiveBlock).not.toContain('deleteMembership(membership)');
  });

  it('does not run owner-succession promotion for inactive memberships', () => {
    expect(localDeleteHelper).toContain('deleteOrganizationMembership');
    expect(localDeleteHelper).not.toContain('findSuccessorForPromotion');
    expect(localDeleteHelper).not.toContain('updateOrganizationMembership');
    expect(localDeleteHelper).not.toContain('setMembershipRole');
  });
});
