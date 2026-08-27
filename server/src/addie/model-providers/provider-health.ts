import { createLogger } from '../../logger.js';
import { notifySystemError } from '../error-notifier.js';
import type { ModelProviderId } from './model-provider.js';
import {
  classifyProviderFailure,
  type ProviderFailure,
  type ProviderFailureCategory,
} from './provider-errors.js';

const logger = createLogger('addie-provider-health');

export type ProviderService = 'chat' | 'router';
export type ProviderCircuitStatus = 'healthy' | 'degraded' | 'open' | 'half_open';

export interface ProviderAvailability {
  allowed: boolean;
  provider: ModelProviderId;
  service: ProviderService;
  status: ProviderCircuitStatus;
  category?: ProviderFailureCategory;
  retryAfterSeconds?: number;
}

interface CircuitState {
  status: Exclude<ProviderCircuitStatus, 'healthy'>;
  category: ProviderFailureCategory;
  consecutiveFailures: number;
  windowStartedAtMs: number;
  blockedUntilMs: number;
  probeLeaseUntilMs: number;
}

export interface ProviderHealthConfig {
  failureThreshold: number;
  failureWindowMs: number;
  transientCooldownMs: number;
  billingCooldownMs: number;
  probeLeaseMs: number;
}

const DEFAULT_CONFIG: ProviderHealthConfig = {
  failureThreshold: 3,
  failureWindowMs: 60_000,
  transientCooldownMs: 30_000,
  billingCooldownMs: 5 * 60_000,
  probeLeaseMs: 30_000,
};

function circuitKey(provider: ModelProviderId, service: ProviderService): string {
  return `${provider}:${service}`;
}

function retryAfterSeconds(state: CircuitState, nowMs: number): number | undefined {
  const remainingMs = state.status === 'half_open'
    ? state.probeLeaseUntilMs - nowMs
    : state.blockedUntilMs - nowMs;
  return remainingMs > 0 ? Math.max(1, Math.ceil(remainingMs / 1000)) : undefined;
}

export class ProviderCircuitOpenError extends Error {
  constructor(readonly availability: ProviderAvailability) {
    super(`Provider circuit is ${availability.status} for ${availability.provider}:${availability.service}`);
    this.name = 'ProviderCircuitOpenError';
  }
}

export class ProviderHealthController {
  private readonly serviceStates = new Map<string, CircuitState>();
  private readonly accountStates = new Map<ModelProviderId, CircuitState>();
  private readonly config: ProviderHealthConfig;
  private readonly now: () => number;

  constructor(config: Partial<ProviderHealthConfig> = {}, now: () => number = Date.now) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.now = now;
  }

  acquire(provider: ModelProviderId, service: ProviderService): ProviderAvailability {
    const nowMs = this.now();
    const account = this.acquireState(this.accountStates, provider, provider, service, nowMs);
    if (account) return account;
    const serviceState = this.acquireState(
      this.serviceStates,
      circuitKey(provider, service),
      provider,
      service,
      nowMs,
    );
    return serviceState ?? { allowed: true, provider, service, status: 'healthy' };
  }

  private acquireState<K>(
    states: Map<K, CircuitState>,
    key: K,
    provider: ModelProviderId,
    service: ProviderService,
    nowMs: number,
  ): ProviderAvailability | null {
    const state = states.get(key);
    if (!state) return null;
    if (state.status === 'degraded') {
      return { allowed: true, provider, service, status: 'degraded', category: state.category };
    }
    if (state.status === 'open' && nowMs < state.blockedUntilMs) {
      return {
        allowed: false,
        provider,
        service,
        status: 'open',
        category: state.category,
        retryAfterSeconds: retryAfterSeconds(state, nowMs),
      };
    }
    if (state.status === 'half_open' && nowMs < state.probeLeaseUntilMs) {
      return {
        allowed: false,
        provider,
        service,
        status: 'half_open',
        category: state.category,
        retryAfterSeconds: retryAfterSeconds(state, nowMs),
      };
    }

    state.status = 'half_open';
    state.probeLeaseUntilMs = nowMs + this.config.probeLeaseMs;
    return { allowed: true, provider, service, status: 'half_open', category: state.category };
  }

  recordSuccess(provider: ModelProviderId, service: ProviderService): void {
    const serviceDeleted = this.serviceStates.delete(circuitKey(provider, service));
    const accountDeleted = this.accountStates.delete(provider);
    if (serviceDeleted || accountDeleted) {
      logger.info({ provider, service, event: 'provider_circuit_recovered' }, 'Provider circuit recovered');
    }
  }

  recordFailure(provider: ModelProviderId, service: ProviderService, error: unknown): ProviderAvailability {
    const nowMs = this.now();
    const failure = classifyProviderFailure(provider, error, nowMs);
    if (failure.category === 'billing_exhausted') {
      return this.openCircuit(
        this.accountStates,
        provider,
        provider,
        service,
        failure,
        nowMs,
        this.config.billingCooldownMs,
      );
    }

    const states = this.serviceStates;
    const key = circuitKey(provider, service);
    if (failure.category === 'rate_limited' || failure.retryAfterSeconds !== undefined) {
      return this.openCircuit(
        states,
        key,
        provider,
        service,
        failure,
        nowMs,
        Math.max(
          this.config.transientCooldownMs,
          (failure.retryAfterSeconds ?? 0) * 1000,
        ),
      );
    }

    if (!['overloaded', 'timeout', 'unavailable'].includes(failure.category)) {
      return { allowed: true, provider, service, status: 'healthy', category: failure.category };
    }

    const previous = states.get(key);
    // A failed recovery probe is direct evidence that the provider is still
    // unhealthy. Reopen immediately instead of letting the original failure
    // window expire and briefly admitting normal traffic again.
    if (previous?.status === 'half_open') {
      return this.openCircuit(
        states,
        key,
        provider,
        service,
        failure,
        nowMs,
        this.config.transientCooldownMs,
        previous.consecutiveFailures + 1,
        nowMs,
      );
    }
    const withinWindow = previous && nowMs - previous.windowStartedAtMs <= this.config.failureWindowMs;
    const consecutiveFailures = withinWindow ? previous.consecutiveFailures + 1 : 1;
    if (consecutiveFailures < this.config.failureThreshold) {
      states.set(key, {
        status: 'degraded',
        category: failure.category,
        consecutiveFailures,
        windowStartedAtMs: withinWindow ? previous.windowStartedAtMs : nowMs,
        blockedUntilMs: 0,
        probeLeaseUntilMs: 0,
      });
      logger.warn(
        { provider, service, category: failure.category, consecutiveFailures, event: 'provider_degraded' },
        'Provider health degraded',
      );
      return { allowed: true, provider, service, status: 'degraded', category: failure.category };
    }

    return this.openCircuit(
      states,
      key,
      provider,
      service,
      { ...failure },
      nowMs,
      this.config.transientCooldownMs,
      consecutiveFailures,
      withinWindow ? previous.windowStartedAtMs : nowMs,
    );
  }

  private openCircuit<K>(
    states: Map<K, CircuitState>,
    key: K,
    provider: ModelProviderId,
    service: ProviderService,
    failure: ProviderFailure,
    nowMs: number,
    cooldownMs: number,
    consecutiveFailures = 1,
    windowStartedAtMs = nowMs,
  ): ProviderAvailability {
    const blockedUntilMs = nowMs + cooldownMs;
    states.set(key, {
      status: 'open',
      category: failure.category,
      consecutiveFailures,
      windowStartedAtMs,
      blockedUntilMs,
      probeLeaseUntilMs: 0,
    });
    const retrySeconds = Math.max(1, Math.ceil(cooldownMs / 1000));
    logger.warn(
      {
        provider,
        service,
        category: failure.category,
        retryAfterSeconds: retrySeconds,
        consecutiveFailures,
        event: 'provider_circuit_opened',
      },
      'Provider circuit opened',
    );
    notifySystemError({
      source: failure.category === 'billing_exhausted'
        ? `${provider}-billing-exhausted`
        : `${provider}-${service}-circuit-open`,
      errorMessage: [
        `provider=${provider}`,
        `service=${service}`,
        `category=${failure.category}`,
        `retry_after_seconds=${retrySeconds}`,
        `consecutive_failures=${consecutiveFailures}`,
      ].join('\n'),
    });
    return {
      allowed: false,
      provider,
      service,
      status: 'open',
      category: failure.category,
      retryAfterSeconds: retrySeconds,
    };
  }
}

export function formatProviderUnavailableMessage(availability: ProviderAvailability): string {
  const prefix = availability.category === 'rate_limited'
    ? 'The AI service is temporarily rate limited.'
    : 'The AI service is temporarily unavailable.';
  if (!availability.retryAfterSeconds) return `${prefix} Please try again shortly.`;
  const seconds = availability.retryAfterSeconds;
  if (seconds < 90) return `${prefix} Please try again in about ${seconds} seconds.`;
  return `${prefix} Please try again in about ${Math.ceil(seconds / 60)} minutes.`;
}
