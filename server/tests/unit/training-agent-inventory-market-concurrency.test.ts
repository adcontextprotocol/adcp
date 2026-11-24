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
import { openMarket, withCallerMarkets, type MediaBuyRecord } from '../../src/training-agent/inventory-sim/market-store.js';
import { ADSERVER_SEASON, ENGINE_VERSION } from '../../src/training-agent/inventory-sim/engine/index.js';
import { seasonFingerprint } from '../../src/training-agent/inventory-sim/season-file.js';

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

describe('stored markets, the engine version and the season', () => {
  const buy = { media_buy_id: 'mb_0001', packages: [] } as unknown as MediaBuyRecord;

  async function storedDocuments(principal: string) {
    const session = await getSession(sandboxSessionKey(principal));
    return [...session.principalConfigurations.entries()].filter(([key]) => key.startsWith('inventory_market'));
  }

  async function bookMarket(principal: string) {
    await runWithSessionContext(async () => {
      const market = await openMarket('inventory-adserver', ADSERVER_SEASON, principal);
      market.doc.media_buys.push(buy);
      market.save();
      await flushDirtySessions();
    });
  }

  it('keeps bookings across opens of the same market, and stamps the engine version and the season fingerprint', async () => {
    const principal = 'engine-version-keep-caller';
    await runWithSessionContext(async () => {
      const first = await openMarket('inventory-adserver', ADSERVER_SEASON, principal);
      expect(first.doc.engine_version).toBe(ENGINE_VERSION);
      expect(first.doc.season_fingerprint).toBe(seasonFingerprint(ADSERVER_SEASON));
      first.doc.media_buys.push(buy);
      first.save();
      await flushDirtySessions();
    });
    await runWithSessionContext(async () => {
      const second = await openMarket('inventory-adserver', ADSERVER_SEASON, principal);
      expect(second.doc.media_buys.map(record => record.media_buy_id)).toEqual(['mb_0001']);
    });
  });

  it('restarts a stored market built by another engine version, or by none', async () => {
    const principal = 'engine-version-restart-caller';
    await bookMarket(principal);
    for (const version of ['0', undefined]) {
      await runWithSessionContext(async () => {
        const [[, stored]] = await storedDocuments(principal);
        (stored as Record<string, unknown>).engine_version = version;
        await flushDirtySessions();
      });
      await runWithSessionContext(async () => {
        const reopened = await openMarket('inventory-adserver', ADSERVER_SEASON, principal);
        expect(reopened.doc.media_buys).toEqual([]);
        expect(reopened.doc.engine_version).toBe(ENGINE_VERSION);
        reopened.doc.media_buys.push(buy);
        reopened.save();
        await flushDirtySessions();
      });
    }
  });

  it('restarts a stored market built on another season fingerprint, or on none', async () => {
    const principal = 'season-fingerprint-restart-caller';
    await bookMarket(principal);
    for (const fingerprint of ['sha256:other', undefined]) {
      await runWithSessionContext(async () => {
        const [[, stored]] = await storedDocuments(principal);
        (stored as Record<string, unknown>).season_fingerprint = fingerprint;
        await flushDirtySessions();
      });
      await runWithSessionContext(async () => {
        const reopened = await openMarket('inventory-adserver', ADSERVER_SEASON, principal);
        expect(reopened.doc.media_buys).toEqual([]);
        expect(reopened.doc.season_fingerprint).toBe(seasonFingerprint(ADSERVER_SEASON));
        reopened.doc.media_buys.push(buy);
        reopened.save();
        await flushDirtySessions();
      });
    }
  });

  it('keeps a market stored for the same season across a second open', async () => {
    const principal = 'season-fingerprint-keep-caller';
    await bookMarket(principal);
    await runWithSessionContext(async () => {
      const second = await openMarket('inventory-adserver', ADSERVER_SEASON, principal);
      expect(second.doc.media_buys.map(record => record.media_buy_id)).toEqual(['mb_0001']);
    });
  });

  it('restarts the market when a season value is edited and the seed_id is kept', async () => {
    const principal = 'season-edit-restart-caller';
    await bookMarket(principal);
    const edited = structuredClone(ADSERVER_SEASON);
    edited.forecast_error.log_clip += 0.01;
    expect(edited.seed_id).toBe(ADSERVER_SEASON.seed_id);
    expect(seasonFingerprint(edited)).not.toBe(seasonFingerprint(ADSERVER_SEASON));
    await runWithSessionContext(async () => {
      const reopened = await openMarket('inventory-adserver', edited, principal);
      expect(reopened.doc.media_buys).toEqual([]);
      expect(reopened.doc.season_fingerprint).toBe(seasonFingerprint(edited));
    });
  });
});
