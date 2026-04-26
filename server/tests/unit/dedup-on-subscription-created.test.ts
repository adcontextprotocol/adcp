/**
 * Tests for the webhook-side duplicate-subscription guard.
 *
 * Policy (#3245): cancel the unpaid sub when exactly one is unpaid.
 * Otherwise (zero unpaid, or multiple unpaid) → manual_review with no
 * auto-cancel. Identifies paid via `latest_invoice.status === 'paid'`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';
import type { Logger } from 'pino';
import { dedupOnSubscriptionCreated } from '../../src/billing/dedup-on-subscription-created.js';

function makeSub(
  id: string,
  status: Stripe.Subscription.Status,
  extras?: {
    unit_amount?: number;
    lookup_key?: string;
    collection_method?: 'charge_automatically' | 'send_invoice';
    /** When omitted, latest_invoice is null → treated as unpaid. */
    latest_invoice_status?: Stripe.Invoice.Status | null;
    latest_invoice_id?: string;
  },
): Stripe.Subscription {
  const latestInvoice =
    extras?.latest_invoice_status === undefined
      ? null
      : extras.latest_invoice_status === null
        ? null
        : ({
            id: extras.latest_invoice_id ?? `in_${id}`,
            status: extras.latest_invoice_status,
          } as Stripe.Invoice);

  return {
    id,
    status,
    customer: 'cus_test',
    collection_method: extras?.collection_method ?? 'charge_automatically',
    latest_invoice: latestInvoice,
    items: {
      data: [
        {
          price: {
            unit_amount: extras?.unit_amount ?? 300000,
            lookup_key: extras?.lookup_key ?? 'aao_membership_builder_3000',
          },
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

function makeStripe(opts: {
  list?: () => Promise<{ data: Stripe.Subscription[]; has_more?: boolean }>;
  cancel?: () => Promise<Stripe.Subscription>;
}): Stripe {
  return {
    subscriptions: {
      list: opts.list ?? vi.fn().mockResolvedValue({ data: [] }),
      cancel: opts.cancel ?? vi.fn().mockResolvedValue({} as Stripe.Subscription),
    },
  } as unknown as Stripe;
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

describe('dedupOnSubscriptionCreated', () => {
  let logger: Logger;
  let notifySystemError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logger = makeLogger();
    notifySystemError = vi.fn();
  });

  describe('no-duplicate fast paths', () => {
    it('returns no_duplicate when the customer has only the new sub', async () => {
      const newSub = makeSub('sub_new', 'active', { latest_invoice_status: 'open' });
      const stripe = makeStripe({
        list: vi.fn().mockResolvedValue({ data: [newSub] }),
      });

      const result = await dedupOnSubscriptionCreated({
        subscription: newSub,
        customerId: 'cus_test',
        orgId: 'org_test',
        stripe,
        logger,
        notifySystemError,
      });

      expect(result.kind).toBe('no_duplicate');
      expect(notifySystemError).not.toHaveBeenCalled();
      expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    });

    it('returns no_duplicate when other subs exist but are all canceled/incomplete', async () => {
      const newSub = makeSub('sub_new', 'active', { latest_invoice_status: 'open' });
      const stripe = makeStripe({
        list: vi.fn().mockResolvedValue({
          data: [
            newSub,
            makeSub('sub_old1', 'canceled'),
            makeSub('sub_old2', 'incomplete_expired'),
            makeSub('sub_old3', 'incomplete'),
          ],
        }),
      });

      const result = await dedupOnSubscriptionCreated({
        subscription: newSub,
        customerId: 'cus_test',
        orgId: 'org_test',
        stripe,
        logger,
        notifySystemError,
      });

      expect(result.kind).toBe('no_duplicate');
      expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    });

    it('returns retry_skip without listing when the new sub is already canceled (webhook retry)', async () => {
      // Critical: must not return no_duplicate here — that would let the
      // webhook handler run UPDATE on the canceled sub and overwrite the
      // surviving sub's row state with `status: 'canceled'`.
      const newSub = makeSub('sub_new', 'canceled');
      const list = vi.fn().mockResolvedValue({ data: [] });
      const cancel = vi.fn();
      const stripe = makeStripe({ list, cancel });

      const result = await dedupOnSubscriptionCreated({
        subscription: newSub,
        customerId: 'cus_test',
        orgId: 'org_test',
        stripe,
        logger,
        notifySystemError,
      });

      expect(result.kind).toBe('retry_skip');
      expect(list).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(notifySystemError).not.toHaveBeenCalled();
    });

    it('returns retry_skip when the new sub is incomplete_expired (treats as already-handled)', async () => {
      const newSub = makeSub('sub_new', 'incomplete_expired');
      const list = vi.fn().mockResolvedValue({ data: [] });
      const stripe = makeStripe({ list });

      const result = await dedupOnSubscriptionCreated({
        subscription: newSub,
        customerId: 'cus_test',
        orgId: 'org_test',
        stripe,
        logger,
        notifySystemError,
      });

      expect(result.kind).toBe('retry_skip');
      expect(list).not.toHaveBeenCalled();
    });

    it('falls through to no_duplicate when subscriptions.list throws (transient Stripe blip)', async () => {
      const newSub = makeSub('sub_new', 'active');
      const stripe = makeStripe({
        list: vi.fn().mockRejectedValue(new Error('Stripe API down')),
      });

      const result = await dedupOnSubscriptionCreated({
        subscription: newSub,
        customerId: 'cus_test',
        orgId: 'org_test',
        stripe,
        logger,
        notifySystemError,
      });

      expect(result.kind).toBe('no_duplicate');
      expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
      expect(notifySystemError).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('cancel-unpaid policy', () => {
    it('cancels the new sub when it is the unpaid one (Triton-shape with new=unpaid)', async () => {
      const newSub = makeSub('sub_new', 'active', { latest_invoice_status: 'open' });
      const existing = makeSub('sub_existing', 'active', { latest_invoice_status: 'paid' });
      const cancel = vi.fn().mockResolvedValue({} as Stripe.Subscription);
      const stripe = makeStripe({
        list: vi.fn().mockResolvedValue({ data: [newSub, existing] }),
        cancel,
      });

      const result = await dedupOnSubscriptionCreated({
        subscription: newSub,
        customerId: 'cus_test',
        orgId: 'org_test',
        stripe,
        logger,
        notifySystemError,
      });

      expect(result.kind).toBe('canceled_new');
      if (result.kind === 'canceled_new') {
        expect(result.existingLiveSubIds).toEqual(['sub_existing']);
      }
      expect(cancel).toHaveBeenCalledWith('sub_new', { prorate: true });
      expect(notifySystemError).toHaveBeenCalledTimes(1);
    });

    it('cancels an existing sub when the new sub is paid and the existing is unpaid', async () => {
      // Reviewer's hypothetical flipped: customer paid for new bigger
      // tier (e.g., $50K Leader) while a smaller open invoice was sitting
      // around. New sub wins; we cancel the unpaid existing one.
      const newSub = makeSub('sub_new_leader', 'active', { latest_invoice_status: 'paid' });
      const oldUnpaid = makeSub('sub_old_pro', 'active', { latest_invoice_status: 'open' });
      const cancel = vi.fn().mockResolvedValue({} as Stripe.Subscription);
      const stripe = makeStripe({
        list: vi.fn().mockResolvedValue({ data: [newSub, oldUnpaid] }),
        cancel,
      });

      const result = await dedupOnSubscriptionCreated({
        subscription: newSub,
        customerId: 'cus_test',
        orgId: 'org_test',
        stripe,
        logger,
        notifySystemError,
      });

      expect(result.kind).toBe('canceled_existing');
      if (result.kind === 'canceled_existing') {
        expect(result.canceledSubId).toBe('sub_old_pro');
        expect(result.survivingNewSubId).toBe('sub_new_leader');
      }
      expect(cancel).toHaveBeenCalledWith('sub_old_pro', { prorate: true });
    });

    it('treats latest_invoice = null as unpaid', async () => {
      // Some sub-creation paths fire the webhook before the first invoice
      // exists; null latest_invoice still counts as unpaid.
      const newSub = makeSub('sub_new', 'active'); // no latest_invoice
      const existing = makeSub('sub_existing', 'active', { latest_invoice_status: 'paid' });
      const cancel = vi.fn().mockResolvedValue({} as Stripe.Subscription);
      const stripe = makeStripe({
        list: vi.fn().mockResolvedValue({ data: [newSub, existing] }),
        cancel,
      });

      const result = await dedupOnSubscriptionCreated({
        subscription: newSub,
        customerId: 'cus_test',
        orgId: 'org_test',
        stripe,
        logger,
        notifySystemError,
      });

      expect(result.kind).toBe('canceled_new');
      expect(cancel).toHaveBeenCalledWith('sub_new', { prorate: true });
    });

    it('treats latest_invoice = open/draft as unpaid', async () => {
      const newSub = makeSub('sub_new', 'active', { latest_invoice_status: 'draft' });
      const existing = makeSub('sub_existing', 'active', { latest_invoice_status: 'paid' });
      const cancel = vi.fn().mockResolvedValue({} as Stripe.Subscription);
      const stripe = makeStripe({
        list: vi.fn().mockResolvedValue({ data: [newSub, existing] }),
        cancel,
      });

      const result = await dedupOnSubscriptionCreated({
        subscription: newSub,
        customerId: 'cus_test',
        orgId: 'org_test',
        stripe,
        logger,
        notifySystemError,
      });

      expect(result.kind).toBe('canceled_new');
      expect(cancel).toHaveBeenCalledWith('sub_new', { prorate: true });
    });

    it('treats latest_invoice as a string id (unexpanded) as unpaid', async () => {
      // Defensive: if expand silently fails, latest_invoice is just the
      // id string. We can't tell whether it's paid, so treat as unpaid
      // — better to err on the side of canceling the one with no signal.
      const newSub = makeSub('sub_new', 'active');
      (newSub as unknown as { latest_invoice: string }).latest_invoice = 'in_unknown';
      const existing = makeSub('sub_existing', 'active', { latest_invoice_status: 'paid' });
      const cancel = vi.fn().mockResolvedValue({} as Stripe.Subscription);
      const stripe = makeStripe({
        list: vi.fn().mockResolvedValue({ data: [newSub, existing] }),
        cancel,
      });

      const result = await dedupOnSubscriptionCreated({
        subscription: newSub,
        customerId: 'cus_test',
        orgId: 'org_test',
        stripe,
        logger,
        notifySystemError,
      });

      expect(result.kind).toBe('canceled_new');
    });

    it('alert message identifies which sub was canceled and why', async () => {
      const newSub = makeSub('sub_new', 'active', {
        latest_invoice_status: 'open',
        unit_amount: 300000,
        lookup_key: 'aao_membership_builder_3000',
        collection_method: 'send_invoice',
      });
      const existing = makeSub('sub_existing', 'active', { latest_invoice_status: 'paid' });
      const stripe = makeStripe({
        list: vi.fn().mockResolvedValue({ data: [newSub, existing] }),
      });

      await dedupOnSubscriptionCreated({
        subscription: newSub,
        customerId: 'cus_test',
        orgId: 'org_test',
        stripe,
        logger,
        notifySystemError,
      });

      const msg = notifySystemError.mock.calls[0][0].errorMessage;
      expect(msg).toContain('sub_new');
      expect(msg).toContain('was canceled (it was the unpaid duplicate)');
      expect(msg).toContain('amount=300000');
      expect(msg).toContain('lookup_key=aao_membership_builder_3000');
      expect(msg).toContain('collection=send_invoice');
      expect(msg).toContain('sub_existing');
    });
  });

  describe('manual_review (refuses to auto-decide)', () => {
    it('returns manual_review when both live subs are paid', async () => {
      // Both customers have paid charges → either could be the legit one.
      // Auto-canceling either risks discarding real revenue. Alert ops.
      const newSub = makeSub('sub_new_leader', 'active', { latest_invoice_status: 'paid' });
      const existing = makeSub('sub_existing_pro', 'active', { latest_invoice_status: 'paid' });
      const cancel = vi.fn();
      const stripe = makeStripe({
        list: vi.fn().mockResolvedValue({ data: [newSub, existing] }),
        cancel,
      });

      const result = await dedupOnSubscriptionCreated({
        subscription: newSub,
        customerId: 'cus_test',
        orgId: 'org_test',
        stripe,
        logger,
        notifySystemError,
      });

      expect(result.kind).toBe('manual_review');
      if (result.kind === 'manual_review') {
        expect(result.allLiveSubIds).toEqual(['sub_new_leader', 'sub_existing_pro']);
        expect(result.reason).toContain('all paid');
      }
      expect(cancel).not.toHaveBeenCalled();
      expect(notifySystemError).toHaveBeenCalled();
      const msg = notifySystemError.mock.calls[0][0].errorMessage;
      expect(msg).toContain('manual review');
      expect(msg).toContain('paid=sub_new_leader,sub_existing_pro');
      expect(msg).toContain('unpaid=(none)');
    });

    it('returns manual_review when both live subs are unpaid', async () => {
      // Two concurrent send_invoice intake flows in flight; can't tell
      // which one the customer "meant" so escalate.
      const newSub = makeSub('sub_new', 'active', { latest_invoice_status: 'open' });
      const existing = makeSub('sub_other', 'active', { latest_invoice_status: 'open' });
      const cancel = vi.fn();
      const stripe = makeStripe({
        list: vi.fn().mockResolvedValue({ data: [newSub, existing] }),
        cancel,
      });

      const result = await dedupOnSubscriptionCreated({
        subscription: newSub,
        customerId: 'cus_test',
        orgId: 'org_test',
        stripe,
        logger,
        notifySystemError,
      });

      expect(result.kind).toBe('manual_review');
      if (result.kind === 'manual_review') {
        expect(result.reason).toContain('all unpaid');
      }
      expect(cancel).not.toHaveBeenCalled();
      const msg = notifySystemError.mock.calls[0][0].errorMessage;
      expect(msg).toContain('paid=(none)');
      expect(msg).toContain('unpaid=sub_new,sub_other');
    });

    it('returns manual_review when 3+ live subs are all paid', async () => {
      // Three concurrent paid subs is rare but possible; auto-canceling
      // any of them risks discarding real revenue.
      const newSub = makeSub('sub_new', 'active', { latest_invoice_status: 'paid' });
      const a = makeSub('sub_a', 'active', { latest_invoice_status: 'paid' });
      const b = makeSub('sub_b', 'active', { latest_invoice_status: 'paid' });
      const cancel = vi.fn();
      const stripe = makeStripe({
        list: vi.fn().mockResolvedValue({ data: [newSub, a, b] }),
        cancel,
      });

      const result = await dedupOnSubscriptionCreated({
        subscription: newSub,
        customerId: 'cus_test',
        orgId: 'org_test',
        stripe,
        logger,
        notifySystemError,
      });

      expect(result.kind).toBe('manual_review');
      if (result.kind === 'manual_review') {
        expect(result.allLiveSubIds).toEqual(['sub_new', 'sub_a', 'sub_b']);
        expect(result.reason).toContain('all paid');
      }
      expect(cancel).not.toHaveBeenCalled();
    });

    it('returns manual_review when 3+ live subs are all unpaid', async () => {
      const newSub = makeSub('sub_new', 'active', { latest_invoice_status: 'open' });
      const a = makeSub('sub_a', 'active', { latest_invoice_status: 'open' });
      const b = makeSub('sub_b', 'active', { latest_invoice_status: 'draft' });
      const cancel = vi.fn();
      const stripe = makeStripe({
        list: vi.fn().mockResolvedValue({ data: [newSub, a, b] }),
        cancel,
      });

      const result = await dedupOnSubscriptionCreated({
        subscription: newSub,
        customerId: 'cus_test',
        orgId: 'org_test',
        stripe,
        logger,
        notifySystemError,
      });

      expect(result.kind).toBe('manual_review');
      if (result.kind === 'manual_review') {
        expect(result.reason).toContain('all unpaid');
      }
      expect(cancel).not.toHaveBeenCalled();
    });

    it('treats latest_invoice = uncollectible as unpaid (Stripe wrote it off after retries)', async () => {
      const newSub = makeSub('sub_new', 'active', { latest_invoice_status: 'uncollectible' });
      const existing = makeSub('sub_existing', 'active', { latest_invoice_status: 'paid' });
      const cancel = vi.fn().mockResolvedValue({} as Stripe.Subscription);
      const stripe = makeStripe({
        list: vi.fn().mockResolvedValue({ data: [newSub, existing] }),
        cancel,
      });

      const result = await dedupOnSubscriptionCreated({
        subscription: newSub,
        customerId: 'cus_test',
        orgId: 'org_test',
        stripe,
        logger,
        notifySystemError,
      });

      expect(result.kind).toBe('canceled_new');
      expect(cancel).toHaveBeenCalledWith('sub_new', { prorate: true });
    });

    it('treats latest_invoice = void as unpaid (Stripe canceled the invoice)', async () => {
      const newSub = makeSub('sub_new', 'active', { latest_invoice_status: 'void' });
      const existing = makeSub('sub_existing', 'active', { latest_invoice_status: 'paid' });
      const cancel = vi.fn().mockResolvedValue({} as Stripe.Subscription);
      const stripe = makeStripe({
        list: vi.fn().mockResolvedValue({ data: [newSub, existing] }),
        cancel,
      });

      const result = await dedupOnSubscriptionCreated({
        subscription: newSub,
        customerId: 'cus_test',
        orgId: 'org_test',
        stripe,
        logger,
        notifySystemError,
      });

      expect(result.kind).toBe('canceled_new');
      expect(cancel).toHaveBeenCalledWith('sub_new', { prorate: true });
    });

    it('returns manual_review when 3+ live subs and ambiguous payment state', async () => {
      // Three live subs, two paid + one unpaid. Cancel-unpaid is technically
      // unambiguous here, so we DO cancel the unpaid one.
      const newSub = makeSub('sub_new', 'active', { latest_invoice_status: 'paid' });
      const paidExisting = makeSub('sub_paid', 'active', { latest_invoice_status: 'paid' });
      const unpaidExisting = makeSub('sub_unpaid', 'active', { latest_invoice_status: 'open' });
      const cancel = vi.fn().mockResolvedValue({} as Stripe.Subscription);
      const stripe = makeStripe({
        list: vi.fn().mockResolvedValue({ data: [newSub, paidExisting, unpaidExisting] }),
        cancel,
      });

      const result = await dedupOnSubscriptionCreated({
        subscription: newSub,
        customerId: 'cus_test',
        orgId: 'org_test',
        stripe,
        logger,
        notifySystemError,
      });

      // Exactly one unpaid → cancel that one. The two-paid subs case
      // remains a separate problem the audit invariants will flag.
      expect(result.kind).toBe('canceled_existing');
      if (result.kind === 'canceled_existing') {
        expect(result.canceledSubId).toBe('sub_unpaid');
      }
    });
  });

  describe('canceledFacts payload (drives customer apology email)', () => {
    it('canceled_new outcome carries cancelSucceeded=true on successful cancel', async () => {
      const newSub = makeSub('sub_new', 'active', {
        latest_invoice_status: 'open',
        unit_amount: 300000,
        lookup_key: 'aao_membership_builder_3000',
      });
      const existing = makeSub('sub_existing', 'active', { latest_invoice_status: 'paid' });
      const stripe = makeStripe({
        list: vi.fn().mockResolvedValue({ data: [newSub, existing] }),
      });

      const result = await dedupOnSubscriptionCreated({
        subscription: newSub,
        customerId: 'cus_test',
        orgId: 'org_test',
        stripe,
        logger,
        notifySystemError,
      });

      expect(result.kind).toBe('canceled_new');
      if (result.kind === 'canceled_new') {
        expect(result.canceledFacts.cancelSucceeded).toBe(true);
        expect(result.canceledFacts.wasPaid).toBe(false);
        expect(result.canceledFacts.amountCents).toBe(300000);
        expect(result.canceledFacts.lookupKey).toBe('aao_membership_builder_3000');
      }
    });

    it('canceled_new outcome carries cancelSucceeded=false on cancel failure', async () => {
      const newSub = makeSub('sub_new', 'active', { latest_invoice_status: 'open' });
      const existing = makeSub('sub_existing', 'active', { latest_invoice_status: 'paid' });
      const cancel = vi.fn().mockRejectedValue(new Error('Stripe error'));
      const stripe = makeStripe({
        list: vi.fn().mockResolvedValue({ data: [newSub, existing] }),
        cancel,
      });

      const result = await dedupOnSubscriptionCreated({
        subscription: newSub,
        customerId: 'cus_test',
        orgId: 'org_test',
        stripe,
        logger,
        notifySystemError,
      });

      expect(result.kind).toBe('canceled_new');
      if (result.kind === 'canceled_new') {
        expect(result.canceledFacts.cancelSucceeded).toBe(false);
      }
    });

    it('canceled_existing outcome surfaces facts about the canceled existing sub', async () => {
      const newSub = makeSub('sub_new_leader', 'active', { latest_invoice_status: 'paid' });
      const oldUnpaid = makeSub('sub_old_pro', 'active', {
        latest_invoice_status: 'open',
        unit_amount: 25000,
        lookup_key: 'aao_membership_pro_250',
      });
      const stripe = makeStripe({
        list: vi.fn().mockResolvedValue({ data: [newSub, oldUnpaid] }),
      });

      const result = await dedupOnSubscriptionCreated({
        subscription: newSub,
        customerId: 'cus_test',
        orgId: 'org_test',
        stripe,
        logger,
        notifySystemError,
      });

      expect(result.kind).toBe('canceled_existing');
      if (result.kind === 'canceled_existing') {
        expect(result.canceledFacts.cancelSucceeded).toBe(true);
        expect(result.canceledFacts.amountCents).toBe(25000);
        expect(result.canceledFacts.lookupKey).toBe('aao_membership_pro_250');
      }
    });
  });

  describe('failure modes', () => {
    it('still alerts ops when cancel fails — manual intervention is needed', async () => {
      const newSub = makeSub('sub_new', 'active', { latest_invoice_status: 'open' });
      const existing = makeSub('sub_existing', 'active', { latest_invoice_status: 'paid' });
      const cancel = vi.fn().mockRejectedValue(new Error('cannot cancel'));
      const stripe = makeStripe({
        list: vi.fn().mockResolvedValue({ data: [newSub, existing] }),
        cancel,
      });

      const result = await dedupOnSubscriptionCreated({
        subscription: newSub,
        customerId: 'cus_test',
        orgId: 'org_test',
        stripe,
        logger,
        notifySystemError,
      });

      // We still return canceled_new — the survivor still wins; ops
      // handles the actual cancel manually.
      expect(result.kind).toBe('canceled_new');
      expect(notifySystemError).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalled();
      const msg = notifySystemError.mock.calls[0][0].errorMessage;
      expect(msg).toContain('COULD NOT be canceled');
      expect(msg).not.toContain('was canceled (it was the unpaid duplicate)');
    });

    it('warns when subscriptions.list returns has_more (page overflow)', async () => {
      const newSub = makeSub('sub_new', 'active', { latest_invoice_status: 'open' });
      const stripe = makeStripe({
        list: vi.fn().mockResolvedValue({
          data: [newSub, makeSub('sub_existing', 'active', { latest_invoice_status: 'paid' })],
          has_more: true,
        }),
      });

      await dedupOnSubscriptionCreated({
        subscription: newSub,
        customerId: 'cus_test',
        orgId: 'org_test',
        stripe,
        logger,
        notifySystemError,
      });

      expect(logger.warn).toHaveBeenCalled();
    });

    it('handles missing orgId in the alert message', async () => {
      const newSub = makeSub('sub_new', 'active', { latest_invoice_status: 'open' });
      const existing = makeSub('sub_existing', 'active', { latest_invoice_status: 'paid' });
      const stripe = makeStripe({
        list: vi.fn().mockResolvedValue({ data: [newSub, existing] }),
      });

      await dedupOnSubscriptionCreated({
        subscription: newSub,
        customerId: 'cus_test',
        orgId: null,
        stripe,
        logger,
        notifySystemError,
      });

      expect(notifySystemError.mock.calls[0][0].errorMessage).toContain('org unknown');
    });
  });
});
