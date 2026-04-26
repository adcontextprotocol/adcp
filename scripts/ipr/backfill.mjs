#!/usr/bin/env node
/**
 * Backfill IPR signatures from historical comments across AAO repositories.
 *
 * Walks PR comments in every target repo, finds comments that match the sign
 * phrase, validates that the commenter is the PR author, and merges the
 * results into signatures/ipr-signatures.json. Also pulls any existing
 * signatures recorded on adcp's historical `ipr-signatures` branch (written by
 * the previous contributor-assistant bot).
 *
 * Usage:
 *   GITHUB_TOKEN=… node scripts/ipr/backfill.mjs [--dry-run] [--write]
 *
 * Default is dry-run. Pass --write to update signatures/ipr-signatures.json on
 * disk. Does not commit; review the diff and commit manually.
 *
 * The token needs read access to all target repos. For private forks, use a
 * PAT with `repo` scope; public repos work with any token.
 */

import { GitHubClient } from './github.mjs';
import {
  SIGN_PHRASE,
  addSignature,
  hasSigned,
  isSignPhrase,
  readSignatures,
  writeSignatures,
} from './signatures.mjs';

const DEFAULT_REPOS = [
  'adcontextprotocol/adcp',
  'adcontextprotocol/adcp-client',
  'adcontextprotocol/adcp-client-python',
  'adcontextprotocol/adcp-go',
  'adcontextprotocol/creative-agent',
  'prebid/salesagent',
];

const HISTORICAL_BRANCH_REPO = 'adcontextprotocol/adcp';
const HISTORICAL_BRANCH_NAME = 'ipr-signatures';
const HISTORICAL_BRANCH_PATH = 'signatures/ipr-signatures.json';

function parseArgs(argv) {
  const args = { dryRun: true, repos: DEFAULT_REPOS };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--write') args.dryRun = false;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--repo') {
      args.repos = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args.repos.push(argv[++i]);
      }
    } else {
      throw new Error(`Unknown arg: ${a}`);
    }
  }
  return args;
}

async function fetchHistoricalSignatures(gh) {
  try {
    const file = await gh.request(
      'GET',
      `/repos/${HISTORICAL_BRANCH_REPO}/contents/${HISTORICAL_BRANCH_PATH}`,
      { query: { ref: HISTORICAL_BRANCH_NAME } },
    );
    if (!file?.content) return [];
    const content = Buffer.from(file.content, file.encoding ?? 'base64').toString('utf8');
    const parsed = JSON.parse(content);
    return Array.isArray(parsed.signedContributors) ? parsed.signedContributors : [];
  } catch (err) {
    console.error(`Warning: could not fetch historical ${HISTORICAL_BRANCH_REPO}@${HISTORICAL_BRANCH_NAME} — ${err.message}`);
    return [];
  }
}

async function scanRepo(gh, slug) {
  const [owner, repo] = slug.split('/');
  const hits = [];
  console.error(`\nScanning ${slug}...`);

  const q = `"${SIGN_PHRASE}" repo:${slug}`;
  const candidateNumbers = new Set();
  try {
    for await (const item of gh.paginate('/search/issues', { q })) {
      if (item.pull_request) candidateNumbers.add(item.number);
    }
  } catch (err) {
    console.error(`  skipping ${slug}: search unavailable — ${err.message.split('\n')[0]}`);
    return [];
  }
  console.error(`  ${candidateNumbers.size} candidate PRs from search`);

  for (const prNumber of candidateNumbers) {
    let pr;
    try {
      pr = await gh.getPullRequest(owner, repo, prNumber);
    } catch (err) {
      console.error(`  warning: could not fetch PR #${prNumber}: ${err.message}`);
      continue;
    }
    const prAuthorId = pr.user?.id;
    const prAuthorLogin = pr.user?.login;
    if (!prAuthorId) continue;

    for await (const comment of gh.listIssueComments(owner, repo, prNumber)) {
      if (!isSignPhrase(comment.body)) continue;
      if (!comment.user?.id) continue;
      if (comment.user.id !== prAuthorId) continue;
      hits.push({
        name: prAuthorLogin,
        id: prAuthorId,
        created_at: comment.created_at,
        method: 'pr_comment',
        repo: slug,
        pullRequestNo: prNumber,
        comment_id: comment.id,
        comment_url: comment.html_url,
      });
      break;
    }
  }
  console.error(`  → ${hits.length} signature comments found`);
  return hits;
}

function chooseEarliest(a, b) {
  const ta = Date.parse(a.created_at) || Number.MAX_SAFE_INTEGER;
  const tb = Date.parse(b.created_at) || Number.MAX_SAFE_INTEGER;
  return ta <= tb ? a : b;
}

function mergeByGithubId(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const entry of list) {
      if (!entry?.id) continue;
      const existing = byId.get(entry.id);
      byId.set(entry.id, existing ? chooseEarliest(existing, entry) : entry);
    }
  }
  return [...byId.values()];
}

function normalizeHistoricalEntry(entry) {
  const { repoId, pullRequestNo, comment_id, created_at, name, id, method, repo } = entry;
  const resolvedRepo = repo ?? repoIdToSlug(repoId) ?? undefined;
  return {
    name,
    id,
    created_at,
    method: method ?? 'pr_comment',
    ...(resolvedRepo ? { repo: resolvedRepo } : {}),
    ...(pullRequestNo ? { pullRequestNo } : {}),
    ...(comment_id ? { comment_id } : {}),
  };
}

// Numeric GitHub repo IDs that appeared in the historical `ipr-signatures`
// branch written by the old bot. Resolve to their current slug via
// `gh api repositories/<id>` (IDs are stable across org transfers).
const REPO_ID_MAP = {
  1022611643: 'adcontextprotocol/adcp',
  1025117899: 'prebid/salesagent',
  1041731072: 'adcontextprotocol/adcp-client',
  1072097195: 'adcontextprotocol/creative-agent',
  1090305973: 'adcontextprotocol/adcp-client-python',
};

function repoIdToSlug(repoId) {
  return REPO_ID_MAP[repoId] ?? null;
}

async function main() {
  const { dryRun, repos } = parseArgs(process.argv);
  const gh = new GitHubClient();

  const existingRaw = readSignatures();
  const existing = {
    signedContributors: existingRaw.signedContributors.map(normalizeHistoricalEntry),
  };
  console.error(`Existing signatures on main: ${existing.signedContributors.length}`);

  const historical = (await fetchHistoricalSignatures(gh)).map(normalizeHistoricalEntry);
  console.error(`Signatures on ${HISTORICAL_BRANCH_NAME} branch: ${historical.length}`);

  const scanned = [];
  for (const repo of repos) {
    const hits = await scanRepo(gh, repo);
    scanned.push(...hits);
  }
  console.error(`\nCandidate signatures from live comment scan: ${scanned.length}`);

  const merged = mergeByGithubId(existing.signedContributors, historical, scanned);
  console.error(`Merged unique signers (by GitHub ID): ${merged.length}`);

  const added = merged.filter((e) => !hasSigned(existing, e.id));
  console.error(`\nNew signers to add: ${added.length}`);
  for (const entry of added.sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    console.error(`  + ${entry.name} (id ${entry.id}) — ${entry.repo}#${entry.pullRequestNo ?? '?'} on ${entry.created_at.slice(0, 10)}`);
  }

  let next = existing;
  for (const entry of added) {
    const res = addSignature(next, entry);
    next = res.data;
  }

  if (dryRun) {
    console.error('\n--dry-run: no files written. Pass --write to update signatures/ipr-signatures.json');
    return;
  }

  writeSignatures(next);
  console.error(`\nWrote ${next.signedContributors.length} signatures to signatures/ipr-signatures.json`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
