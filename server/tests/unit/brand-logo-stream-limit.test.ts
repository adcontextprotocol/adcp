import { describe, expect, it, vi } from 'vitest';
import { readResponseBodyWithLimit } from '../../src/services/brand-logo-service.js';

describe('readResponseBodyWithLimit', () => {
  it('returns a body that is exactly at the byte limit', async () => {
    const response = new Response(new Uint8Array([1, 2, 3, 4]));

    const body = await readResponseBodyWithLimit(response, 4);

    expect(body).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('cancels an oversized stream before buffering the remaining response', async () => {
    const cancel = vi.fn();
    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
      new Uint8Array([7, 8, 9]),
    ];
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[pulls++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel,
    });

    const body = await readResponseBodyWithLimit(new Response(stream), 5);

    expect(body).toBeNull();
    expect(cancel).toHaveBeenCalledWith('response body exceeds byte limit');
    expect(pulls).toBeLessThan(chunks.length + 1);
  });
});
