import { beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { runBrandLogoBackgroundBackfillJob } from '../../src/addie/jobs/brand-logo-background-backfill.js';

const ID_1 = '11111111-1111-1111-1111-111111111111';
const ID_2 = '22222222-2222-2222-2222-222222222222';
const ID_3 = '33333333-3333-3333-3333-333333333333';
const ID_4 = '44444444-4444-4444-4444-444444444444';

const svg = (fill: string) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect x="10" y="10" width="80" height="30" fill="${fill}"/></svg>`,
  );

function makeDb(pending: Array<{ id: string; domain: string }>, bytes: Record<string, { content_type: string; data: Buffer } | null>) {
  return {
    listLogosNeedingBackground: vi.fn().mockResolvedValue(pending),
    getLogoBytes: vi.fn(async (id: string) => bytes[id] ?? null),
    setDerivedBackground: vi.fn().mockResolvedValue(true),
  };
}

let db: ReturnType<typeof makeDb>;

beforeEach(() => {
  db = makeDb(
    [
      { id: ID_1, domain: 'a.example' },
      { id: ID_2, domain: 'b.example' },
    ],
    {
      [ID_1]: { content_type: 'image/svg+xml', data: svg('#000') },
      [ID_2]: { content_type: 'image/svg+xml', data: svg('#fff') },
    },
  );
});

describe('runBrandLogoBackgroundBackfillJob', () => {
  it('classifies each pending logo and records the result', async () => {
    const result = await runBrandLogoBackgroundBackfillJob({}, undefined, db as never);
    expect(result).toEqual({ scanned: 2, classified: 2, unclassifiable: 0 });
    expect(db.setDerivedBackground).toHaveBeenCalledWith(ID_1, 'light-bg');
    expect(db.setDerivedBackground).toHaveBeenCalledWith(ID_2, 'dark-bg');
  });

  it('passes the limit to the query, defaulting to 250', async () => {
    await runBrandLogoBackgroundBackfillJob({ limit: 7 }, undefined, db as never);
    expect(db.listLogosNeedingBackground).toHaveBeenLastCalledWith(7);
    await runBrandLogoBackgroundBackfillJob({}, undefined, db as never);
    expect(db.listLogosNeedingBackground).toHaveBeenLastCalledWith(250);
  });

  it('records null for unclassifiable rows so they are not picked up again', async () => {
    const png = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png()
      .toBuffer();
    db = makeDb(
      [
        { id: ID_1, domain: 'a.example' },
        { id: ID_2, domain: 'a.example' },
        { id: ID_3, domain: 'a.example' },
      ],
      {
        [ID_1]: { content_type: 'image/x-icon', data: Buffer.from([0, 0, 1, 0]) },
        [ID_2]: { content_type: 'image/png', data: png },
        [ID_3]: { content_type: 'image/png', data: Buffer.from('garbage') },
      },
    );
    const result = await runBrandLogoBackgroundBackfillJob({}, undefined, db as never);
    expect(result).toEqual({ scanned: 3, classified: 0, unclassifiable: 3 });
    for (const id of [ID_1, ID_2, ID_3]) expect(db.setDerivedBackground).toHaveBeenCalledWith(id, null);
  });

  it('skips a row that vanished between listing and loading, without recording it', async () => {
    db = makeDb(
      [
        { id: ID_4, domain: 'a.example' },
        { id: ID_1, domain: 'a.example' },
      ],
      { [ID_4]: null, [ID_1]: { content_type: 'image/svg+xml', data: svg('#000') } },
    );
    const result = await runBrandLogoBackgroundBackfillJob({}, undefined, db as never);
    expect(result).toEqual({ scanned: 2, classified: 1, unclassifiable: 0 });
    expect(db.setDerivedBackground).toHaveBeenCalledTimes(1);
    expect(db.setDerivedBackground).toHaveBeenCalledWith(ID_1, 'light-bg');
  });

  it('stops immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runBrandLogoBackgroundBackfillJob({}, controller.signal, db as never);
    expect(result).toEqual({ scanned: 0, classified: 0, unclassifiable: 0 });
    expect(db.getLogoBytes).not.toHaveBeenCalled();
    expect(db.setDerivedBackground).not.toHaveBeenCalled();
  });

  it('stops part-way when aborted mid-run', async () => {
    const controller = new AbortController();
    db.setDerivedBackground.mockImplementation(async () => {
      controller.abort();
      return true;
    });
    const result = await runBrandLogoBackgroundBackfillJob({}, controller.signal, db as never);
    expect(result.scanned).toBe(1);
    expect(db.getLogoBytes).toHaveBeenCalledTimes(1);
    expect(db.setDerivedBackground).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no rows are pending', async () => {
    db = makeDb([], {});
    expect(await runBrandLogoBackgroundBackfillJob({}, undefined, db as never)).toEqual({
      scanned: 0,
      classified: 0,
      unclassifiable: 0,
    });
  });

  it('loads logo bytes one row at a time, not up front', async () => {
    const order: string[] = [];
    db.getLogoBytes.mockImplementation(async (id: string) => {
      order.push(`load:${id}`);
      return { content_type: 'image/svg+xml', data: svg('#000') };
    });
    db.setDerivedBackground.mockImplementation(async (id: string) => {
      order.push(`save:${id}`);
      return true;
    });
    await runBrandLogoBackgroundBackfillJob({}, undefined, db as never);
    expect(order).toEqual([`load:${ID_1}`, `save:${ID_1}`, `load:${ID_2}`, `save:${ID_2}`]);
  });
});
