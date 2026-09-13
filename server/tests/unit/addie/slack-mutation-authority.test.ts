import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ epoch: vi.fn() }));

vi.mock('../../../src/db/authorization-epoch-db.js', () => ({
  getExactCredentialAuthorizationEpoch: mocks.epoch,
}));

import { createAddieToolExecutor } from '../../../src/addie/model-providers/tool-orchestration.js';
import { captureSlackMutationAuthority } from '../../../src/addie/slack-mutation-authority.js';
import type { AddieTool } from '../../../src/addie/types.js';

const mutationTool: AddieTool = {
  name: 'create_github_issue',
  description: 'Create issue',
  input_schema: { type: 'object', properties: {} },
};

describe('Slack exact-credential mutation authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.epoch.mockResolvedValue('4');
  });

  it('captures after assembly and blocks a remap committed during reservation', async () => {
    let mappedCredential = 'credential_a';
    const lookupCredential = vi.fn(async () => ({
      status: 'authorized' as const,
      credentialId: mappedCredential,
    }));
    const revalidate = await captureSlackMutationAuthority({
      assembledCredentialId: 'credential_a',
      platformAdminMutationTools: [],
      lookupCredential,
      revalidatePlatformAdmin: vi.fn(),
    });
    const handler = vi.fn();
    const reserveSideEffect = vi.fn(async () => { mappedCredential = 'credential_b'; });
    const execute = createAddieToolExecutor(
      [mutationTool],
      new Map([[mutationTool.name, handler]]),
      {
        executionMode: 'production',
        policy: () => ({ allowed: true }),
        reserveSideEffect,
        revalidateSideEffectAuthority: revalidate,
      },
    );

    const result = await execute({
      type: 'tool_call', id: 'call-1', name: mutationTool.name, input: { title: 'Review' },
    }, 1);

    expect(lookupCredential).toHaveBeenCalledTimes(3); // capture + both dispatch barriers
    expect(reserveSideEffect).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
    expect(result.execution).toMatchObject({
      dispatch_status: 'not_dispatched',
      normalized_result: { status: 'access_denied' },
    });
  });

  it('denies an unmapped mutation without reserving or dispatching', async () => {
    const revalidate = await captureSlackMutationAuthority({
      assembledCredentialId: 'credential_a',
      platformAdminMutationTools: [],
      lookupCredential: vi.fn().mockResolvedValue({ status: 'forbidden' }),
      revalidatePlatformAdmin: vi.fn(),
    });
    const handler = vi.fn();
    const reserveSideEffect = vi.fn();
    const execute = createAddieToolExecutor(
      [mutationTool],
      new Map([[mutationTool.name, handler]]),
      {
        executionMode: 'production',
        policy: () => ({ allowed: true }),
        reserveSideEffect,
        revalidateSideEffectAuthority: revalidate,
      },
    );

    const result = await execute({
      type: 'tool_call', id: 'call-2', name: mutationTool.name, input: {},
    }, 1);
    expect(result.execution.normalized_result?.status).toBe('access_denied');
    expect(reserveSideEffect).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('fails retryably when mapping storage becomes unavailable', async () => {
    const lookupCredential = vi.fn()
      .mockResolvedValueOnce({ status: 'authorized', credentialId: 'credential_a' })
      .mockResolvedValueOnce({ status: 'unavailable' });
    const revalidate = await captureSlackMutationAuthority({
      assembledCredentialId: 'credential_a',
      platformAdminMutationTools: [],
      lookupCredential,
      revalidatePlatformAdmin: vi.fn(),
    });

    await expect(revalidate({ toolName: mutationTool.name }))
      .resolves.toEqual({ allowed: false, status: 'recoverable_error' });
  });

  it('rejects a fresh live mapping when handlers were assembled for a different credential', async () => {
    const lookupCredential = vi.fn().mockResolvedValue({
      status: 'authorized',
      credentialId: 'credential_b',
    });
    const revalidate = await captureSlackMutationAuthority({
      assembledCredentialId: 'credential_a',
      platformAdminMutationTools: [],
      lookupCredential,
      revalidatePlatformAdmin: vi.fn(),
    });

    await expect(revalidate({ toolName: mutationTool.name }))
      .resolves.toEqual({ allowed: false, status: 'access_denied' });
    expect(mocks.epoch).not.toHaveBeenCalled();
  });
});
