import { describe, expect, it, vi } from 'vitest';
import {
  readResponseTextWithLimit,
  ResponseBodyTooLargeError,
} from '../../src/utils/bounded-response.js';

describe('readResponseTextWithLimit', () => {
  it('decodes a multibyte UTF-8 sequence split across chunks', async () => {
    const bytes = new TextEncoder().encode('AdCP ✓');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, bytes.length - 1));
        controller.enqueue(bytes.subarray(bytes.length - 1));
        controller.close();
      },
    });

    await expect(readResponseTextWithLimit(new Response(stream), bytes.length))
      .resolves.toBe('AdCP ✓');
  });

  it('cancels and rejects as soon as the byte limit is crossed', async () => {
    const cancel = vi.fn();
    let next = 0;
    const chunks = [new Uint8Array(3), new Uint8Array(3), new Uint8Array(3)];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[next++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel,
    });

    await expect(readResponseTextWithLimit(new Response(stream), 5))
      .rejects.toBeInstanceOf(ResponseBodyTooLargeError);
    expect(cancel).toHaveBeenCalledWith('response body exceeds byte limit');
    expect(next).toBeLessThan(chunks.length + 1);
  });
});
