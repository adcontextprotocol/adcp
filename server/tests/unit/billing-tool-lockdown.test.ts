/**
 * Billing-tool lockdown tests
 *
 * Asserts that Addie's billing-related tools cannot be used to mint Stripe
 * customers / invoices / checkout sessions on behalf of unauthenticated
 * users or with caller-supplied email addresses.
 *
 * The previous shape of these tools accepted free-text emails and let an
 * agent-supplied address become the Stripe customer of record, which
 * cross-contaminated two distinct organizations (Triton/Encypher, Apr 2026).
 */
import { describe, it, expect } from 'vitest';

process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'test';
process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';

const {
  BILLING_TOOLS,
  createBillingToolHandlers,
} = await import('../../src/addie/mcp/billing-tools.js');
const { ADMIN_TOOLS } = await import('../../src/addie/mcp/admin-tools.js');

function getToolSchema(name: string, source: typeof BILLING_TOOLS | typeof ADMIN_TOOLS) {
  const tool = source.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.input_schema as {
    properties: Record<string, unknown>;
    required?: string[];
  };
}

describe('create_payment_link tool', () => {
  it('does not accept caller-supplied customer email', () => {
    const schema = getToolSchema('create_payment_link', BILLING_TOOLS);
    expect(schema.properties).not.toHaveProperty('customer_email');
  });

  it('refuses when there is no signed-in member context', async () => {
    const handlers = createBillingToolHandlers(null);
    const result = JSON.parse(await handlers.get('create_payment_link')!({ lookup_key: 'aao_membership_test' }));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/sign(?:ed)? in/i);
  });

  it('refuses when the member has no workspace yet', async () => {
    const handlers = createBillingToolHandlers({
      is_mapped: true,
      is_member: false,
      workos_user: { workos_user_id: 'user_123', email: 'someone@example.com' },
      // organization intentionally absent
    });
    const result = JSON.parse(await handlers.get('create_payment_link')!({ lookup_key: 'aao_membership_test' }));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/workspace/i);
  });
});

describe('send_invoice / confirm_send_invoice tools', () => {
  it('send_invoice does not accept caller-supplied identity fields', () => {
    const schema = getToolSchema('send_invoice', BILLING_TOOLS);
    expect(schema.properties).not.toHaveProperty('contact_email');
    expect(schema.properties).not.toHaveProperty('contact_name');
    expect(schema.properties).not.toHaveProperty('company_name');
    expect(schema.properties).not.toHaveProperty('billing_address');
  });

  it('confirm_send_invoice does not accept caller-supplied identity fields', () => {
    const schema = getToolSchema('confirm_send_invoice', BILLING_TOOLS);
    expect(schema.properties).not.toHaveProperty('contact_email');
    expect(schema.properties).not.toHaveProperty('contact_name');
    expect(schema.properties).not.toHaveProperty('company_name');
    expect(schema.properties).not.toHaveProperty('billing_address');
  });

  it('confirm_send_invoice refuses without a signed-in member context', async () => {
    const handlers = createBillingToolHandlers(null);
    const result = JSON.parse(await handlers.get('confirm_send_invoice')!({ lookup_key: 'aao_invoice_test' }));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/sign(?:ed)? in/i);
  });
});

describe('send_payment_request admin tool', () => {
  it('exposes only the safe action enum (no direct-issue actions)', () => {
    const schema = getToolSchema('send_payment_request', ADMIN_TOOLS);
    const action = schema.properties.action as { enum?: string[] };
    expect(action.enum).toBeDefined();
    expect(action.enum).toEqual(
      expect.arrayContaining(['lookup_only', 'draft_invoice', 'send_invite']),
    );
    expect(action.enum).not.toContain('payment_link');
    expect(action.enum).not.toContain('send_invoice');
    expect(action.enum).not.toContain('invoice');
  });

  it('does not accept the legacy billing_address parameter', () => {
    const schema = getToolSchema('send_payment_request', ADMIN_TOOLS);
    expect(schema.properties).not.toHaveProperty('billing_address');
  });
});
