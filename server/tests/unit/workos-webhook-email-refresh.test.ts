import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Static-analysis test for the user.updated webhook handler.
 * Asserts that updateUserAcrossMemberships refreshes both denormalized email
 * columns (organization_memberships and person_relationships) when WorkOS
 * pushes a user-update event — a regression here re-introduces the drift
 * that migration 476 had to backfill.
 */

const WEBHOOK_FILE = path.resolve(
  __dirname,
  '../../src/routes/workos-webhooks.ts'
);

describe('updateUserAcrossMemberships denormalized email refresh', () => {
  const source = fs.readFileSync(WEBHOOK_FILE, 'utf-8');

  it('refreshes organization_memberships.email from the webhook payload', () => {
    expect(source).toMatch(/UPDATE organization_memberships[\s\S]*?SET[\s\S]*?email = \$1/);
  });

  it('refreshes person_relationships.email from the webhook payload', () => {
    expect(source).toMatch(/UPDATE person_relationships SET email = \$1/);
  });
});
