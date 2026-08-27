import { describe, expect, it } from 'vitest';
import { BILLING_TOOLS } from '../../../src/addie/mcp/billing-tools.js';
import { EVENT_ADMIN_TOOLS } from '../../../src/addie/mcp/event-tools.js';
import { MEETING_TOOLS } from '../../../src/addie/mcp/meeting-tools.js';

function property(toolName: string, field: string): Record<string, unknown> {
  const tool = [...EVENT_ADMIN_TOOLS, ...MEETING_TOOLS].find(candidate => candidate.name === toolName);
  if (!tool) throw new Error(`Missing tool ${toolName}`);
  return tool.input_schema.properties[field] as Record<string, unknown>;
}

describe('dated Addie tool schemas', () => {
  it.each([
    ['create_event', 'start_time'],
    ['create_event', 'end_time'],
    ['update_event', 'start_time'],
    ['update_event', 'end_time'],
    ['schedule_meeting', 'start_time'],
    ['update_meeting', 'start_time'],
  ])('types %s.%s as an RFC 3339 date-time', (toolName, field) => {
    const schema = property(toolName, field);

    expect(schema.type).toBe('string');
    expect(schema.format).toBe('date-time');
    expect(schema.description).toContain('explicit');
  });

  it.each([
    ['create_event', 'timezone'],
    ['schedule_meeting', 'timezone'],
    ['update_meeting', 'timezone'],
  ])('identifies %s.%s as an IANA timezone', (toolName, field) => {
    expect(property(toolName, field).description).toContain('IANA timezone');
  });

  it('confirms billing tools expose no dated input records', () => {
    const datedFields = BILLING_TOOLS.flatMap(tool =>
      Object.keys(tool.input_schema.properties)
        .filter(field => /(^date$|_at$|_time$|timestamp|deadline)/.test(field))
        .map(field => `${tool.name}.${field}`),
    );

    expect(datedFields).toEqual([]);
  });
});
