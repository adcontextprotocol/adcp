import { fileURLToPath } from 'node:url';
import { loadStoryboardFile, runStoryboard } from '@adcp/sdk/testing';
import { describe, expect, it, vi } from 'vitest';

const storyboardPath = fileURLToPath(new URL(
  '../static/compliance/source/universal/property-list-reference-resolution.yaml',
  import.meta.url,
));

describe('property-list reference runner requirement', () => {
  it('reports unsupported coverage before owner calls or controller fixture seeding', async () => {
    const storyboard = loadStoryboardFile(storyboardPath);
    const fetchFn = vi.fn(async () => {
      throw new Error('An unsupported runner must not contact the agent');
    });

    const result = await runStoryboard('https://agent.example/mcp', storyboard, {
      auth: { type: 'bearer', token: 'owner-test-credential' },
      agentTools: [...(storyboard.required_tools ?? []), 'comply_test_controller'],
      transport: { fetchFn },
    });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.passed_count).toBe(0);
    expect(result.failed_count).toBe(0);
    expect(result.skipped_count).toBe(1);
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0].phase_id).toBe('requirement_unmet');
    expect(result.phases[0].steps).toHaveLength(1);
    expect(result.phases[0].steps[0].skip).toMatchObject({
      reason: 'requirement_unmet',
      detail: expect.stringContaining('property_list_reference_runner'),
    });
  });
});
