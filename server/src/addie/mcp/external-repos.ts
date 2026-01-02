/**
 * External Repository Indexer for Addie
 *
 * Clones/pulls external GitHub repositories at startup and indexes their
 * documentation (README, docs/, etc.) so Addie can answer questions about them.
 *
 * Repos are cached locally in a .addie-repos directory and updated on each startup.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { logger } from '../../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ExternalRepo {
  /** Unique identifier for this repo */
  id: string;
  /** GitHub repository URL */
  url: string;
  /** Human-readable name */
  name: string;
  /** Description of what this repo contains */
  description: string;
  /** Patterns to index (relative to repo root) */
  indexPatterns?: string[];
  /** Branch to clone (defaults to main) */
  branch?: string;
}

export interface IndexedExternalDoc {
  id: string;
  repoId: string;
  repoName: string;
  title: string;
  path: string;
  content: string;
  sourceUrl: string;
}

/**
 * External repositories to index.
 * Add new repos here to make them available to Addie.
 */
const EXTERNAL_REPOS: ExternalRepo[] = [
  {
    id: 'salesagent',
    url: 'https://github.com/adcontextprotocol/salesagent',
    name: 'AdCP Sales Agent',
    description: 'Reference implementation of an AdCP sales agent for publishers',
    indexPatterns: ['README.md', 'docs/**/*.md', 'CHANGELOG.md'],
    branch: 'main',
  },
  {
    id: 'adcp-client',
    url: 'https://github.com/adcontextprotocol/adcp-client',
    name: 'AdCP JavaScript Client',
    description: 'Official JavaScript/TypeScript client library for AdCP',
    indexPatterns: ['README.md', 'docs/**/*.md', 'CHANGELOG.md'],
    branch: 'main',
  },
  {
    id: 'adcp-client-python',
    url: 'https://github.com/adcontextprotocol/adcp-client-python',
    name: 'AdCP Python Client',
    description: 'Official Python client library for AdCP',
    indexPatterns: ['README.md', 'docs/**/*.md', 'CHANGELOG.md'],
    branch: 'main',
  },
];

// In-memory index of external docs
let externalDocsIndex: IndexedExternalDoc[] = [];
let initialized = false;

// Directory where repos are cached
let reposDir: string;

/**
 * Get the repos cache directory
 */
function getReposDir(): string {
  if (reposDir) return reposDir;

  // Try to find a suitable location
  const possiblePaths = [
    // From server/src/addie/mcp/ to project root
    path.resolve(__dirname, '../../../../.addie-repos'),
    // From dist/ to project root
    path.resolve(__dirname, '../../../.addie-repos'),
    // Docker location
    '/app/.addie-repos',
    // Fallback to temp
    path.join(process.env.TMPDIR || '/tmp', 'addie-repos'),
  ];

  // Use the first path that exists or can be created
  for (const p of possiblePaths) {
    try {
      if (!fs.existsSync(p)) {
        fs.mkdirSync(p, { recursive: true });
      }
      reposDir = p;
      return reposDir;
    } catch {
      continue;
    }
  }

  // Final fallback
  reposDir = possiblePaths[possiblePaths.length - 1];
  fs.mkdirSync(reposDir, { recursive: true });
  return reposDir;
}

/**
 * Clone or update a repository
 */
function syncRepo(repo: ExternalRepo): string | null {
  const repoPath = path.join(getReposDir(), repo.id);
  const branch = repo.branch || 'main';

  try {
    if (fs.existsSync(path.join(repoPath, '.git'))) {
      // Repo exists, pull latest
      logger.debug({ repoId: repo.id }, 'Addie External Repos: Pulling latest');
      execSync(`git -C "${repoPath}" fetch origin ${branch} --depth=1 2>/dev/null`, {
        timeout: 30000,
        stdio: 'pipe',
      });
      execSync(`git -C "${repoPath}" reset --hard origin/${branch} 2>/dev/null`, {
        timeout: 10000,
        stdio: 'pipe',
      });
    } else {
      // Clone fresh (shallow clone for speed)
      logger.info({ repoId: repo.id, url: repo.url }, 'Addie External Repos: Cloning');
      execSync(
        `git clone --depth=1 --branch ${branch} "${repo.url}" "${repoPath}" 2>/dev/null`,
        {
          timeout: 60000,
          stdio: 'pipe',
        }
      );
    }
    return repoPath;
  } catch (error) {
    logger.warn(
      { repoId: repo.id, error: error instanceof Error ? error.message : 'Unknown error' },
      'Addie External Repos: Failed to sync repo'
    );
    // If we have an existing clone, use it even if pull failed
    if (fs.existsSync(path.join(repoPath, '.git'))) {
      logger.info({ repoId: repo.id }, 'Addie External Repos: Using cached version');
      return repoPath;
    }
    return null;
  }
}

/**
 * Find files matching glob patterns in a directory
 * Simple implementation without glob library dependency
 */
function findMatchingFiles(baseDir: string, patterns: string[]): string[] {
  const files: string[] = [];

  for (const pattern of patterns) {
    if (pattern.includes('**')) {
      // Recursive pattern like 'docs/**/*.md'
      const [prefix, suffix] = pattern.split('**');
      const searchDir = path.join(baseDir, prefix.replace(/\/$/, ''));
      if (fs.existsSync(searchDir)) {
        findFilesRecursive(searchDir, suffix.replace(/^\//, ''), files);
      }
    } else if (pattern.includes('*')) {
      // Simple glob like '*.md'
      const dir = path.dirname(pattern);
      const filePattern = path.basename(pattern);
      const searchDir = dir === '.' ? baseDir : path.join(baseDir, dir);
      if (fs.existsSync(searchDir)) {
        const entries = fs.readdirSync(searchDir);
        for (const entry of entries) {
          if (matchesPattern(entry, filePattern)) {
            files.push(path.join(searchDir, entry));
          }
        }
      }
    } else {
      // Exact file like 'README.md'
      const filePath = path.join(baseDir, pattern);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        files.push(filePath);
      }
    }
  }

  return files;
}

function findFilesRecursive(dir: string, suffix: string, files: string[]): void {
  if (!fs.existsSync(dir)) return;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
        findFilesRecursive(fullPath, suffix, files);
      }
    } else if (entry.isFile()) {
      if (matchesPattern(entry.name, suffix)) {
        files.push(fullPath);
      }
    }
  }
}

function matchesPattern(filename: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.startsWith('*.')) {
    return filename.endsWith(pattern.slice(1));
  }
  return filename === pattern;
}

/**
 * Extract title from markdown content
 */
function extractTitle(content: string, filename: string): string {
  // Try frontmatter
  const frontmatterMatch = content.match(/^---\s*\n[\s\S]*?title:\s*["']?([^"'\n]+)["']?\s*\n[\s\S]*?---/);
  if (frontmatterMatch) {
    return frontmatterMatch[1].trim();
  }

  // Try first heading
  const headingMatch = content.match(/^#\s+(.+)$/m);
  if (headingMatch) {
    return headingMatch[1].trim();
  }

  // Fall back to filename
  return filename
    .replace(/\.(md|mdx)$/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Clean markdown content
 */
function cleanContent(content: string): string {
  // Remove frontmatter
  content = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '');

  // Remove import statements
  content = content.replace(/^import\s+.*$/gm, '');

  // Clean up extra whitespace
  content = content.replace(/\n{3,}/g, '\n\n').trim();

  return content;
}

/**
 * Build GitHub source URL for a file
 */
function buildSourceUrl(repo: ExternalRepo, relativePath: string): string {
  const branch = repo.branch || 'main';
  // Convert SSH URL to HTTPS if needed
  const httpsUrl = repo.url
    .replace('git@github.com:', 'https://github.com/')
    .replace(/\.git$/, '');
  return `${httpsUrl}/blob/${branch}/${relativePath}`;
}

/**
 * Index a single repository
 */
function indexRepo(repo: ExternalRepo, repoPath: string): IndexedExternalDoc[] {
  const indexed: IndexedExternalDoc[] = [];
  const patterns = repo.indexPatterns || ['README.md', 'docs/**/*.md'];

  const files = findMatchingFiles(repoPath, patterns);

  for (const filePath of files) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const relativePath = path.relative(repoPath, filePath);
      const filename = path.basename(filePath);
      const title = extractTitle(content, filename);
      const cleanedContent = cleanContent(content);

      // Skip empty or very short files
      if (cleanedContent.length < 50) {
        continue;
      }

      indexed.push({
        id: `external:${repo.id}:${relativePath.replace(/\\/g, '/').replace(/\.(md|mdx)$/, '')}`,
        repoId: repo.id,
        repoName: repo.name,
        title,
        path: relativePath,
        content: cleanedContent,
        sourceUrl: buildSourceUrl(repo, relativePath),
      });
    } catch (error) {
      logger.warn({ repoId: repo.id, filePath, error }, 'Addie External Repos: Failed to index file');
    }
  }

  return indexed;
}

/**
 * Initialize the external repos indexer
 * Call this at startup to clone/update repos and build the index
 */
export async function initializeExternalRepos(): Promise<void> {
  if (initialized) {
    logger.debug('Addie External Repos: Already initialized');
    return;
  }

  // Check if git is available
  try {
    execSync('git --version', { stdio: 'pipe' });
  } catch {
    logger.warn('Addie External Repos: Git not available, skipping external repo indexing');
    initialized = true;
    return;
  }

  logger.info({ repoCount: EXTERNAL_REPOS.length }, 'Addie External Repos: Syncing repositories');

  externalDocsIndex = [];

  for (const repo of EXTERNAL_REPOS) {
    const repoPath = syncRepo(repo);
    if (repoPath) {
      const docs = indexRepo(repo, repoPath);
      externalDocsIndex.push(...docs);
    }
  }

  initialized = true;
  logger.info(
    {
      totalDocs: externalDocsIndex.length,
      repos: EXTERNAL_REPOS.map((r) => r.id).join(', '),
    },
    'Addie External Repos: Indexing complete'
  );
}

/**
 * Check if external repos index is ready
 */
export function isExternalReposReady(): boolean {
  return initialized;
}

/**
 * Synonyms for common search terms to improve recall.
 * Maps query terms to related terms that should also be searched.
 */
const SEARCH_SYNONYMS: Record<string, string[]> = {
  setup: ['quickstart', 'install', 'getting started', 'configure', 'deployment'],
  install: ['setup', 'quickstart', 'getting started'],
  start: ['quickstart', 'getting started', 'setup'],
  deploy: ['deployment', 'hosting', 'cloud', 'production'],
  config: ['configure', 'configuration', 'environment', 'settings'],
  run: ['start', 'execute', 'launch'],
};

/**
 * Paths that indicate "getting started" documentation - boost these for setup queries
 */
const GETTING_STARTED_PATTERNS = ['quickstart', 'readme', 'index', 'getting-started', 'installation'];

/**
 * Check if a query is asking about getting started / setup
 */
function isGettingStartedQuery(queryLower: string): boolean {
  const gettingStartedTerms = [
    'setup',
    'install',
    'start',
    'getting started',
    'quickstart',
    'begin',
    'deploy',
    'run',
    'how to',
    'how do i',
  ];
  return gettingStartedTerms.some((term) => queryLower.includes(term));
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Search external repos documentation
 */
export function searchExternalDocs(
  query: string,
  options: { repoId?: string; limit?: number } = {}
): IndexedExternalDoc[] {
  if (!initialized || externalDocsIndex.length === 0) {
    return [];
  }

  const limit = options.limit ?? 5;
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 2);

  // Expand query words with synonyms
  const expandedWords = new Set(queryWords);
  for (const word of queryWords) {
    const synonyms = SEARCH_SYNONYMS[word];
    if (synonyms) {
      synonyms.forEach((syn) => expandedWords.add(syn));
    }
  }

  const isGettingStarted = isGettingStartedQuery(queryLower);

  // Score each document
  const scored = externalDocsIndex
    .filter((doc) => {
      // Filter by repo if specified
      if (options.repoId && doc.repoId !== options.repoId) {
        return false;
      }
      return true;
    })
    .map((doc) => {
      const titleLower = doc.title.toLowerCase();
      const contentLower = doc.content.toLowerCase();
      const pathLower = doc.path.toLowerCase();

      let score = 0;

      // Exact query match in title (highest weight)
      if (titleLower.includes(queryLower)) {
        score += 100;
      }

      // Exact query match in content
      if (contentLower.includes(queryLower)) {
        score += 50;
      }

      // Individual word matches (including synonyms)
      for (const word of expandedWords) {
        if (titleLower.includes(word)) {
          score += 20;
        }
        // Count occurrences in content (limited to avoid huge scores)
        const escapedWord = escapeRegex(word);
        const occurrences = Math.min((contentLower.match(new RegExp(escapedWord, 'g')) || []).length, 10);
        score += occurrences * 2;
      }

      // Boost "getting started" docs for setup-related queries
      if (isGettingStarted) {
        const isGettingStartedDoc = GETTING_STARTED_PATTERNS.some(
          (pattern) => pathLower.includes(pattern) || titleLower.includes(pattern)
        );
        if (isGettingStartedDoc) {
          score += 30;
        }
      }

      return { doc, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ doc }) => doc);

  return scored;
}

/**
 * Get all indexed external repos with doc counts
 */
export function getExternalRepoStats(): Array<{ id: string; name: string; docCount: number }> {
  const counts = new Map<string, number>();
  const names = new Map<string, string>();

  for (const doc of externalDocsIndex) {
    counts.set(doc.repoId, (counts.get(doc.repoId) || 0) + 1);
    names.set(doc.repoId, doc.repoName);
  }

  return Array.from(counts.entries()).map(([id, count]) => ({
    id,
    name: names.get(id) || id,
    docCount: count,
  }));
}

/**
 * Get the list of configured external repos
 */
export function getConfiguredRepos(): ExternalRepo[] {
  return [...EXTERNAL_REPOS];
}
