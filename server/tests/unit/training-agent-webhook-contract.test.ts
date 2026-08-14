import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handleUpdateRights } from '../../src/training-agent/brand-handlers.js';
import {
  TOOL_TO_PROTOCOL,
  TOOL_TO_TASK_TYPE,
} from '../../src/training-agent/webhooks.js';

describe('training-agent completion webhook contract', () => {
  it('keeps mapped task types aligned with the canonical task-type enum', () => {
    const schema = JSON.parse(readFileSync(
      join(process.cwd(), 'static/schemas/source/enums/task-type.json'),
      'utf8',
    )) as { enum: string[] };

    expect(Object.keys(TOOL_TO_PROTOCOL).sort()).toEqual(Object.keys(TOOL_TO_TASK_TYPE).sort());
    expect(Object.values(TOOL_TO_TASK_TYPE).every(taskType => schema.enum.includes(taskType))).toBe(true);
    expect(TOOL_TO_TASK_TYPE).toMatchObject({
      get_products: 'get_products',
      request_proposals: 'request_proposals',
      refine_proposals: 'refine_proposals',
      decline_proposals: 'decline_proposals',
      build_creative: 'build_creative',
      update_rights: 'update_rights',
    });
    expect(TOOL_TO_PROTOCOL).toMatchObject({
      get_products: 'media-buy',
      request_proposals: 'media-buy',
      refine_proposals: 'media-buy',
      decline_proposals: 'media-buy',
      build_creative: 'creative',
      update_rights: 'brand',
    });
  });

  it('accepts update_rights callbacks now that its task type is routable', async () => {
    const result = await handleUpdateRights({
      rights_id: 'janssen_likeness_voice',
      push_notification_config: { url: 'https://webhook.example.com/rights' },
    }, { mode: 'open' });

    expect(result).toMatchObject({ rights_id: 'janssen_likeness_voice' });
    expect(result).not.toHaveProperty('errors');
  });
});
