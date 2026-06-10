import type { StoryboardRunOptions } from '@adcp/sdk/testing';

export interface LoadedTestKit {
  brand?: { house?: { domain?: string }; brand_id?: string };
  auth?: {
    api_key?: string;
    basic?: { username?: string; password?: string; credentials?: string };
    probe_task?: string;
  };
}

/**
 * Per-tenant probe-task override for security_baseline's auth probes.
 *
 * Most shared test-kits declare `auth.probe_task: list_creatives`, but cached
 * prerelease kits can lag the allowlist. Sales/creative explicitly pin the
 * allowlisted protected read they serve. /signals and /governance serve
 * different SDK-allowlisted protected reads.
 */
export const PROBE_TASK_BY_TENANT: Record<string, string> = {
  sales: 'list_creatives',
  creative: 'list_creatives',
  signals: 'get_signals',
  governance: 'list_content_standards',
};

/**
 * Thread the test-kit's auth material through to the storyboard runner so
 * kit-gated auth phases execute instead of being skipped by `skip_if`.
 */
export function testKitOptionsFromKit(
  kit: LoadedTestKit | undefined,
  tenantPath = process.env.TENANT_PATH,
): StoryboardRunOptions['test_kit'] | undefined {
  const auth = kit?.auth;
  if (!auth?.api_key && !auth?.basic && !auth?.probe_task) return undefined;
  if (!auth.probe_task) {
    throw new Error('test kit declares auth credentials without auth.probe_task — required by runner');
  }
  const probeTask = (tenantPath && PROBE_TASK_BY_TENANT[tenantPath]) ?? auth.probe_task;
  return {
    auth: {
      ...(auth.api_key !== undefined && { api_key: auth.api_key }),
      ...(auth.basic !== undefined && { basic: auth.basic }),
      probe_task: probeTask,
    },
  };
}

/**
 * Pick run-scoped transport auth for the manual storyboard runner.
 *
 * `security_baseline` positive credential probes use normal initialized
 * transport calls, so a single run can only prove one static credential type.
 * Dual-credential kits must be split into per-mechanism runs before they can
 * be graded safely here.
 */
export function authForStoryboard(
  storyboardId: string,
  kit: LoadedTestKit | undefined,
  defaultBearerToken: string,
): StoryboardRunOptions['auth'] {
  if (storyboardId === 'security_baseline' && kit?.auth?.api_key && kit.auth.basic) {
    throw new Error(
      'security_baseline test kit declares both auth.api_key and auth.basic; manual runner cannot grade both initialized-session credential paths in one run',
    );
  }

  if ((storyboardId === 'billing_gate_dispatch' || storyboardId === 'security_baseline') && kit?.auth?.api_key) {
    return { type: 'bearer', token: kit.auth.api_key };
  }

  if (storyboardId === 'security_baseline' && kit?.auth?.basic) {
    const { username, password, credentials } = kit.auth.basic;
    if (username && password) return { type: 'basic', username, password };
    if (credentials) {
      const colonIndex = credentials.indexOf(':');
      if (colonIndex > 0) {
        return {
          type: 'basic',
          username: credentials.slice(0, colonIndex),
          password: credentials.slice(colonIndex + 1),
        };
      }
    }
    throw new Error('security_baseline auth.basic must provide username/password or credentials in "username:password" form');
  }

  return { type: 'bearer', token: defaultBearerToken };
}
