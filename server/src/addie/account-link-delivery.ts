export const ACCOUNT_LINK_DELIVERY_WAIT_MS = 1_500;

export type AccountLinkDeliverySettlement =
  | { status: 'settled'; delivered: boolean }
  | { status: 'rejected'; error: unknown };

export type AccountLinkDeliveryWaitResult =
  | AccountLinkDeliverySettlement
  | { status: 'timed_out' };

export interface AccountLinkDeliveryWaitOptions {
  timeoutMs?: number;
  onLateSettlement?: (
    settlement: AccountLinkDeliverySettlement,
  ) => void | Promise<void>;
}

/**
 * Keep the OAuth callback independent of Slack's retry budget while retaining
 * an observer on the delivery promise. The delivery routine owns its eventual
 * audit write; a late settlement therefore continues after this wait expires
 * without becoming an unhandled rejection.
 */
export async function waitForAccountLinkDelivery(
  deliver: () => Promise<boolean>,
  options: AccountLinkDeliveryWaitOptions = {},
): Promise<AccountLinkDeliveryWaitResult> {
  const timeoutMs = options.timeoutMs ?? ACCOUNT_LINK_DELIVERY_WAIT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error('account_link_delivery_timeout_invalid');
  }

  let timedOut = false;
  const observedDelivery: Promise<AccountLinkDeliverySettlement> = (async () => {
    try {
      return { status: 'settled', delivered: await deliver() };
    } catch (error) {
      return { status: 'rejected', error };
    }
  })();

  // Attach the late observer before racing so a rejection is always consumed,
  // even when Slack finishes after the HTTP response has already redirected.
  void observedDelivery.then((settlement) => {
    if (!timedOut || !options.onLateSettlement) return;
    void Promise.resolve()
      .then(() => options.onLateSettlement!(settlement))
      .catch(() => undefined);
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ status: 'timed_out' }>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve({ status: 'timed_out' });
    }, timeoutMs);
  });

  const result = await Promise.race([observedDelivery, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}
