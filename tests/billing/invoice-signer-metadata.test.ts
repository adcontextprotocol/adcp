import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('invoice signer metadata invariants', () => {
  test('authenticated invoice request passes the signer into Stripe invoice creation', () => {
    const source = readRepoFile('server/src/routes/billing-public.ts');

    expect(source).toMatch(
      /const invoiceData: InvoiceRequestData = \{[\s\S]*workosOrganizationId: orgId,\s*workosUserId: user\.id,[\s\S]*\};/
    );
  });

  test('suspended membership invite acceptance cannot issue an invoice', () => {
    const source = readRepoFile('server/src/routes/invites.ts');
    expect(source).toContain("error: 'organization_onboarding_disabled'");
    expect(source).not.toContain('createAndSendInvoice');
  });
});
