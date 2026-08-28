import type { TaskRegistryScope } from '@adcp/sdk/server';

export type TaskRegistryTenant = 'sales' | 'signals';
export type TrainingTaskRegistryScope = TaskRegistryScope & { registryNamespace: string };

const TASK_REGISTRY_NAMESPACE_PREFIX = 'adcp-training-agent';

export function taskRegistryNamespaceForTenant(tenantId: string): string {
  return `${TASK_REGISTRY_NAMESPACE_PREFIX}:${tenantId}`;
}

type TaskScopeCredential =
  | { kind: 'http_sig'; agent_url: string }
  | { kind: 'oauth'; client_id: string }
  | { kind: 'api_key'; key_id: string };

/**
 * Mirror the SDK's trusted task-owner partition for platform handoffs.
 * Buyer-agent identity wins when the configured registry resolved one;
 * transport credentials are the fallback for contexts without a registry.
 * The training server does not configure the SDK's optional session-key
 * resolver, so there is no session scope that can precede these branches.
 */
export function taskRegistryScopeFromContext(ctx: {
  account: { id: string };
  agent?: { agent_url: string };
  authInfo?: { credential?: TaskScopeCredential; clientId?: string };
}, tenantId: TaskRegistryTenant): TrainingTaskRegistryScope {
  const accountId = ctx.account.id;
  const registryNamespace = taskRegistryNamespaceForTenant(tenantId);
  if (ctx.agent?.agent_url) {
    return { registryNamespace, accountId, ownerScope: `agent:${ctx.agent.agent_url}` };
  }

  const credential = ctx.authInfo?.credential;
  if (credential?.kind === 'http_sig') {
    return { registryNamespace, accountId, ownerScope: `http_sig:${credential.agent_url}` };
  }
  if (credential?.kind === 'oauth') {
    return { registryNamespace, accountId, ownerScope: `oauth:${credential.client_id}` };
  }
  if (credential?.kind === 'api_key') {
    return { registryNamespace, accountId, ownerScope: `api_key:${credential.key_id}` };
  }
  if (ctx.authInfo?.clientId) {
    return { registryNamespace, accountId, ownerScope: `client:${ctx.authInfo.clientId}` };
  }
  return { registryNamespace, accountId, ownerScope: `account:${accountId}` };
}
