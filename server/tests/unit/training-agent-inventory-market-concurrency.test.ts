/**
 * Concurrent requests from one caller. Each request reads the caller's session
 * and writes it back when it ends; these tests hold two requests open across
 * each other's reads and writes, the interleaving several machines produce,
 * and check that neither request's write is lost. Lost writes let a canceled
 * guaranteed booking come back and keep its flight sold.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { flushDirtySessions, getSession, runWithSessionContext, stopSessionCleanup } from '../../src/training-agent/state.js';
import { loadSandbox, sandboxSessionKey } from '../../src/training-agent/account-sandbox.js';
import { withCallerMarkets } from '../../src/training-agent/inventory-sim/market-store.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('concurrent requests from one caller', () => {
  afterAll(() => stopSessionCleanup());

  it('merges the documents beside the sandbox entry by entry, so writes to different ones both land', async () => {
    const key = sandboxSessionKey('entry-merge-caller');
    await runWithSessionContext(async () => {
      const session = await getSession(key);
      session.principalConfigurations.set('market_adserver', { live_bookings: 1 });
      session.principalConfigurations.set('market_content', { live_bookings: 1 });
      session.principalConfigurations.set('market_retired', { live_bookings: 1 });
      await flushDirtySessions();
    });

    const contentLoaded = deferred();
    const adserverFlushed = deferred();
    // A cancel on one tenant and a buy on the other, both read before either writes.
    const cancel = runWithSessionContext(async () => {
      const session = await getSession(key);
      await contentLoaded.promise;
      session.principalConfigurations.set('market_adserver', { live_bookings: 0 });
      session.principalConfigurations.delete('market_retired');
      await flushDirtySessions();
      adserverFlushed.resolve();
    });
    const buy = runWithSessionContext(async () => {
      const session = await getSession(key);
      contentLoaded.resolve();
      await adserverFlushed.promise;
      session.principalConfigurations.set('market_content', { live_bookings: 2 });
      await flushDirtySessions();
    });
    await Promise.all([cancel, buy]);

    await runWithSessionContext(async () => {
      const session = await getSession(key);
      expect(session.principalConfigurations.get('market_adserver')).toEqual({ live_bookings: 0 });
      expect(session.principalConfigurations.get('market_content')).toEqual({ live_bookings: 2 });
      expect(session.principalConfigurations.has('market_retired')).toBe(false);
    });
  });

  it('runs one market request per caller at a time, each reading what the last one wrote', async () => {
    const principal = 'market-lock-caller';
    const increment = () => runWithSessionContext(() => withCallerMarkets(principal, async () => {
      const { session } = await loadSandbox(principal);
      const count = (session.principalConfigurations.get('market_counter') as number | undefined) ?? 0;
      await new Promise(resolve => setTimeout(resolve, 20));
      session.principalConfigurations.set('market_counter', count + 1);
    }));
    await Promise.all([increment(), increment(), increment()]);

    await runWithSessionContext(async () => {
      const { session } = await loadSandbox(principal);
      expect(session.principalConfigurations.get('market_counter')).toBe(3);
    });
  });
});
