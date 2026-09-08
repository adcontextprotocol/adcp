import { describe, expect, it } from 'vitest';
import {
  LUNA_ROUTER_PRIMARY_DEADLINE_MS,
  createProductionRouter,
} from '../../../src/addie/router-runtime.js';

describe('production router runtime', () => {
  it('selects Luna when the OpenAI key is configured', () => {
    const runtime = createProductionRouter(' openai-key ');

    expect(runtime.primaryProvider).toBe('openai');
    expect(runtime.router).toBeDefined();
    expect(LUNA_ROUTER_PRIMARY_DEADLINE_MS).toBe(15_000);
  });

  it.each([undefined, '', '   '])('fails startup when the OpenAI key is absent (%j)', (apiKey) => {
    expect(() => createProductionRouter(apiKey))
      .toThrow('OPENAI_API_KEY is required for the production Addie router');
  });
});
