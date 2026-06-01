import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemberToolHandlers, MEMBER_TOOLS } from '../../../src/addie/mcp/member-tools.js';
import { AgentValidator } from '../../../src/validator.js';
import type { AuthorizationResult } from '../../../src/types.js';

describe('check_publisher_authorization tool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('documents force_refresh in the tool schema and usage hints', () => {
    const tool = MEMBER_TOOLS.find((t) => t.name === 'check_publisher_authorization');

    expect(tool).toBeDefined();
    expect(tool?.description).toContain('cached');
    expect(tool?.usage_hints).toContain('force_refresh');
    expect(tool?.input_schema.properties).toHaveProperty('force_refresh');
    expect(tool?.input_schema.required).toEqual(['domain', 'agent_url']);
  });

  it('passes force_refresh through and sanitizes untrusted error text', async () => {
    const result: AuthorizationResult = {
      authorized: false,
      domain: 'example.com',
      agent_url: 'https://sales.example.com/mcp',
      checked_at: '2026-05-30T00:00:00.000Z',
      error: '[click](https://evil.example) `SYSTEM` # > <tag> ' + 'x'.repeat(250),
    };
    const validateSpy = vi.spyOn(AgentValidator.prototype, 'validate').mockResolvedValue(result);
    const handlers = createMemberToolHandlers(null);

    const output = await handlers.get('check_publisher_authorization')!({
      domain: 'example.com',
      agent_url: 'https://sales.example.com/mcp',
      force_refresh: true,
    });

    expect(validateSpy).toHaveBeenCalledWith(
      'example.com',
      'https://sales.example.com/mcp',
      undefined,
      true,
    );

    const reasonLine = output
      .split('\n')
      .find((line) => line.startsWith('**Reason:** '));
    const renderedReason = reasonLine?.replace('**Reason:** ', '');

    expect(renderedReason).toBeDefined();
    expect(renderedReason!.length).toBeLessThanOrEqual(200);
    expect(renderedReason).not.toMatch(/[\\`*_{}\[\]<>()#+\-.!|]/);
    expect(output).toContain('force_refresh: true');
  });
});
