import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ epoch: vi.fn(), workosGetUser: vi.fn() }));

vi.mock('../../../src/db/authorization-epoch-db.js', () => ({
  getExactCredentialAuthorizationEpoch: mocks.epoch,
}));

vi.mock('../../../src/auth/workos-client.js', () => ({
  getAuthorizationEnforcementWorkos: () => ({
    userManagement: { getUser: mocks.workosGetUser },
  }),
}));

import { createAddieToolExecutor } from '../../../src/addie/model-providers/tool-orchestration.js';
import { captureSlackMutationAuthority } from '../../../src/addie/slack-mutation-authority.js';
import type { AddieTool } from '../../../src/addie/types.js';

const mutationTool: AddieTool = {
  name: 'create_github_issue',
  description: 'Create issue',
  input_schema: { type: 'object', properties: {} },
};
const sensitiveReadTool: AddieTool = {
  name: 'list_escalations',
  description: 'List escalations',
  input_schema: { type: 'object', properties: {} },
};

describe('Slack exact-credential mutation authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.epoch.mockResolvedValue('4');
    mocks.workosGetUser.mockImplementation(async (credentialId: string) => ({
      id: credentialId,
      email: `${credentialId}@example.test`,
    }));
  });

  it.each([
    ['platform-admin revocation', 'forbidden', 'access_denied'],
    ['platform-admin source outage', 'unavailable', 'recoverable_error'],
  ] as const)('blocks a sensitive read after %s between capture and dispatch', async (_label, decision, status) => {
    const revalidatePlatformAdmin = vi.fn()
      .mockResolvedValueOnce('authorized')
      .mockResolvedValueOnce(decision);
    const revalidate = await captureSlackMutationAuthority({
      assembledCredentialId: 'credential_a',
      credentialEmail: 'credential_a@example.test',
      platformAdminTools: [sensitiveReadTool.name],
      lookupCredential: vi.fn().mockResolvedValue({
        status: 'authorized', credentialId: 'credential_a',
      }),
      revalidatePlatformAdmin,
    });
    const handler = vi.fn();
    const execute = createAddieToolExecutor(
      [sensitiveReadTool],
      new Map([[sensitiveReadTool.name, handler]]),
      {
        executionMode: 'production',
        policy: () => ({ allowed: true }),
        revalidateToolAuthority: revalidate,
      },
    );

    const result = await execute({
      type: 'tool_call', id: `read-${decision}`, name: sensitiveReadTool.name, input: {},
    }, 1);

    expect(handler).not.toHaveBeenCalled();
    expect(result.execution.normalized_result?.status).toBe(status);
    expect(revalidatePlatformAdmin).toHaveBeenCalledTimes(2);
  });

  it('captures after assembly and blocks a remap committed during reservation', async () => {
    let mappedCredential = 'credential_a';
    const lookupCredential = vi.fn(async () => ({
      status: 'authorized' as const,
      credentialId: mappedCredential,
    }));
    const revalidate = await captureSlackMutationAuthority({
      assembledCredentialId: 'credential_a',
      credentialEmail: 'credential_a@example.test',
      platformAdminTools: [],
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
        revalidateToolAuthority: revalidate,
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

  it.each([
    ['break-glass email removal', 'email_changed', 'access_denied'],
    ['WorkOS credential deletion', 'deleted', 'access_denied'],
    ['WorkOS lifecycle outage', 'unavailable', 'recoverable_error'],
  ] as const)('blocks Slack dispatch after %s during reservation', async (_label, nextState, status) => {
    let providerState: 'current' | typeof nextState = 'current';
    mocks.workosGetUser.mockImplementation(async (credentialId: string) => {
      if (providerState === 'deleted') throw Object.assign(new Error('missing'), { status: 404 });
      if (providerState === 'unavailable') throw Object.assign(new Error('timeout'), { status: 503 });
      return {
        id: credentialId,
        email: providerState === 'email_changed'
          ? 'ordinary@example.test'
          : 'breakglass@example.test',
      };
    });
    const revalidate = await captureSlackMutationAuthority({
      assembledCredentialId: 'credential_a',
      credentialEmail: 'breakglass@example.test',
      platformAdminTools: [mutationTool.name],
      lookupCredential: vi.fn().mockResolvedValue({
        status: 'authorized', credentialId: 'credential_a',
      }),
      // Deliberately remains stale-authorized: lifecycle proof must preempt it.
      revalidatePlatformAdmin: vi.fn().mockResolvedValue('authorized'),
    });
    const handler = vi.fn();
    const reserveSideEffect = vi.fn(async () => { providerState = nextState; });
    const execute = createAddieToolExecutor(
      [mutationTool],
      new Map([[mutationTool.name, handler]]),
      {
        executionMode: 'production',
        policy: () => ({ allowed: true }),
        reserveSideEffect,
        revalidateToolAuthority: revalidate,
      },
    );

    const result = await execute({
      type: 'tool_call', id: `call-${nextState}`, name: mutationTool.name, input: {},
    }, 1);

    expect(reserveSideEffect).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
    expect(result.execution).toMatchObject({
      dispatch_status: 'not_dispatched',
      normalized_result: { status },
    });
  });

  it('denies an unmapped mutation without reserving or dispatching', async () => {
    const revalidate = await captureSlackMutationAuthority({
      assembledCredentialId: 'credential_a',
      credentialEmail: 'credential_a@example.test',
      platformAdminTools: [],
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
        revalidateToolAuthority: revalidate,
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
      credentialEmail: 'credential_a@example.test',
      platformAdminTools: [],
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
      credentialEmail: 'credential_a@example.test',
      platformAdminTools: [],
      lookupCredential,
      revalidatePlatformAdmin: vi.fn(),
    });

    await expect(revalidate({ toolName: mutationTool.name }))
      .resolves.toEqual({ allowed: false, status: 'access_denied' });
    expect(mocks.epoch).not.toHaveBeenCalled();
  });
});
