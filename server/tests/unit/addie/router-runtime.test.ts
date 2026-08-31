import { describe, expect, it } from 'vitest';
import {
  LUNA_ROUTER_PRIMARY_DEADLINE_MS,
  createProductionRouter,
} from '../../../src/addie/router-runtime.js';

describe('production router runtime', () => {
  it('selects Luna when the OpenAI key is configured', () => {
    const runtime = createProductionRouter('anthropic-key', ' openai-key ');

    expect(runtime.primaryProvider).toBe('openai');
    expect(runtime.router).toBeDefined();
    expect(LUNA_ROUTER_PRIMARY_DEADLINE_MS).toBe(15_000);
  });

  it('keeps Haiku available when the OpenAI key is absent', () => {
    const runtime = createProductionRouter('anthropic-key', undefined);

    expect(runtime.primaryProvider).toBe('anthropic');
    expect(runtime.router).toBeDefined();
  });
});
