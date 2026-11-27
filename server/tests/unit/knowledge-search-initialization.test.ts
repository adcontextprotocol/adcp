import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  docsReady: false,
  externalReady: false,
  initializeDocsIndex: vi.fn(),
  initializeExternalRepos: vi.fn(),
}));

vi.mock('../../src/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../src/addie/mcp/docs-indexer.js', () => ({
  initializeDocsIndex: mocks.initializeDocsIndex,
  isDocsIndexReady: () => mocks.docsReady,
  searchDocs: vi.fn(() => []),
  getDocById: vi.fn(() => null),
  getDocCategories: vi.fn(() => []),
  getDocCount: vi.fn(() => 0),
  getSupportedDocsVersions: vi.fn(() => []),
  resolveDocsVersion: vi.fn(() => null),
  formatDocsVersion: vi.fn(() => ''),
}));

vi.mock('../../src/addie/mcp/external-repos.js', () => ({
  initializeExternalRepos: mocks.initializeExternalRepos,
  isExternalReposReady: () => mocks.externalReady,
  searchExternalDocs: vi.fn(() => []),
  searchExternalHeadings: vi.fn(() => []),
  getExternalRepoStats: vi.fn(() => []),
  getExternalHeadingCount: vi.fn(() => 0),
  getConfiguredRepos: vi.fn(() => []),
}));

vi.mock('../../src/db/addie-db.js', () => ({
  AddieDatabase: class {},
}));

vi.mock('../../src/addie/services/content-curator.js', () => ({
  queueWebSearchResult: vi.fn(),
}));

vi.mock('../../src/slack/client.js', () => ({
  findChannelWithAccess: vi.fn(),
  getAccessiblePrivateChannelIds: vi.fn(async () => []),
}));

describe('knowledge search initialization', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.docsReady = false;
    mocks.externalReady = false;
    mocks.initializeDocsIndex.mockReset();
    mocks.initializeExternalRepos.mockReset();
  });

  afterEach(async () => {
    const { stopKnowledgeSearchRetry } = await import('../../src/addie/mcp/knowledge-search.js');
    stopKnowledgeSearchRetry();
    vi.useRealTimers();
  });

  it('retries a failed docs index on its own, so readiness recovers without another caller', async () => {
    vi.useFakeTimers();
    const { initializeKnowledgeSearch, isKnowledgeReady, getKnowledgeReadiness } = await import(
      '../../src/addie/mcp/knowledge-search.js'
    );
    mocks.initializeDocsIndex
      .mockRejectedValueOnce(new Error('docs index failed at boot'))
      .mockRejectedValueOnce(new Error('docs index failed again'))
      .mockImplementationOnce(async () => {
        mocks.docsReady = true;
      });
    mocks.initializeExternalRepos.mockImplementation(async () => {
      mocks.externalReady = true;
    });

    await initializeKnowledgeSearch();
    expect(isKnowledgeReady()).toBe(false);
    expect(getKnowledgeReadiness()).toMatchObject({ ready: false, docs: false, externalRepos: true, retryAttempts: 1 });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.initializeDocsIndex).toHaveBeenCalledTimes(2);
    expect(isKnowledgeReady()).toBe(false);

    // The second retry waits longer.
    await vi.advanceTimersByTimeAsync(14_999);
    expect(mocks.initializeDocsIndex).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.initializeDocsIndex).toHaveBeenCalledTimes(3);
    expect(isKnowledgeReady()).toBe(true);
    expect(getKnowledgeReadiness()).toMatchObject({ ready: true, retryAttempts: 0 });

    // Nothing further is scheduled once ready.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.initializeDocsIndex).toHaveBeenCalledTimes(3);
  });

  it('deduplicates concurrent calls and retries an incomplete initialization', async () => {
    const { initializeKnowledgeSearch, isKnowledgeReady } = await import(
      '../../src/addie/mcp/knowledge-search.js'
    );
    let releaseDocs!: () => void;
    const docsStarted = new Promise<void>((resolve) => {
      releaseDocs = resolve;
    });
    mocks.initializeDocsIndex
      .mockImplementationOnce(async () => {
        await docsStarted;
        throw new Error('transient docs failure');
      })
      .mockImplementationOnce(async () => {
        mocks.docsReady = true;
      });
    mocks.initializeExternalRepos.mockImplementation(async () => {
      mocks.externalReady = true;
    });

    const first = initializeKnowledgeSearch();
    const second = initializeKnowledgeSearch();

    expect(second).toBe(first);
    expect(mocks.initializeDocsIndex).toHaveBeenCalledTimes(1);
    releaseDocs();
    await Promise.all([first, second]);
    expect(isKnowledgeReady()).toBe(false);

    await initializeKnowledgeSearch();
    expect(mocks.initializeDocsIndex).toHaveBeenCalledTimes(2);
    expect(isKnowledgeReady()).toBe(true);
  });

  it('preserves a ready docs index while retrying external repositories', async () => {
    const { initializeKnowledgeSearch, isKnowledgeReady } = await import(
      '../../src/addie/mcp/knowledge-search.js'
    );
    mocks.initializeDocsIndex.mockImplementation(async () => {
      mocks.docsReady = true;
    });
    mocks.initializeExternalRepos
      .mockRejectedValueOnce(new Error('transient external failure'))
      .mockImplementationOnce(async () => {
        mocks.externalReady = true;
      });

    await initializeKnowledgeSearch();
    expect(isKnowledgeReady()).toBe(false);

    await initializeKnowledgeSearch();
    expect(mocks.initializeDocsIndex).toHaveBeenCalledTimes(1);
    expect(mocks.initializeExternalRepos).toHaveBeenCalledTimes(2);
    expect(isKnowledgeReady()).toBe(true);
  });
});
