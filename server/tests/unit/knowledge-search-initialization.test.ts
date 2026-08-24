import { beforeEach, describe, expect, it, vi } from 'vitest';

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
