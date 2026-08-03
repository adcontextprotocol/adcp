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
      build_creative: 'build_creative',
    });
    expect(TOOL_TO_PROTOCOL).toMatchObject({
      get_products: 'media-buy',
      build_creative: 'creative',
    });
    expect(TOOL_TO_TASK_TYPE).not.toHaveProperty('update_rights');
  });

  it('rejects update_rights callbacks while its task type is undefined', () => {
    const result = handleUpdateRights({
      rights_id: 'nova_likeness_voice',
      push_notification_config: { url: 'https://webhook.example.com/rights' },
    }, { mode: 'open' }) as { errors?: Array<Record<string, unknown>> };

    expect(result.errors).toEqual([expect.objectContaining({
      code: 'VALIDATION_ERROR',
      field: 'push_notification_config',
    })]);
  });
});
