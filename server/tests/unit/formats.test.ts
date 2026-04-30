import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Agent } from '../../src/types.js';

const mockExecuteTask = vi.fn();

// Mock @adcp/sdk with a proper class constructor
vi.mock('@adcp/sdk', () => ({
  AdCPClient: class MockAdCPClient {
    agent() {
      return {
        executeTask: mockExecuteTask,
      };
    }
  },
}));

import { FormatsService } from '../../src/formats.js';

describe('FormatsService', () => {
  let service: FormatsService;
  let mockAgent: Agent;

  beforeEach(() => {
    service = new FormatsService();
    mockExecuteTask.mockReset();
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
      mockExecuteTask.mockResolvedValue({
        success: true,
        data: [
          { name: 'iab_standard_display', dimensions: '300x250', type: 'display' },
          { name: 'iab_standard_display', dimensions: '728x90', type: 'display' }
        ]
      });

      const profile = await service.getFormatsForAgent(mockAgent);

      expect(profile.agent_url).toBe(mockAgent.url);
      expect(profile.protocol).toBe('mcp');
      expect(profile.formats).toBeInstanceOf(Array);
      expect(profile.formats.length).toBeGreaterThan(0);
      expect(profile.last_fetched).toBeDefined();
      expect(profile.error).toBeUndefined();
    });

    it('returns format objects with expected structure', async () => {
      mockExecuteTask.mockResolvedValue({
        success: true,
        data: [
          { name: 'iab_standard_display', dimensions: '300x250', type: 'display' },
        ]
      });

      const profile = await service.getFormatsForAgent(mockAgent);

      profile.formats.forEach(format => {
        expect(format).toHaveProperty('name');
        expect(typeof format.name).toBe('string');
      });
    });

    it('caches results for 15 minutes', async () => {
      mockExecuteTask.mockResolvedValue({
        success: true,
        data: [{ name: 'format1' }]
      });

      // First call
      await service.getFormatsForAgent(mockAgent);
      expect(mockExecuteTask).toHaveBeenCalledTimes(1);

      // Second call within cache period
      await service.getFormatsForAgent(mockAgent);
      expect(mockExecuteTask).toHaveBeenCalledTimes(1); // Should not call again
    });

    it('handles agent errors gracefully', async () => {
      mockExecuteTask.mockResolvedValue({
        success: false,
        error: 'Agent offline'
      });

      const profile = await service.getFormatsForAgent(mockAgent);

      expect(profile.formats).toEqual([]);
      expect(profile.error).toContain('Agent returned error');
    });

    it('handles missing tool gracefully', async () => {
      mockExecuteTask.mockRejectedValue(new Error('Tool not found'));

      const profile = await service.getFormatsForAgent(mockAgent);

      expect(profile.formats).toEqual([]);
      expect(profile.error).toContain('does not support list_creative_formats');
    });
  });

  describe('normalizeFormat', () => {
    it('handles string format names', async () => {
      mockExecuteTask.mockResolvedValue({
        success: true,
        data: ['format1', 'format2']
      });

      const profile = await service.getFormatsForAgent(mockAgent);

      expect(profile.formats).toHaveLength(2);
      expect(profile.formats[0].name).toBe('format1');
      expect(profile.formats[1].name).toBe('format2');
    });

    it('handles object with formats array', async () => {
      mockExecuteTask.mockResolvedValue({
        success: true,
        data: {
          formats: [
            { name: 'display', dimensions: '300x250' }
          ]
        }
      });

      const profile = await service.getFormatsForAgent(mockAgent);

      expect(profile.formats).toHaveLength(1);
      expect(profile.formats[0].name).toBe('display');
      expect(profile.formats[0].dimensions).toBe('300x250');
    });

    it('handles different property naming conventions', async () => {
      mockExecuteTask.mockResolvedValue({
        success: true,
        data: [{
          format: 'video',
          size: '1920x1080',
          aspectRatio: '16:9',
        }]
      });

      const profile = await service.getFormatsForAgent(mockAgent);

      expect(profile.formats[0].name).toBe('video');
      expect(profile.formats[0].dimensions).toBe('1920x1080');
      expect(profile.formats[0].aspect_ratio).toBe('16:9');
    });
  });

  describe('enrichAgentsWithFormats', () => {
    it('fetches formats for multiple agents in parallel', async () => {
      mockExecuteTask.mockResolvedValue({
        success: true,
        data: [{ name: 'format1' }]
      });

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
      mockExecuteTask.mockResolvedValue({
        success: true,
        data: [{ name: 'format1' }]
      });

      await service.getFormatsForAgent(mockAgent);
      const cached = service.getFormatsProfile(mockAgent.url);

      expect(cached).toBeDefined();
      expect(cached?.agent_url).toBe(mockAgent.url);
    });

    it('getAllFormatsProfiles returns all cached profiles', async () => {
      mockExecuteTask.mockResolvedValue({
        success: true,
        data: [{ name: 'format1' }]
      });

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
