import type { RequestHandler, Router } from 'express';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.WORKOS_API_KEY ||= 'sk_test_capability_probe_wiring';
  process.env.WORKOS_CLIENT_ID ||= 'client_capability_probe_wiring';
});

const limiterMocks = vi.hoisted(() => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    pass,
    capabilityProbe: vi.fn(pass),
    storyboardEval: vi.fn(pass),
    storyboardStep: vi.fn(pass),
  };
});

vi.mock('../../src/middleware/rate-limit.js', () => ({
  bulkResolveRateLimiter: limiterMocks.pass,
  brandBulkDomainRateLimiter: limiterMocks.pass,
  brandCreationRateLimiter: limiterMocks.pass,
  capabilityProbeRateLimiter: limiterMocks.capabilityProbe,
  storyboardEvalRateLimiter: limiterMocks.storyboardEval,
  storyboardStepRateLimiter: limiterMocks.storyboardStep,
  agentReadRateLimiter: limiterMocks.pass,
  registryPublisherRateLimiter: limiterMocks.pass,
  registryReadRateLimiter: limiterMocks.pass,
}));

import {
  createRegistryApiRouter,
  type RegistryApiConfig,
} from '../../src/routes/registry-api.js';

function routeHandlers(
  router: Router,
  method: 'get' | 'post',
  path: string,
): RequestHandler[] {
  const layer = (router as unknown as {
    stack: Array<{
      route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: Array<{ handle: RequestHandler }>;
      };
    }>;
  }).stack.find(
    (candidate) =>
      candidate.route?.path === path && candidate.route.methods[method],
  );
  if (!layer?.route) throw new Error(`Route not found: ${method} ${path}`);
  return layer.route.stack.map((entry) => entry.handle);
}

function buildRouter(auth: RequestHandler): Router {
  const config: RegistryApiConfig = {
    brandManager: {} as RegistryApiConfig['brandManager'],
    brandDb: {} as RegistryApiConfig['brandDb'],
    propertyDb: {} as RegistryApiConfig['propertyDb'],
    adagentsManager: {} as RegistryApiConfig['adagentsManager'],
    healthChecker: {} as RegistryApiConfig['healthChecker'],
    crawler: {} as RegistryApiConfig['crawler'],
    capabilityDiscovery: {} as RegistryApiConfig['capabilityDiscovery'],
    registryRequestsDb: {
      trackRequest: async () => {},
      markResolved: async () => true,
    },
    requireAuth: auth,
    optionalAuth: auth,
  };
  return createRegistryApiRouter(config);
}

describe('registry capability probe limiter wiring', () => {
  const auth: RequestHandler = (_req, _res, next) => next();
  const router = buildRouter(auth);

  it('authenticates before applying the dedicated capability probe budget', () => {
    const handlers = routeHandlers(
      router,
      'get',
      '/registry/agents/:encodedUrl/applicable-storyboards',
    );

    expect(handlers).toContain(auth);
    expect(handlers).toContain(limiterMocks.capabilityProbe);
    expect(handlers).not.toContain(limiterMocks.storyboardEval);
    expect(handlers.indexOf(auth)).toBeLessThan(
      handlers.indexOf(limiterMocks.capabilityProbe),
    );
  });

  it('leaves full runs, comparisons, and steps on their existing budgets', () => {
    const runPath = '/registry/agents/:encodedUrl/storyboard/:storyboardId/run';
    const comparePath = '/registry/agents/:encodedUrl/storyboard/:storyboardId/compare';
    const stepPath = '/registry/agents/:encodedUrl/storyboard/:storyboardId/step/:stepId';

    const runHandlers = routeHandlers(router, 'post', runPath);
    const compareHandlers = routeHandlers(router, 'post', comparePath);
    const stepHandlers = routeHandlers(router, 'post', stepPath);

    expect(runHandlers).toContain(limiterMocks.storyboardEval);
    expect(compareHandlers).toContain(limiterMocks.storyboardEval);
    expect(stepHandlers).toContain(limiterMocks.storyboardStep);
    expect(runHandlers).not.toContain(limiterMocks.capabilityProbe);
    expect(compareHandlers).not.toContain(limiterMocks.capabilityProbe);
    expect(stepHandlers).not.toContain(limiterMocks.capabilityProbe);
  });
});
