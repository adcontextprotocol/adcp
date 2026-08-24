import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Agent } from '../../src/types.js';

const mockGetAdcpCapabilities = vi.fn();
const mockAdCPClientConstructor = vi.fn();

// Mock @adcp/sdk with a proper class constructor
vi.mock('@adcp/sdk', () => ({
  AdCPClient: class MockAdCPClient {
    constructor(...args: unknown[]) {
      mockAdCPClientConstructor(...args);
    }

    agent() {
      return {
        getAdcpCapabilities: mockGetAdcpCapabilities,
      };
    }
  },
}));

import { FormatsService } from '../../src/formats.js';

function capabilityResponse(entries: Array<Record<string, unknown>>) {
  const previewIds = entries
    .filter(entry => Array.isArray(entry.operations) && entry.operations.includes('preview'))
    .map(entry => entry.capability_id)
    .filter((id): id is string => typeof id === 'string');
  return {
    success: true,
    data: {
      creative: {
        supported_formats: entries,
        ...(previewIds.length === 0 ? {} : {
          preview: {
            routes: previewIds.map(capability_id => ({ capability_id, rendering_origin: 'agent_approximation' })),
          },
        }),
      },
    },
  };
}

const IMAGE_CAPABILITY = {
  capability_id: 'display_300x250',
  format: {
    format_kind: 'image',
    display_name: 'Medium rectangle',
    params: { width: 300, height: 250, aspect_ratio: '6:5' },
  },
  operations: ['preview'],
};

describe('FormatsService', () => {
  let service: FormatsService;
  let mockAgent: Agent;

  beforeEach(() => {
    service = new FormatsService();
    mockGetAdcpCapabilities.mockReset();
    mockAdCPClientConstructor.mockReset();
    mockAgent = {
      name: 'Test Creative Agent',
      url: 'https://test.example.com',
      type: 'creative',
      protocol: 'mcp',
      description: 'Test agent',
      mcp_endpoint: 'https://test.example.com/mcp',
      contact: {
        name: 'Test',
        email: 'test@example.com',
        website: 'https://example.com'
      },
      added_date: '2025-01-01'
    };
  });

  describe('getFormatsForAgent', () => {
    it('fetches formats successfully', async () => {
      mockGetAdcpCapabilities.mockResolvedValue(capabilityResponse([
        IMAGE_CAPABILITY,
        {
          capability_id: 'display_728x90',
          format: { format_kind: 'image', params: { width: 728, height: 90 } },
          operations: ['preview'],
        },
      ]));

      const profile = await service.getFormatsForAgent(mockAgent);

      expect(profile.agent_url).toBe(mockAgent.url);
      expect(profile.protocol).toBe('mcp');
      expect(profile.formats).toBeInstanceOf(Array);
      expect(profile.formats.length).toBeGreaterThan(0);
      expect(profile.last_fetched).toBeDefined();
      expect(profile.error).toBeUndefined();
    });

    it('returns format objects with expected structure', async () => {
      mockGetAdcpCapabilities.mockResolvedValue(capabilityResponse([IMAGE_CAPABILITY]));

      const profile = await service.getFormatsForAgent(mockAgent);

      profile.formats.forEach(format => {
        expect(format).toHaveProperty('name');
        expect(typeof format.name).toBe('string');
      });
    });

    it('caches results for 15 minutes', async () => {
      mockGetAdcpCapabilities.mockResolvedValue(capabilityResponse([IMAGE_CAPABILITY]));

      // First call
      await service.getFormatsForAgent(mockAgent);
      expect(mockGetAdcpCapabilities).toHaveBeenCalledTimes(1);

      // Second call within cache period
      await service.getFormatsForAgent(mockAgent);
      expect(mockGetAdcpCapabilities).toHaveBeenCalledTimes(1); // Should not call again
      expect(mockAdCPClientConstructor).toHaveBeenCalledTimes(1);
    });

    it('reuses SDK clients for authenticated calls without caching responses', async () => {
      mockGetAdcpCapabilities.mockResolvedValue(capabilityResponse([IMAGE_CAPABILITY]));

      const auth = { type: 'bearer' as const, token: 'secret-token' };

      await service.getFormatsForAgent(mockAgent, auth);
      await service.getFormatsForAgent(mockAgent, auth);

      expect(mockGetAdcpCapabilities).toHaveBeenCalledTimes(2);
      expect(mockAdCPClientConstructor).toHaveBeenCalledTimes(1);
      expect(service.getFormatsProfile(mockAgent.url)).toBeUndefined();
    });

    it('keeps authenticated SDK clients separate by auth identity', async () => {
      mockGetAdcpCapabilities.mockResolvedValue(capabilityResponse([IMAGE_CAPABILITY]));

      await service.getFormatsForAgent(mockAgent, { type: 'bearer', token: 'token-a' });
      await service.getFormatsForAgent(mockAgent, { type: 'bearer', token: 'token-b' });

      expect(mockGetAdcpCapabilities).toHaveBeenCalledTimes(2);
      expect(mockAdCPClientConstructor).toHaveBeenCalledTimes(2);
    });

    it('handles agent errors gracefully', async () => {
      mockGetAdcpCapabilities.mockResolvedValue({
        success: false,
        error: 'Agent offline'
      });

      const profile = await service.getFormatsForAgent(mockAgent);

      expect(profile.formats).toEqual([]);
      expect(profile.error).toContain('Agent returned error');
    });

    it('handles missing tool gracefully', async () => {
      mockGetAdcpCapabilities.mockRejectedValue(new Error('Tool not found'));

      const profile = await service.getFormatsForAgent(mockAgent);

      expect(profile.formats).toEqual([]);
      expect(profile.error).toContain('does not support canonical capability discovery');
    });
  });

  describe('canonical capability projection', () => {
    it('projects capability identity and canonical dimensions', async () => {
      mockGetAdcpCapabilities.mockResolvedValue(capabilityResponse([IMAGE_CAPABILITY]));

      const profile = await service.getFormatsForAgent(mockAgent);

      expect(profile.formats).toEqual([{
        name: 'display_300x250',
        dimensions: '300x250',
        aspect_ratio: '6:5',
        description: 'Medium rectangle',
      }]);
    });

    it('reports a missing creative catalog instead of accepting legacy response shapes', async () => {
      mockGetAdcpCapabilities.mockResolvedValue({ success: true, data: {} });

      const profile = await service.getFormatsForAgent(mockAgent);

      expect(profile.formats).toEqual([]);
      expect(profile.error).toContain('creative.supported_formats');
    });
  });

  describe('enrichAgentsWithFormats', () => {
    it('fetches formats for multiple agents in parallel', async () => {
      mockGetAdcpCapabilities.mockResolvedValue(capabilityResponse([IMAGE_CAPABILITY]));

      const agents = [
        mockAgent,
        { ...mockAgent, url: 'https://test2.example.com', name: 'Agent 2' }
      ];

      const profiles = await service.enrichAgentsWithFormats(agents);

      expect(profiles.size).toBe(2);
      expect(profiles.has(agents[0].url)).toBe(true);
      expect(profiles.has(agents[1].url)).toBe(true);
    });
  });

  describe('cache management', () => {
    it('getFormatsProfile returns cached profile', async () => {
      mockGetAdcpCapabilities.mockResolvedValue(capabilityResponse([IMAGE_CAPABILITY]));

      await service.getFormatsForAgent(mockAgent);
      const cached = service.getFormatsProfile(mockAgent.url);

      expect(cached).toBeDefined();
      expect(cached?.agent_url).toBe(mockAgent.url);
    });

    it('getAllFormatsProfiles returns all cached profiles', async () => {
      mockGetAdcpCapabilities.mockResolvedValue(capabilityResponse([IMAGE_CAPABILITY]));

      const agents = [
        mockAgent,
        { ...mockAgent, url: 'https://test2.example.com', name: 'Agent 2' }
      ];

      await service.enrichAgentsWithFormats(agents);
      const allProfiles = service.getAllFormatsProfiles();

      expect(allProfiles).toHaveLength(2);
    });
  });
});
