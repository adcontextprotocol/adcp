import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AdcpError, type CreateAdcpServerFromPlatformOptions } from '@adcp/sdk/server';
import type {
  AgentNotificationConfig,
  SyncAgentNotificationConfigsResponse,
} from '@adcp/sdk/types/tools.generated';
import { canonicalTargetUri } from '@adcp/sdk/signing';
import { isPrivateHostname, normalizeExternalHostname } from '../utils/url-security.js';
import {
  agentWebhookProofTuple,
  proveAgentWebhookControl,
  type AgentWebhookChallengeConfig,
} from './webhook-challenge.js';
import { getSession, sessionKeyFromArgs } from './state.js';
import type { ToolArgs, TrainingContext } from './types.js';

const COLLECTION = 'agent_notification_configs';
type ProtocolHandlers = NonNullable<CreateAdcpServerFromPlatformOptions['protocol']>;
type SyncHandler = NonNullable<ProtocolHandlers['syncAgentNotificationConfigs']>;
type SyncRequest = Parameters<SyncHandler>[0];
type InputNotificationConfig = SyncRequest['notification_configs'][number];
type SyncContext = Parameters<SyncHandler>[1];
type ScopeContext = Parameters<NonNullable<ProtocolHandlers['resolveScope']>>[0];
interface AgentNotificationScope {
  tenant_id: string;
  principal_id: string;
}

interface PersistedAgentNotificationConfigs extends Record<string, unknown> {
  notification_configs: AgentNotificationConfig[];
  proof_tuples: Record<string, string>;
}

function credentialPrincipal(ctx: ScopeContext): string | undefined {
  if (ctx.agent?.agent_url) return `agent:${ctx.agent.agent_url}`;
  const credential = ctx.authInfo?.credential as Record<string, unknown> | undefined;
  if (credential) {
    for (const key of ['agent_url', 'client_id', 'key_id', 'subject']) {
      if (typeof credential[key] === 'string' && credential[key]) {
        return `${String(credential.kind ?? 'credential')}:${credential[key]}`;
      }
    }
  }
  return ctx.authInfo?.clientId ? `client:${ctx.authInfo.clientId}` : undefined;
}

export function resolveAgentNotificationScope(ctx: ScopeContext): AgentNotificationScope {
  const principal = credentialPrincipal(ctx);
  if (!principal) {
    throw new AdcpError('AUTH_REQUIRED', {
      message: 'sync_agent_notification_configs requires an authenticated caller principal',
      recovery: 'correctable',
    });
  }
  return { tenant_id: 'training-agent', principal_id: principal };
}

function documentId(scope: Readonly<AgentNotificationScope>): string {
  return createHash('sha256')
    .update(scope.tenant_id)
    .update('\0')
    .update(scope.principal_id)
    .digest('hex');
}

function redact(config: AgentNotificationConfig): AgentNotificationConfig {
  return {
    ...config,
    ...(config.authentication && {
      authentication: { schemes: [...config.authentication.schemes] as [typeof config.authentication.schemes[0]] },
    }),
  };
}

function normalizedConfig(config: InputNotificationConfig): AgentNotificationConfig {
  const normalizedUrl = canonicalTargetUri(config.url);
  const url = new URL(normalizedUrl);
  const hostname = normalizeExternalHostname(url.hostname);
  if (url.protocol !== 'https:' || !hostname || isPrivateHostname(hostname)) {
    throw new Error('notification URL must be a public HTTPS endpoint');
  }
  return {
    ...structuredClone(config),
    url: normalizedUrl,
    event_types: [...new Set(config.event_types)].sort() as ['capabilities.changed'],
    active: config.active ?? true,
  };
}

function challengeConfig(config: AgentNotificationConfig): AgentWebhookChallengeConfig {
  return {
    subscriberId: config.subscriber_id,
    url: config.url,
    eventTypes: config.event_types,
    ...(config.authentication && { authentication: config.authentication }),
  };
}

export async function syncAgentNotificationConfigs(
  request: SyncRequest,
  ctx: SyncContext,
): Promise<SyncAgentNotificationConfigsResponse> {
  const scope = ctx.callerMutationScope;
  if (!scope) throw new Error('caller mutation scope was not resolved');
  const id = documentId(scope);
  const prior = await ctx.store.get<PersistedAgentNotificationConfigs>(COLLECTION, id);
  const priorConfigs = prior?.notification_configs ?? [];

  let next: AgentNotificationConfig[];
  try {
    const ids = new Set<string>();
    next = request.notification_configs.map((config) => {
      if (ids.has(config.subscriber_id)) throw new Error(`duplicate subscriber_id: ${config.subscriber_id}`);
      ids.add(config.subscriber_id);
      return normalizedConfig(config);
    }).sort((a, b) => a.subscriber_id.localeCompare(b.subscriber_id));
  } catch (error) {
    return {
      status: 'completed',
      action: 'failed',
      notification_configs: priorConfigs.map(redact),
      errors: [{
        code: 'VALIDATION_ERROR',
        message: error instanceof Error ? error.message : 'notification configuration is invalid',
        recovery: 'correctable',
      }],
      ...(request.context !== undefined && { context: request.context }),
    };
  }

  if (request.dry_run) {
    return {
      status: 'completed',
      dry_run: true,
      action: next.length === 0 && priorConfigs.length > 0
        ? 'cleared'
        : isDeepStrictEqual(next, priorConfigs) ? 'unchanged' : 'updated',
      notification_configs: priorConfigs.map(redact),
      ...(request.context !== undefined && { context: request.context }),
    };
  }

  if (isDeepStrictEqual(next, priorConfigs)) {
    return {
      status: 'completed',
      action: 'unchanged',
      notification_configs: priorConfigs.map(redact),
      ...(request.context !== undefined && { context: request.context }),
    };
  }

  const proofTuples = { ...(prior?.proof_tuples ?? {}) };
  for (const config of next) {
    if (config.active === false) continue;
    const challenge = challengeConfig(config);
    const tuple = agentWebhookProofTuple(challenge);
    if (proofTuples[config.subscriber_id] === tuple) continue;
    const proof = await proveAgentWebhookControl(challenge);
    if (!proof.ok) {
      return {
        status: 'completed',
        action: 'failed',
        notification_configs: priorConfigs.map(redact),
        errors: [{
          code: 'SERVICE_UNAVAILABLE',
          message: `Endpoint proof failed for subscriber ${config.subscriber_id}`,
          recovery: 'correctable',
          field: 'notification_configs',
        }],
        ...(request.context !== undefined && { context: request.context }),
      };
    }
    config.url = proof.normalizedUrl;
    proofTuples[config.subscriber_id] = agentWebhookProofTuple(challengeConfig(config));
  }

  const retainedIds = new Set(next.map(config => config.subscriber_id));
  for (const subscriberId of Object.keys(proofTuples)) {
    if (!retainedIds.has(subscriberId)) delete proofTuples[subscriberId];
  }
  await ctx.store.put(COLLECTION, id, {
    notification_configs: next,
    proof_tuples: proofTuples,
  });
  return {
    status: 'completed',
    action: next.length === 0 ? 'cleared' : 'updated',
    notification_configs: next.map(redact),
    ...(request.context !== undefined && { context: request.context }),
  };
}

/** Adapter for the decisioning platform's custom-tool seam. SDK 14.0.0-beta.4
 * projects platform capabilities over low-level protocol capabilities, so the
 * built-in protocol handler cannot currently be mounted through
 * createAdcpServerFromPlatform. Keep the domain implementation identical and
 * persist through the training agent's normal cross-machine session store. */
export async function syncAgentNotificationConfigsLegacy(
  args: ToolArgs,
  trainingCtx: TrainingContext,
): Promise<Record<string, unknown>> {
  const principal = trainingCtx.authenticatedAgentUrl
    ? `agent:${trainingCtx.authenticatedAgentUrl}`
    : trainingCtx.principal && trainingCtx.principal !== 'anonymous'
      ? `client:${trainingCtx.principal}`
      : undefined;
  if (!principal) {
    return {
      errors: [{
        code: 'AUTH_REQUIRED',
        message: 'sync_agent_notification_configs requires an authenticated caller principal',
        recovery: 'correctable',
      }],
    };
  }
  const session = await getSession(sessionKeyFromArgs(
    {},
    trainingCtx.mode,
    trainingCtx.userId,
    trainingCtx.moduleId,
    principal,
  ));
  const store = {
    get: async (_collection: string, id: string) => session.agentNotificationConfigs.get(id) ?? null,
    put: async (_collection: string, id: string, data: Record<string, unknown>) => {
      session.agentNotificationConfigs.set(id, structuredClone(data));
    },
  };
  return await syncAgentNotificationConfigs(
    args as never,
    {
      store,
      callerMutationScope: { tenant_id: 'training-agent', principal_id: principal },
      authInfo: { clientId: principal },
    } as unknown as SyncContext,
  ) as unknown as Record<string, unknown>;
}
