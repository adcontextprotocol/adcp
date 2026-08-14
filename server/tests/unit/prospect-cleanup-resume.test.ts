import { describe, expect, it, vi } from 'vitest';

import { ProspectCleanupService } from '../../src/services/prospect-cleanup.js';

describe('ProspectCleanupService resumable turns', () => {
  it.each(['pause_turn', 'compaction'] as const)(
    'continues after %s without replaying the original prompt unchanged',
    async (stopReason) => {
      const responses = [
        {
          stop_reason: stopReason,
          content: [{ type: 'text', text: 'Intermediate state' }],
        },
        {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Final analysis' }],
        },
      ];
      const messageSnapshots: unknown[][] = [];
      const create = vi.fn(async (params: { messages: unknown[] }) => {
        messageSnapshots.push(structuredClone(params.messages));
        return responses[messageSnapshots.length - 1];
      });
      const service = new ProspectCleanupService('test-key', 'claude-sonnet-5');
      Object.defineProperty(service, 'client', {
        value: { messages: { create } },
      });

      const result = await service.analyzeWithClaude('org-test');

      expect(result.analysis).toBe('Final analysis');
      expect(create).toHaveBeenCalledTimes(2);
      expect(messageSnapshots[0]).toHaveLength(1);
      expect(messageSnapshots[1]).toEqual([
        expect.objectContaining({ role: 'user' }),
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Intermediate state' }],
        },
      ]);
    },
  );
});
