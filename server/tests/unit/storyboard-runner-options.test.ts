import { describe, expect, it } from 'vitest';

import {
  authForStoryboard,
  testKitOptionsFromKit,
  type LoadedTestKit,
} from '../../src/compliance/storyboard-runner-options.js';

describe('storyboard runner option helpers', () => {
  it('threads API-key test-kit auth into security_baseline transport auth', () => {
    const kit: LoadedTestKit = {
      auth: { api_key: 'kit-api-key', probe_task: 'list_creatives' },
    };

    expect(authForStoryboard('security_baseline', kit, 'default-token')).toEqual({
      type: 'bearer',
      token: 'kit-api-key',
    });
  });

  it('threads Basic username/password test-kit auth into security_baseline transport auth', () => {
    const kit: LoadedTestKit = {
      auth: {
        basic: { username: 'agent-user', password: 'agent-pass' },
        probe_task: 'list_creatives',
      },
    };

    expect(authForStoryboard('security_baseline', kit, 'default-token')).toEqual({
      type: 'basic',
      username: 'agent-user',
      password: 'agent-pass',
    });
  });

  it('threads Basic test-kit auth with an empty password into security_baseline transport auth', () => {
    const kit: LoadedTestKit = {
      auth: {
        basic: { username: 'agent-user', password: '' },
        probe_task: 'list_creatives',
      },
    };

    expect(authForStoryboard('security_baseline', kit, 'default-token')).toEqual({
      type: 'basic',
      username: 'agent-user',
      password: '',
    });
  });

  it('parses Basic credentials pairs without truncating passwords that contain colons', () => {
    const kit: LoadedTestKit = {
      auth: {
        basic: { credentials: 'agent-user:pass:with:colons' },
        probe_task: 'list_creatives',
      },
    };

    expect(authForStoryboard('security_baseline', kit, 'default-token')).toEqual({
      type: 'basic',
      username: 'agent-user',
      password: 'pass:with:colons',
    });
  });

  it('parses Basic credentials pairs with an empty password', () => {
    const kit: LoadedTestKit = {
      auth: {
        basic: { credentials: 'agent-user:' },
        probe_task: 'list_creatives',
      },
    };

    expect(authForStoryboard('security_baseline', kit, 'default-token')).toEqual({
      type: 'basic',
      username: 'agent-user',
      password: '',
    });
  });

  it('rejects Basic credentials pairs with an empty username', () => {
    const kit: LoadedTestKit = {
      auth: {
        basic: { credentials: ':agent-pass' },
        probe_task: 'list_creatives',
      },
    };

    expect(() => authForStoryboard('security_baseline', kit, 'default-token')).toThrow(/auth\.basic/);
  });

  it('fails fast for dual-credential security_baseline kits until runs are split by mechanism', () => {
    const kit: LoadedTestKit = {
      auth: {
        api_key: 'kit-api-key',
        basic: { username: 'agent-user', password: 'agent-pass' },
        probe_task: 'list_creatives',
      },
    };

    expect(() => authForStoryboard('security_baseline', kit, 'default-token')).toThrow(/both auth\.api_key and auth\.basic/);
  });

  it('keeps billing_gate_dispatch on the kit API key and other storyboards on the default token', () => {
    const kit: LoadedTestKit = {
      auth: { api_key: 'kit-api-key', probe_task: 'list_creatives' },
    };

    expect(authForStoryboard('billing_gate_dispatch', kit, 'default-token')).toEqual({
      type: 'bearer',
      token: 'kit-api-key',
    });
    expect(authForStoryboard('schema_validation', kit, 'default-token')).toEqual({
      type: 'bearer',
      token: 'default-token',
    });
  });

  it('builds test_kit auth options and applies tenant probe-task overrides', () => {
    const kit: LoadedTestKit = {
      auth: {
        api_key: 'kit-api-key',
        basic: { username: 'agent-user', password: 'agent-pass' },
        probe_task: 'list_creatives',
      },
    };

    expect(testKitOptionsFromKit(kit, 'signals')).toEqual({
      auth: {
        api_key: 'kit-api-key',
        basic: { username: 'agent-user', password: 'agent-pass' },
        probe_task: 'get_signals',
      },
    });
  });

  it('requires probe_task when a test kit declares auth credentials', () => {
    const kit: LoadedTestKit = { auth: { api_key: 'kit-api-key' } };

    expect(() => testKitOptionsFromKit(kit, 'sales')).toThrow(/without auth\.probe_task/);
  });
});
