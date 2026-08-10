import { describe, expect, it, vi } from 'vitest';
import { CrawlerService } from '../../src/crawler.js';

describe('CrawlerService single-domain profile rebuild', () => {
  async function makeCrawlerContext(params: {
    existingAuthorizations: Array<{ agent_url: string; source: string }>;
    authorizedAgents: Array<{ url: string }>;
  }) {
    const proto = (CrawlerService as any).prototype;
    const ctx = Object.create(proto);

    Object.assign(ctx, {
      crawling: false,
      adAgentsManager: {
        validateDomain: vi.fn().mockResolvedValue({
          valid: true,
          raw_data: {
            authorized_agents: params.authorizedAgents,
            properties: [],
          },
          status_code: 200,
          response_bytes: 128,
          resolved_url: 'https://publisher.example/.well-known/adagents.json',
          discovery_method: 'direct',
          manager_domain: null,
        }),
      },
      federatedIndex: {
        getAuthorizationsForDomain: vi.fn().mockResolvedValue(params.existingAuthorizations),
        recordAgentFromAdagentsJson: vi.fn().mockResolvedValue(undefined),
        reconcileAdagentsAuthorizations: vi.fn().mockResolvedValue(undefined),
      },
      cacheAdagentsManifest: vi.fn().mockResolvedValue(true),
      scanBrandForDomain: vi.fn().mockResolvedValue(undefined),
      buildInventoryProfiles: vi.fn().mockResolvedValue(new Map()),
    });

    return ctx;
  }

  it('rejects visibly when a full crawl owns the crawler', async () => {
    const ctx = Object.create((CrawlerService as any).prototype);
    const validateDomain = vi.fn();
    Object.assign(ctx, {
      crawling: true,
      adAgentsManager: { validateDomain },
    });

    await expect(ctx.crawlSingleDomain('publisher.example', {
      requestId: 'crawl-request-id',
      source: 'test',
    })).rejects.toMatchObject({ code: 'crawl_deferred' });
    expect(validateDomain).not.toHaveBeenCalled();
  });

  it('does not admit an HTTP-style crawl request while a full crawl is active', async () => {
    const ctx = Object.create((CrawlerService as any).prototype);
    Object.assign(ctx, { crawling: true });

    expect(ctx.tryStartSingleDomainCrawl('publisher.example', {
      requestId: 'crawl-request-id',
      source: 'api:crawl-request',
    })).toBeNull();
  });

  it('does not advance manager revalidation failure backoff when a full crawl defers the item', async () => {
    const ctx = Object.create((CrawlerService as any).prototype);
    const deferredError = Object.assign(new Error('Full crawl in progress'), {
      code: 'crawl_deferred',
    });
    const publisherDb = {
      dequeueRevalidationBatch: vi.fn().mockResolvedValue([
        { publisher_domain: 'publisher.example', manager_domain: 'manager.example', attempts: 0 },
      ]),
      markRevalidationSucceeded: vi.fn(),
      markRevalidationFailed: vi.fn(),
    };
    Object.assign(ctx, {
      managerRevalidationProcessing: false,
      publisherDb,
      crawlSingleDomain: vi.fn().mockRejectedValue(deferredError),
    });

    await expect(ctx.processManagerRevalidationQueue()).resolves.toEqual({
      processed: 1,
      succeeded: 0,
      failed: 0,
    });
    expect(publisherDb.markRevalidationSucceeded).not.toHaveBeenCalled();
    expect(publisherDb.markRevalidationFailed).not.toHaveBeenCalled();
  });

  it('releases full-crawl ownership when setup fails', async () => {
    const ctx = Object.create((CrawlerService as any).prototype);
    Object.assign(ctx, {
      crawling: false,
      getPausedAgentUrls: vi.fn().mockRejectedValue(new Error('database unavailable')),
    });

    await expect(ctx.crawlAllAgents([])).rejects.toThrow('database unavailable');
    expect(ctx.crawling).toBe(false);
  });

  it('admits only one in-process full-crawl coordination attempt', async () => {
    const ctx = Object.create((CrawlerService as any).prototype);
    let resolveIntent!: (value: boolean) => void;
    const intentPending = new Promise<boolean>((resolve) => { resolveIntent = resolve; });
    const ensureFullCrawlIntentLock = vi.fn().mockReturnValue(intentPending);
    const lastResult = { marker: 'last-result' };
    Object.assign(ctx, {
      crawling: false,
      fullCrawlCoordinationInProgress: false,
      crawlerSchedulersStopping: false,
      coordinateCrawlsAcrossInstances: true,
      fullCrawlIntentLock: null,
      ensureFullCrawlIntentLock,
      scheduleFullCrawlLockRetry: vi.fn(),
      lastResult,
    });

    const first = ctx.crawlAllAgents([]);
    await vi.waitFor(() => expect(ensureFullCrawlIntentLock).toHaveBeenCalledOnce());
    await expect(ctx.crawlAllAgents([])).resolves.toBe(lastResult);
    resolveIntent(false);
    await expect(first).resolves.toBe(lastResult);

    expect(ensureFullCrawlIntentLock).toHaveBeenCalledOnce();
    expect(ctx.fullCrawlCoordinationInProgress).toBe(false);
  });

  it('does not open coordination sessions after crawler shutdown begins', async () => {
    const ctx = Object.create((CrawlerService as any).prototype);
    const ensureFullCrawlIntentLock = vi.fn();
    const lastResult = { marker: 'last-result' };
    Object.assign(ctx, {
      crawling: false,
      fullCrawlCoordinationInProgress: false,
      crawlerSchedulersStopping: true,
      coordinateCrawlsAcrossInstances: true,
      ensureFullCrawlIntentLock,
      lastResult,
    });

    await expect(ctx.crawlAllAgents([])).resolves.toBe(lastResult);
    expect(ensureFullCrawlIntentLock).not.toHaveBeenCalled();
  });

  it('retains full-crawl intent across an execution-lock timeout retry', async () => {
    const ctx = Object.create((CrawlerService as any).prototype);
    const releaseIntent = vi.fn().mockResolvedValue(undefined);
    const intentLock = { isValid: () => true, release: releaseIntent };
    const lastResult = { marker: 'last-result' };
    Object.assign(ctx, {
      crawling: false,
      fullCrawlCoordinationInProgress: false,
      crawlerSchedulersStopping: false,
      coordinateCrawlsAcrossInstances: true,
      fullCrawlIntentLock: intentLock,
      fullCrawlLockRetryTimer: null,
      tryAcquireCrawlExecutionLock: vi.fn().mockResolvedValue(null),
      lastResult,
    });

    await expect(ctx.crawlAllAgents([])).resolves.toBe(lastResult);

    expect(ctx.fullCrawlIntentLock).toBe(intentLock);
    expect(releaseIntent).not.toHaveBeenCalled();
    expect(ctx.fullCrawlLockRetryTimer).not.toBeNull();
    clearTimeout(ctx.fullCrawlLockRetryTimer);
    ctx.fullCrawlLockRetryTimer = null;
    await ctx.releaseFullCrawlIntentLock();
  });

  it('retains full-crawl intent when an execution retry timer already exists', async () => {
    const ctx = Object.create((CrawlerService as any).prototype);
    const releaseIntent = vi.fn().mockResolvedValue(undefined);
    const intentLock = { isValid: () => true, release: releaseIntent };
    const existingRetryTimer = setTimeout(() => undefined, 60_000);
    Object.assign(ctx, {
      crawling: false,
      fullCrawlCoordinationInProgress: false,
      crawlerSchedulersStopping: false,
      coordinateCrawlsAcrossInstances: true,
      fullCrawlIntentLock: intentLock,
      fullCrawlLockRetryTimer: existingRetryTimer,
      tryAcquireCrawlExecutionLock: vi.fn().mockResolvedValue(null),
    });

    await ctx.crawlAllAgents([]);

    expect(ctx.fullCrawlIntentLock).toBe(intentLock);
    expect(ctx.fullCrawlLockRetryTimer).toBe(existingRetryTimer);
    expect(releaseIntent).not.toHaveBeenCalled();
    clearTimeout(existingRetryTimer);
    ctx.fullCrawlLockRetryTimer = null;
    await ctx.releaseFullCrawlIntentLock();
  });

  it('aborts a full crawl before persistence when its execution lock is lost', async () => {
    const ctx = Object.create((CrawlerService as any).prototype);
    const release = vi.fn().mockResolvedValue(undefined);
    const releaseIntent = vi.fn().mockResolvedValue(undefined);
    const populateFederatedIndex = vi.fn();
    Object.assign(ctx, {
      crawling: false,
      fullCrawlLockRetryTimer: null,
      coordinateCrawlsAcrossInstances: true,
      fullCrawlIntentLock: {
        isValid: () => true,
        release: releaseIntent,
      },
      tryAcquireCrawlExecutionLock: vi.fn().mockResolvedValue({
        isValid: () => false,
        release,
      }),
      getPausedAgentUrls: vi.fn().mockResolvedValue(new Set()),
      federatedIndex: {
        listDiscoveredAgents: vi.fn().mockResolvedValue([]),
        getSalesCandidatesForProbe: vi.fn().mockResolvedValue([]),
      },
      crawler: { crawlAgents: vi.fn().mockResolvedValue({}) },
      populateFederatedIndex,
    });

    await expect(ctx.crawlAllAgents([])).rejects.toMatchObject({
      code: 'crawl_execution_lock_lost',
    });
    expect(populateFederatedIndex).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(releaseIntent).not.toHaveBeenCalled();
    if (ctx.fullCrawlLockRetryTimer) clearTimeout(ctx.fullCrawlLockRetryTimer);
    await ctx.releaseFullCrawlIntentLock();
    expect(releaseIntent).toHaveBeenCalledOnce();
  });

  it('does not write catalog state when another crawl owns the domain lock', async () => {
    const ctx = Object.create((CrawlerService as any).prototype);
    const validateDomain = vi.fn();
    Object.assign(ctx, {
      coordinateCrawlsAcrossInstances: true,
      tryAcquireCrawlExecutionLock: vi.fn().mockResolvedValue(null),
      adAgentsManager: { validateDomain },
    });

    await expect(ctx.crawlSingleDomainForCatalog('publisher.example')).resolves.toBe(false);
    expect(validateDomain).not.toHaveBeenCalled();
  });

  it('forcibly closes a dedicated lock connection when unlock never resolves', async () => {
    vi.useFakeTimers();
    try {
      const ctx = Object.create((CrawlerService as any).prototype);
      const destroy = vi.fn();
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: [{ acquired: true }] })
        .mockResolvedValueOnce({ rows: [{ acquired: true }] })
        .mockResolvedValueOnce({ rows: [{ acquired: true }] })
        .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock_shared: true }] })
        .mockImplementationOnce(() => new Promise(() => undefined));
      const client = {
        query,
        on: vi.fn(),
        off: vi.fn(),
        end: vi.fn().mockResolvedValue(undefined),
        connection: { stream: { destroyed: false, destroy } },
      };
      Object.assign(ctx, {
        crawlLockClientFactory: vi.fn().mockResolvedValue(client),
      });

      const lock = await ctx.tryAcquireCrawlExecutionLock('publisher.example');
      expect(lock).not.toBeNull();

      const release = lock.release();
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(release).resolves.toBeUndefined();
      expect(destroy).toHaveBeenCalledOnce();
      expect(client.end).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rebuilds profiles for agents removed from the prior manifest', async () => {
    const ctx = await makeCrawlerContext({
      existingAuthorizations: [
        { agent_url: 'https://old-agent.example/mcp/', source: 'adagents_json' },
        { agent_url: 'https://claimed-agent.example/mcp', source: 'agent_claim' },
      ],
      authorizedAgents: [{ url: 'https://new-agent.example/mcp/' }],
    });

    await ctx.crawlSingleDomain('publisher.example');

    expect(ctx.buildInventoryProfiles).toHaveBeenCalledWith({
      agentUrls: ['https://old-agent.example/mcp', 'https://new-agent.example/mcp'],
      deleteStale: false,
    });
  });

  it('rebuilds prior agents when a manifest becomes empty', async () => {
    const ctx = await makeCrawlerContext({
      existingAuthorizations: [
        { agent_url: 'https://old-agent.example/mcp/', source: 'adagents_json' },
      ],
      authorizedAgents: [],
    });

    await ctx.crawlSingleDomain('publisher.example');

    expect(ctx.buildInventoryProfiles).toHaveBeenCalledWith({
      agentUrls: ['https://old-agent.example/mcp'],
      deleteStale: false,
    });
  });

  it('manual adagents revalidation persists a successful verdict and refreshed authorizations', async () => {
    const proto = (CrawlerService as any).prototype;
    const ctx = Object.create(proto);

    Object.assign(ctx, {
      adAgentsManager: {
        validateDomain: vi.fn().mockResolvedValue({
          valid: true,
          errors: [],
          warnings: [],
          domain: 'publisher.example',
          url: 'https://publisher.example/.well-known/adagents.json',
          raw_data: {
            authorized_agents: [{ url: 'https://new-agent.example/mcp/', authorized_for: 'display' }],
            properties: [{ property_id: 'site', property_type: 'website', name: 'Site' }],
          },
          status_code: 200,
          response_bytes: 256,
          resolved_url: 'https://publisher.example/.well-known/adagents.json',
          discovery_method: 'direct',
        }),
      },
      federatedIndex: {
        getAuthorizationsForDomain: vi.fn().mockResolvedValue([
          { agent_url: 'https://old-agent.example/mcp/', source: 'adagents_json' },
        ]),
        markPublisherHasValidAdagents: vi.fn().mockResolvedValue(undefined),
        recordAgentFromAdagentsJson: vi.fn().mockResolvedValue(undefined),
        reconcileAdagentsAuthorizations: vi.fn().mockResolvedValue(undefined),
      },
      publisherDb: {
        recordAdagentsValidationFailure: vi.fn().mockResolvedValue(undefined),
      },
      cacheAdagentsManifest: vi.fn().mockResolvedValue(true),
      recordPropertiesForAgent: vi.fn().mockResolvedValue(undefined),
      fanOutPublisherPropertiesAuthorizations: vi.fn().mockResolvedValue(undefined),
      reconcileLegacyAdagentsAgents: vi.fn().mockResolvedValue(undefined),
      scanBrandForDomain: vi.fn().mockResolvedValue(undefined),
      buildInventoryProfiles: vi.fn().mockResolvedValue(new Map()),
    });

    const result = await ctx.revalidatePublisherAdagents('publisher.example', { force: true });

    expect(result).toMatchObject({
      domain: 'publisher.example',
      adagents_valid: true,
      properties_count: 1,
      authorized_agents_count: 1,
      status_code: 200,
    });
    expect(ctx.cacheAdagentsManifest).toHaveBeenCalledWith(
      'publisher.example',
      expect.objectContaining({ authorized_agents: expect.any(Array) }),
      expect.objectContaining({ statusCode: 200, discoveryMethod: 'direct' }),
    );
    expect(ctx.federatedIndex.markPublisherHasValidAdagents).toHaveBeenCalledWith('publisher.example');
    expect(ctx.federatedIndex.recordAgentFromAdagentsJson).toHaveBeenCalledWith(
      'https://new-agent.example/mcp/',
      'publisher.example',
      'display',
      undefined,
    );
    expect(ctx.buildInventoryProfiles).toHaveBeenCalledWith({
      agentUrls: ['https://old-agent.example/mcp', 'https://new-agent.example/mcp'],
      deleteStale: false,
    });
  });

  it('manual adagents revalidation returns warnings for a valid manifest', async () => {
    const proto = (CrawlerService as any).prototype;
    const ctx = Object.create(proto);

    Object.assign(ctx, {
      adAgentsManager: {
        validateDomain: vi.fn().mockResolvedValue({
          valid: true,
          errors: [],
          warnings: [{ field: '$schema', message: 'Missing schema declaration' }],
          domain: 'publisher.example',
          url: 'https://publisher.example/.well-known/adagents.json',
          raw_data: {
            authorized_agents: [{ url: 'https://new-agent.example/mcp/' }],
            properties: [],
          },
          status_code: 200,
          response_bytes: 128,
          resolved_url: 'https://publisher.example/.well-known/adagents.json',
          discovery_method: 'direct',
        }),
      },
      federatedIndex: {
        getAuthorizationsForDomain: vi.fn().mockResolvedValue([]),
        markPublisherHasValidAdagents: vi.fn().mockResolvedValue(undefined),
        recordAgentFromAdagentsJson: vi.fn().mockResolvedValue(undefined),
        reconcileAdagentsAuthorizations: vi.fn().mockResolvedValue(undefined),
      },
      publisherDb: {},
      cacheAdagentsManifest: vi.fn().mockResolvedValue(true),
      recordPropertiesForAgent: vi.fn().mockResolvedValue(undefined),
      fanOutPublisherPropertiesAuthorizations: vi.fn().mockResolvedValue(undefined),
      reconcileLegacyAdagentsAgents: vi.fn().mockResolvedValue(undefined),
      scanBrandForDomain: vi.fn().mockResolvedValue(undefined),
      buildInventoryProfiles: vi.fn().mockResolvedValue(new Map()),
    });

    const result = await ctx.revalidatePublisherAdagents('publisher.example');

    expect(result).toMatchObject({
      domain: 'publisher.example',
      adagents_valid: true,
      issues: {
        errors: [],
        warnings: [{ field: '$schema', message: 'Missing schema declaration' }],
      },
    });
  });

  it('manual adagents revalidation persists an invalid verdict and retires stale authorizations', async () => {
    const proto = (CrawlerService as any).prototype;
    const ctx = Object.create(proto);

    Object.assign(ctx, {
      adAgentsManager: {
        validateDomain: vi.fn().mockResolvedValue({
          valid: false,
          errors: [{ field: 'http_status', message: 'File not found', severity: 'error' }],
          warnings: [],
          domain: 'publisher.example',
          url: 'https://publisher.example/.well-known/adagents.json',
          status_code: 404,
          response_bytes: 32,
          resolved_url: 'https://publisher.example/.well-known/adagents.json',
          discovery_method: 'direct',
        }),
      },
      federatedIndex: {
        getAuthorizationsForDomain: vi.fn().mockResolvedValue([
          { agent_url: 'https://old-agent.example/mcp/', source: 'adagents_json' },
          { agent_url: 'https://claimed-agent.example/mcp', source: 'agent_claim' },
        ]),
      },
      publisherDb: {
        recordAdagentsValidationFailure: vi.fn().mockResolvedValue(undefined),
      },
      scanBrandForDomain: vi.fn().mockResolvedValue(undefined),
      buildInventoryProfiles: vi.fn().mockResolvedValue(new Map()),
    });

    const result = await ctx.revalidatePublisherAdagents('publisher.example');

    expect(result).toMatchObject({
      domain: 'publisher.example',
      adagents_valid: false,
      error: 'File not found',
      properties_count: 0,
      authorized_agents_count: 0,
      status_code: 404,
    });
    expect(ctx.publisherDb.recordAdagentsValidationFailure).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'publisher.example',
      statusCode: 404,
      error: 'File not found',
      issues: {
        errors: [{ field: 'http_status', message: 'File not found', severity: 'error' }],
        warnings: [],
      },
    }));
    expect(ctx.buildInventoryProfiles).toHaveBeenCalledWith({
      agentUrls: ['https://old-agent.example/mcp'],
      deleteStale: false,
    });
  });

  it('manual adagents revalidation preserves cached state on transient fetch failures', async () => {
    const proto = (CrawlerService as any).prototype;
    const ctx = Object.create(proto);

    Object.assign(ctx, {
      adAgentsManager: {
        validateDomain: vi.fn().mockResolvedValue({
          valid: false,
          errors: [{ field: 'http_status', message: 'HTTP 503 error fetching https://publisher.example/.well-known/adagents.json', severity: 'error' }],
          warnings: [],
          domain: 'publisher.example',
          url: 'https://publisher.example/.well-known/adagents.json',
          status_code: 503,
          response_bytes: 18,
          resolved_url: 'https://publisher.example/.well-known/adagents.json',
          discovery_method: 'direct',
        }),
      },
      federatedIndex: {
        getAuthorizationsForDomain: vi.fn().mockResolvedValue([
          { agent_url: 'https://old-agent.example/mcp/', source: 'adagents_json' },
        ]),
        markPublisherHasInvalidAdagents: vi.fn().mockResolvedValue(undefined),
        reconcileAdagentsAuthorizations: vi.fn().mockResolvedValue(undefined),
      },
      publisherDb: {
        recordAdagentsValidationFailure: vi.fn().mockResolvedValue(undefined),
        recordFailedAdagentsFetch: vi.fn().mockResolvedValue(undefined),
      },
      scanBrandForDomain: vi.fn().mockResolvedValue(undefined),
      buildInventoryProfiles: vi.fn().mockResolvedValue(new Map()),
    });

    const result = await ctx.revalidatePublisherAdagents('publisher.example');

    expect(result).toMatchObject({
      domain: 'publisher.example',
      adagents_valid: false,
      status_code: 503,
      error: 'HTTP 503 error fetching https://publisher.example/.well-known/adagents.json',
    });
    expect(ctx.publisherDb.recordFailedAdagentsFetch).toHaveBeenCalledWith({
      domain: 'publisher.example',
      statusCode: 503,
      responseBytes: 18,
      resolvedUrl: 'https://publisher.example/.well-known/adagents.json',
    });
    expect(ctx.publisherDb.recordAdagentsValidationFailure).not.toHaveBeenCalled();
    expect(ctx.federatedIndex.markPublisherHasInvalidAdagents).not.toHaveBeenCalled();
    expect(ctx.federatedIndex.reconcileAdagentsAuthorizations).not.toHaveBeenCalled();
    expect(ctx.buildInventoryProfiles).not.toHaveBeenCalled();
  });

  it('manual adagents revalidation preserves cached state on access-denied origin responses', async () => {
    const proto = (CrawlerService as any).prototype;
    const ctx = Object.create(proto);

    Object.assign(ctx, {
      adAgentsManager: {
        validateDomain: vi.fn().mockResolvedValue({
          valid: false,
          errors: [{ field: 'http_status', message: 'HTTP 403 error fetching https://publisher.example/.well-known/adagents.json', severity: 'error' }],
          warnings: [],
          domain: 'publisher.example',
          url: 'https://publisher.example/.well-known/adagents.json',
          status_code: 403,
          response_bytes: 42,
          resolved_url: 'https://publisher.example/.well-known/adagents.json',
          discovery_method: 'direct',
        }),
      },
      federatedIndex: {
        getAuthorizationsForDomain: vi.fn().mockResolvedValue([
          { agent_url: 'https://old-agent.example/mcp/', source: 'adagents_json' },
        ]),
        markPublisherHasInvalidAdagents: vi.fn().mockResolvedValue(undefined),
        reconcileAdagentsAuthorizations: vi.fn().mockResolvedValue(undefined),
      },
      publisherDb: {
        recordAdagentsValidationFailure: vi.fn().mockResolvedValue(undefined),
        recordFailedAdagentsFetch: vi.fn().mockResolvedValue(undefined),
      },
      scanBrandForDomain: vi.fn().mockResolvedValue(undefined),
      buildInventoryProfiles: vi.fn().mockResolvedValue(new Map()),
    });

    const result = await ctx.revalidatePublisherAdagents('publisher.example');

    expect(result).toMatchObject({
      domain: 'publisher.example',
      adagents_valid: false,
      status_code: 403,
      error: 'HTTP 403 error fetching https://publisher.example/.well-known/adagents.json',
    });
    expect(ctx.publisherDb.recordFailedAdagentsFetch).toHaveBeenCalledWith({
      domain: 'publisher.example',
      statusCode: 403,
      responseBytes: 42,
      resolvedUrl: 'https://publisher.example/.well-known/adagents.json',
    });
    expect(ctx.publisherDb.recordAdagentsValidationFailure).not.toHaveBeenCalled();
    expect(ctx.federatedIndex.markPublisherHasInvalidAdagents).not.toHaveBeenCalled();
    expect(ctx.federatedIndex.reconcileAdagentsAuthorizations).not.toHaveBeenCalled();
    expect(ctx.buildInventoryProfiles).not.toHaveBeenCalled();
  });

  it('manual adagents revalidation preserves cached state on unparseable 200 responses', async () => {
    const proto = (CrawlerService as any).prototype;
    const ctx = Object.create(proto);

    Object.assign(ctx, {
      adAgentsManager: {
        validateDomain: vi.fn().mockResolvedValue({
          valid: false,
          errors: [{ field: 'json', message: 'Invalid JSON response from https://publisher.example/.well-known/adagents.json', severity: 'error' }],
          warnings: [],
          domain: 'publisher.example',
          url: 'https://publisher.example/.well-known/adagents.json',
          status_code: 200,
          response_bytes: 4096,
          resolved_url: 'https://publisher.example/.well-known/adagents.json',
          discovery_method: 'direct',
        }),
      },
      federatedIndex: {
        getAuthorizationsForDomain: vi.fn().mockResolvedValue([
          { agent_url: 'https://old-agent.example/mcp/', source: 'adagents_json' },
        ]),
        markPublisherHasInvalidAdagents: vi.fn().mockResolvedValue(undefined),
        reconcileAdagentsAuthorizations: vi.fn().mockResolvedValue(undefined),
      },
      publisherDb: {
        recordAdagentsValidationFailure: vi.fn().mockResolvedValue(undefined),
        recordFailedAdagentsFetch: vi.fn().mockResolvedValue(undefined),
      },
      scanBrandForDomain: vi.fn().mockResolvedValue(undefined),
      buildInventoryProfiles: vi.fn().mockResolvedValue(new Map()),
    });

    const result = await ctx.revalidatePublisherAdagents('publisher.example');

    expect(result).toMatchObject({
      domain: 'publisher.example',
      adagents_valid: false,
      status_code: 200,
      error: 'Invalid JSON response from https://publisher.example/.well-known/adagents.json',
    });
    expect(ctx.publisherDb.recordFailedAdagentsFetch).toHaveBeenCalledWith({
      domain: 'publisher.example',
      statusCode: 200,
      responseBytes: 4096,
      resolvedUrl: 'https://publisher.example/.well-known/adagents.json',
    });
    expect(ctx.publisherDb.recordAdagentsValidationFailure).not.toHaveBeenCalled();
    expect(ctx.federatedIndex.markPublisherHasInvalidAdagents).not.toHaveBeenCalled();
    expect(ctx.federatedIndex.reconcileAdagentsAuthorizations).not.toHaveBeenCalled();
    expect(ctx.buildInventoryProfiles).not.toHaveBeenCalled();
  });

  it('manual adagents revalidation preserves cached state when authoritative_location fetch is inconclusive', async () => {
    const proto = (CrawlerService as any).prototype;
    const ctx = Object.create(proto);

    Object.assign(ctx, {
      adAgentsManager: {
        validateDomain: vi.fn().mockResolvedValue({
          valid: false,
          errors: [{ field: 'authoritative_location', message: 'Failed to fetch authoritative file: socket hang up', severity: 'error' }],
          warnings: [],
          domain: 'publisher.example',
          url: 'https://publisher.example/.well-known/adagents.json',
          status_code: 200,
          response_bytes: 96,
          resolved_url: 'https://cdn.publisher.example/adagents.json',
          discovery_method: 'direct',
        }),
      },
      federatedIndex: {
        getAuthorizationsForDomain: vi.fn().mockResolvedValue([
          { agent_url: 'https://old-agent.example/mcp/', source: 'adagents_json' },
        ]),
        markPublisherHasInvalidAdagents: vi.fn().mockResolvedValue(undefined),
        reconcileAdagentsAuthorizations: vi.fn().mockResolvedValue(undefined),
      },
      publisherDb: {
        recordAdagentsValidationFailure: vi.fn().mockResolvedValue(undefined),
        recordFailedAdagentsFetch: vi.fn().mockResolvedValue(undefined),
      },
      scanBrandForDomain: vi.fn().mockResolvedValue(undefined),
      buildInventoryProfiles: vi.fn().mockResolvedValue(new Map()),
    });

    const result = await ctx.revalidatePublisherAdagents('publisher.example');

    expect(result).toMatchObject({
      domain: 'publisher.example',
      adagents_valid: false,
      status_code: 200,
      error: 'Failed to fetch authoritative file: socket hang up',
    });
    expect(ctx.publisherDb.recordFailedAdagentsFetch).toHaveBeenCalledWith({
      domain: 'publisher.example',
      statusCode: 200,
      responseBytes: 96,
      resolvedUrl: 'https://cdn.publisher.example/adagents.json',
    });
    expect(ctx.publisherDb.recordAdagentsValidationFailure).not.toHaveBeenCalled();
    expect(ctx.federatedIndex.markPublisherHasInvalidAdagents).not.toHaveBeenCalled();
    expect(ctx.federatedIndex.reconcileAdagentsAuthorizations).not.toHaveBeenCalled();
    expect(ctx.buildInventoryProfiles).not.toHaveBeenCalled();
  });

  it('manual adagents revalidation persists schema-invalid 200 responses as invalid', async () => {
    const proto = (CrawlerService as any).prototype;
    const ctx = Object.create(proto);

    Object.assign(ctx, {
      adAgentsManager: {
        validateDomain: vi.fn().mockResolvedValue({
          valid: false,
          errors: [{ field: 'authorized_agents', message: 'authorized_agents must be an array', severity: 'error' }],
          warnings: [],
          domain: 'publisher.example',
          url: 'https://publisher.example/.well-known/adagents.json',
          raw_data: { authorized_agents: 'not-an-array' },
          status_code: 200,
          response_bytes: 96,
          resolved_url: 'https://publisher.example/.well-known/adagents.json',
          discovery_method: 'direct',
        }),
      },
      federatedIndex: {
        getAuthorizationsForDomain: vi.fn().mockResolvedValue([]),
      },
      publisherDb: {
        recordAdagentsValidationFailure: vi.fn().mockResolvedValue(undefined),
      },
      scanBrandForDomain: vi.fn().mockResolvedValue(undefined),
      buildInventoryProfiles: vi.fn().mockResolvedValue(new Map()),
    });

    const result = await ctx.revalidatePublisherAdagents('publisher.example');

    expect(result).toMatchObject({
      domain: 'publisher.example',
      adagents_valid: false,
      error: 'authorized_agents must be an array',
      status_code: 200,
      issues: {
        errors: [{ field: 'authorized_agents', message: 'authorized_agents must be an array', severity: 'error' }],
        warnings: [],
      },
    });
    expect(ctx.publisherDb.recordAdagentsValidationFailure).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'publisher.example',
      statusCode: 200,
      error: 'authorized_agents must be an array',
    }));
  });
});
