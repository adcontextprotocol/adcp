import { beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { runBrandLogoBackgroundBackfillJob } from '../../src/addie/jobs/brand-logo-background-backfill.js';
import { AsyncSemaphore, SemaphoreOverloadedError } from '../../src/utils/async-semaphore.js';

const ID_1 = '11111111-1111-1111-1111-111111111111';
const ID_2 = '22222222-2222-2222-2222-222222222222';
const ID_3 = '33333333-3333-3333-3333-333333333333';

const svg = (fill: string) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect x="10" y="10" width="80" height="30" fill="${fill}"/></svg>`,
  );

type Logo = { id: string; domain: string; content_type: string; data: Buffer };

/**
 * An in-memory stand-in for the claim queries: claimLogoForBackground hands
 * out unclaimed rows oldest first, skipping excluded ids, and marks them
 * claimed; releaseBackgroundClaim makes a row claimable again.
 */
function makeDb(rows: Logo[]) {
  const claimed = new Set<string>();
  const recorded = new Map<string, string | null>();
  const db = {
    claimed,
    recorded,
    claimLogoForBackground: vi.fn(async (excludeIds: string[] = []) => {
      const row = rows.find((r) => !claimed.has(r.id) && !excludeIds.includes(r.id));
      if (!row) return null;
      claimed.add(row.id);
      return { ...row };
    }),
    recordDerivedBackground: vi.fn(async (id: string, background: string | null) => {
      recorded.set(id, background);
    }),
    releaseBackgroundClaim: vi.fn(async (id: string) => {
      if (!recorded.has(id)) claimed.delete(id);
    }),
  };
  return db;
}

const logo = (id: string, data: Buffer, content_type = 'image/svg+xml', domain = 'a.example'): Logo => ({
  id,
  domain,
  content_type,
  data,
});

let db: ReturnType<typeof makeDb>;

beforeEach(() => {
  db = makeDb([logo(ID_1, svg('#000')), logo(ID_2, svg('#fff'), 'image/svg+xml', 'b.example')]);
});

describe('runBrandLogoBackgroundBackfillJob', () => {
  it('claims and classifies each pending logo, recording the result', async () => {
    const result = await runBrandLogoBackgroundBackfillJob({}, undefined, db as never);
    expect(result).toEqual({ scanned: 2, classified: 2, unclassifiable: 0, released: 0 });
    expect(db.recordDerivedBackground).toHaveBeenCalledWith(ID_1, 'light-bg');
    expect(db.recordDerivedBackground).toHaveBeenCalledWith(ID_2, 'dark-bg');
  });

  it('claims each logo before rendering it, one at a time', async () => {
    const order: string[] = [];
    db.claimLogoForBackground.mockImplementation(async () => {
      const row = [logo(ID_1, svg('#000')), logo(ID_2, svg('#000'))].find((r) => !db.claimed.has(r.id));
      if (!row) return null;
      db.claimed.add(row.id);
      order.push(`claim:${row.id}`);
      return row;
    });
    const limiter = {
      run: vi.fn(async <T>(task: () => Promise<T>) => {
        order.push('render');
        return task();
      }),
    };
    db.recordDerivedBackground.mockImplementation(async (id: string) => {
      order.push(`record:${id}`);
    });
    await runBrandLogoBackgroundBackfillJob({}, undefined, db as never, limiter);
    expect(order).toEqual([`claim:${ID_1}`, 'render', `record:${ID_1}`, `claim:${ID_2}`, 'render', `record:${ID_2}`]);
  });

  it('renders through the limiter it is given', async () => {
    const limiter = new AsyncSemaphore(1, 0);
    const run = vi.spyOn(limiter, 'run');
    await runBrandLogoBackgroundBackfillJob({}, undefined, db as never, limiter);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('stops at the limit, defaulting to 250', async () => {
    const many = Array.from({ length: 260 }, (_, i) =>
      logo(`00000000-0000-0000-0000-${String(i).padStart(12, '0')}`, svg('#000')),
    );
    db = makeDb(many);
    expect((await runBrandLogoBackgroundBackfillJob({ limit: 7 }, undefined, db as never)).scanned).toBe(7);
    db = makeDb(many);
    expect((await runBrandLogoBackgroundBackfillJob({}, undefined, db as never)).scanned).toBe(250);
  });

  it('records null for unclassifiable logos and does not release them', async () => {
    const blank = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png()
      .toBuffer();
    db = makeDb([
      logo(ID_1, Buffer.from([0, 0, 1, 0]), 'image/x-icon'),
      logo(ID_2, blank, 'image/png'),
      logo(ID_3, Buffer.from('garbage'), 'image/png'),
    ]);
    const result = await runBrandLogoBackgroundBackfillJob({}, undefined, db as never);
    expect(result).toEqual({ scanned: 3, classified: 0, unclassifiable: 3, released: 0 });
    for (const id of [ID_1, ID_2, ID_3]) expect(db.recorded.get(id)).toBeNull();
    expect(db.releaseBackgroundClaim).not.toHaveBeenCalled();
  });

  it('releases the claim on an unexpected error and moves on without retrying it this run', async () => {
    const limiter = {
      run: vi.fn(async <T>(task: () => Promise<T>) => {
        if (limiter.run.mock.calls.length === 1) throw new Error('vips: out of memory');
        return task();
      }),
    };
    const result = await runBrandLogoBackgroundBackfillJob({}, undefined, db as never, limiter);
    expect(result).toEqual({ scanned: 2, classified: 1, unclassifiable: 0, released: 1 });
    expect(db.releaseBackgroundClaim).toHaveBeenCalledWith(ID_1);
    expect(db.claimed.has(ID_1)).toBe(false); // retryable by a later run
    expect(db.recorded.has(ID_1)).toBe(false);
    expect(db.claimLogoForBackground).toHaveBeenLastCalledWith([ID_1]);
  });

  it('releases the claim when recording fails', async () => {
    db.recordDerivedBackground.mockRejectedValueOnce(new Error('db down'));
    const result = await runBrandLogoBackgroundBackfillJob({}, undefined, db as never);
    expect(result.released).toBe(1);
    expect(db.releaseBackgroundClaim).toHaveBeenCalledWith(ID_1);
  });

  it('releases the claim and ends the run when renders are saturated', async () => {
    const limiter = { run: vi.fn().mockRejectedValue(new SemaphoreOverloadedError(32)) };
    const result = await runBrandLogoBackgroundBackfillJob({}, undefined, db as never, limiter);
    expect(result).toEqual({ scanned: 1, classified: 0, unclassifiable: 0, released: 1 });
    expect(db.releaseBackgroundClaim).toHaveBeenCalledWith(ID_1);
    expect(db.claimLogoForBackground).toHaveBeenCalledTimes(1);
  });

  it('keeps going when releasing a claim fails', async () => {
    const limiter = {
      run: vi.fn(async <T>(task: () => Promise<T>) => {
        if (limiter.run.mock.calls.length === 1) throw new Error('boom');
        return task();
      }),
    };
    db.releaseBackgroundClaim.mockRejectedValueOnce(new Error('db down'));
    const result = await runBrandLogoBackgroundBackfillJob({}, undefined, db as never, limiter);
    expect(result.classified).toBe(1);
  });

  it('claims nothing when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runBrandLogoBackgroundBackfillJob({}, controller.signal, db as never);
    expect(result).toEqual({ scanned: 0, classified: 0, unclassifiable: 0, released: 0 });
    expect(db.claimLogoForBackground).not.toHaveBeenCalled();
  });

  it('stops claiming when aborted mid-run, leaving no claimed logo unrecorded', async () => {
    const controller = new AbortController();
    db.recordDerivedBackground.mockImplementation(async (id: string) => {
      db.recorded.set(id, 'light-bg');
      controller.abort();
    });
    const result = await runBrandLogoBackgroundBackfillJob({}, controller.signal, db as never);
    expect(result.scanned).toBe(1);
    expect(db.claimLogoForBackground).toHaveBeenCalledTimes(1);
    expect([...db.claimed].every((id) => db.recorded.has(id))).toBe(true);
  });

  it('does nothing when no logos are pending', async () => {
    db = makeDb([]);
    expect(await runBrandLogoBackgroundBackfillJob({}, undefined, db as never)).toEqual({
      scanned: 0,
      classified: 0,
      unclassifiable: 0,
      released: 0,
    });
  });
});
