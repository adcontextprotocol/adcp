import { beforeEach, describe, expect, it, vi } from 'vitest';

const list = vi.hoisted(() => vi.fn());
vi.mock('@adcp/sdk/testing', () => ({ listAllComplianceStoryboards: list }));

const { getCachedComplianceStoryboardById, clearComplianceStoryboardCache } = await import('../../src/compliance/storyboard-cache.js');

const storyboard = (id: string) => ({ id, phases: [{ id: 'p', steps: [{ id: 's', task: 't' }] }] });

describe('compliance storyboard cache', () => {
  beforeEach(() => {
    clearComplianceStoryboardCache();
    list.mockReset();
    list.mockImplementation(() => [storyboard('a'), storyboard('b')]);
  });

  it('parses a bundle once and serves every ID from it', () => {
    const options = { version: '3.3.0-beta.1', complianceDir: '/bundles/3.3' };
    expect(getCachedComplianceStoryboardById('a', options)?.id).toBe('a');
    expect(getCachedComplianceStoryboardById('b', { ...options, unrelatedRunOption: true } as never)?.id).toBe('b');
    expect(getCachedComplianceStoryboardById('missing', options)).toBeUndefined();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('returns a clone, so callers cannot change the cached storyboard', () => {
    const first = getCachedComplianceStoryboardById('a')!;
    first.phases[0].steps[0].id = 'mutated';
    expect(getCachedComplianceStoryboardById('a')!.phases[0].steps[0].id).toBe('s');
  });

  it('keeps bundles for different versions or directories apart', () => {
    getCachedComplianceStoryboardById('a', { version: '3.2', complianceDir: '/x' });
    getCachedComplianceStoryboardById('a', { version: '3.3.0-beta.1', complianceDir: '/x' });
    getCachedComplianceStoryboardById('a', { version: '3.2', complianceDir: '/y' });
    getCachedComplianceStoryboardById('a', { version: '3.2', complianceDir: '/y', hostedStableLineAlias: '3.2' });
    expect(list).toHaveBeenCalledTimes(4);
  });

  it('does not cache a bundle that fails to load', () => {
    list.mockImplementationOnce(() => { throw new Error('missing bundle'); });
    expect(() => getCachedComplianceStoryboardById('a', { version: '9.9' })).toThrow('missing bundle');
    expect(getCachedComplianceStoryboardById('a', { version: '9.9' })?.id).toBe('a');
    expect(list).toHaveBeenCalledTimes(2);
  });
});
