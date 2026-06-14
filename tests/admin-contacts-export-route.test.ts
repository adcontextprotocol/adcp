import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { Router } from 'express';
import request from 'supertest';

const {
  mockPoolQuery,
  mockLoadDraftAndState,
} = vi.hoisted(() => {
  process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'test';
  process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';
  return {
    mockPoolQuery: vi.fn<any>(),
    mockLoadDraftAndState: vi.fn<any>(),
  };
});

vi.mock('../server/src/middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user_admin', email: 'admin@example.com', is_admin: true };
    next();
  },
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  requireGlobalAdmin: [
    (req: any, _res: any, next: any) => {
      req.user = { id: 'user_admin', email: 'admin@example.com', is_admin: true };
      next();
    },
    (_req: any, _res: any, next: any) => next(),
  ],
}));

vi.mock('../server/src/db/client.js', () => ({
  getPool: () => ({ query: mockPoolQuery }),
}));

vi.mock('../server/src/billing/stripe-client.js', () => ({
  getPendingInvoices: vi.fn(),
  createCheckoutSession: vi.fn(),
  getProductsForCustomer: vi.fn(),
}));

vi.mock('../server/src/addie/jobs/announcement-handlers.js', () => ({
  markLinkedInPosted: vi.fn(),
  refreshReviewCardForOrg: vi.fn(),
  loadDraftAndState: (...args: unknown[]) => mockLoadDraftAndState(...args),
}));

import { setupAccountRoutes } from '../server/src/routes/admin/accounts.js';

function buildApp() {
  const app = express();
  const pageRouter = Router();
  const apiRouter = Router();
  setupAccountRoutes(pageRouter, apiRouter);
  app.use('/api/admin', apiRouter);
  return app;
}

beforeEach(() => {
  mockPoolQuery.mockReset();
  mockLoadDraftAndState.mockReset();
});

describe('GET /api/admin/accounts/contacts-export', () => {
  it('exports active member and org-level contacts with membership tier, company type, and primary contact', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          row_source: 'membership',
          membership_first_name: 'Alice',
          membership_last_name: 'Owner',
          user_first_name: null,
          user_last_name: null,
          email: 'alice@example.com',
          role: 'owner',
          company: 'Nova Brands',
          company_types: ['brand'],
          prospect_contact_name: 'Maya Mason and Lee Chen',
          prospect_contact_email: 'maya@example.com',
          prospect_contact_title: 'VP Marketing',
          membership_tier: 'company_standard',
          subscription_price_lookup_key: null,
          subscription_status: 'active',
          subscription_amount: null,
          subscription_interval: null,
          is_personal: false,
          subscription_product_name: null,
        },
        {
          row_source: 'org_contact',
          membership_first_name: null,
          membership_last_name: null,
          user_first_name: null,
          user_last_name: null,
          email: 'maya@example.com',
          role: null,
          company: 'Nova Brands',
          company_types: ['brand'],
          prospect_contact_name: 'Maya Mason and Lee Chen',
          prospect_contact_email: 'maya@example.com',
          prospect_contact_title: 'VP Marketing',
          membership_tier: 'company_standard',
          subscription_price_lookup_key: null,
          subscription_status: 'active',
          subscription_amount: null,
          subscription_interval: null,
          is_personal: false,
          subscription_product_name: null,
        },
        {
          row_source: 'membership',
          membership_first_name: 'Rin',
          membership_last_name: 'Patel',
          user_first_name: null,
          user_last_name: null,
          email: 'rin@example.com',
          role: 'member',
          company: 'Pinnacle Media',
          company_types: ['ai', 'adtech'],
          prospect_contact_name: null,
          prospect_contact_email: null,
          prospect_contact_title: null,
          membership_tier: null,
          subscription_price_lookup_key: 'aao_membership_partner_10000',
          subscription_status: 'active',
          subscription_amount: null,
          subscription_interval: null,
          is_personal: false,
          subscription_product_name: null,
        },
        {
          row_source: 'membership',
          membership_first_name: 'Zed',
          membership_last_name: 'Nulltier',
          user_first_name: null,
          user_last_name: null,
          email: 'zed@example.com',
          role: 'member',
          company: 'Zenith Data',
          company_types: ['data'],
          prospect_contact_name: null,
          prospect_contact_email: null,
          prospect_contact_title: null,
          membership_tier: null,
          subscription_price_lookup_key: null,
          subscription_status: 'active',
          subscription_amount: null,
          subscription_interval: null,
          is_personal: false,
          subscription_product_name: 'Raw Stripe Product',
        },
      ],
    });

    const response = await request(buildApp()).get('/api/admin/accounts/contacts-export');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain('member-contacts-');
    expect(response.text.split('\n')[0]).toBe('"First Name","Last Name","Title","Company","Email Address","Membership Type","Company Type","Primary Contact"');
    expect(response.text).toContain('"Alice","Owner","","Nova Brands","alice@example.com","Builder","Brand","No"');
    expect(response.text).toContain('"Maya Mason and Lee Chen","","VP Marketing","Nova Brands","maya@example.com","Builder","Brand","Yes"');
    expect(response.text).toContain('"Rin","Patel","","Pinnacle Media","rin@example.com","Partner","AI & Tech Platforms, Ad Tech","No"');
    expect(response.text).toContain('"Zed","Nulltier","","Zenith Data","zed@example.com","","Data & Measurement","No"');
    expect(response.text).not.toContain('Raw Stripe Product');
    expect(mockPoolQuery.mock.calls[0][0]).toContain("o.subscription_status = 'active' AND o.subscription_canceled_at IS NULL");
    expect(mockPoolQuery.mock.calls[0][0]).toContain('org_contact_rows AS');
    expect(mockPoolQuery.mock.calls[0][0]).toContain('NOT EXISTS');
  });
});

describe('GET /api/admin/activity-feed', () => {
  it('casts empty metadata arms to jsonb so the UNION matches payment metadata', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          source: 'payment',
          timestamp: new Date('2026-06-14T10:00:00Z'),
          action: 'subscription',
          actor_name: 'Nova Brands',
          org_name: 'Nova Brands',
          org_id: 'org_nova',
          description: 'Builder Membership',
          metadata: { amount: 250000, currency: 'usd' },
        },
      ],
    });

    const response = await request(buildApp()).get('/api/admin/activity-feed');

    expect(response.status).toBe(200);
    expect(response.body.activities[0].metadata).toEqual({ amount: 250000, currency: 'usd' });
    const sql = mockPoolQuery.mock.calls[0][0] as string;
    expect(sql.match(/NULL::jsonb as metadata/g)?.length).toBe(4);
    expect(sql).toContain("jsonb_build_object('amount', re.amount_paid, 'currency', re.currency) as metadata");
  });
});
