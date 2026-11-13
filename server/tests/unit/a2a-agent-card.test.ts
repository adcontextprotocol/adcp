/**
 * The A2A agent card lives at /.well-known/agent-card.json (A2A §8.2). The
 * discovery endpoints probe only that path, so an agent that serves its card
 * there is listed as A2A, and the pre-1.0 /.well-known/agent.json is never
 * requested (#7875).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockSdkSafeFetch } = vi.hoisted(() => ({ mockSdkSafeFetch: vi.fn() }));

vi.mock('../../src/utils/sdk-safe-fetch.js', () => ({
  sdkSafeFetch: mockSdkSafeFetch,
}));

import { hasA2AAgentCard } from '../../src/lib/a2a-agent-card.js';

const cardUrl = 'https://agent.example.com/.well-known/agent-card.json';

describe('hasA2AAgentCard', () => {
  beforeEach(() => {
    mockSdkSafeFetch.mockReset();
    mockSdkSafeFetch.mockImplementation(async (url: string) =>
      url === cardUrl
        ? new Response('{}', { status: 200 })
        : new Response('not found', { status: 404 }),
    );
  });

  it('requests only the card at the origin of the agent URL', async () => {
    await hasA2AAgentCard('https://agent.example.com/mcp/');
    expect(mockSdkSafeFetch.mock.calls.map(([url]) => url)).toEqual([cardUrl]);
  });

  it('returns true when the origin serves the card', async () => {
    expect(await hasA2AAgentCard('https://agent.example.com/mcp/')).toBe(true);
  });

  it('returns false when the card request is not 2xx', async () => {
    expect(await hasA2AAgentCard('https://other.example.com/mcp/')).toBe(false);
  });

  it('returns false when the card request fails', async () => {
    mockSdkSafeFetch.mockRejectedValue(new Error('Connection to private or internal address is blocked'));
    expect(await hasA2AAgentCard('https://agent.example.com/mcp/')).toBe(false);
  });
});
