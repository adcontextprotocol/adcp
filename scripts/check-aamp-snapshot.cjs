#!/usr/bin/env node
/**
 * Checks the dated AAMP claims published in docs/faq.mdx and Addie's
 * knowledge rules against the observable state of the IABTechLab GitHub
 * org. The claims are absence claims ("no tagged specification release")
 * pinned to a date; when the external state changes, the docs must be
 * refreshed or they become false statements about a third party.
 *
 * Reads scripts/aamp-snapshot.json for the pinned expectations.
 * Prints a markdown drift report to stdout.
 * Exit codes: 0 = no drift, 3 = drift detected, 1 = check failed to run.
 */

const fs = require('node:fs');
const path = require('node:path');

const snapshot = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'aamp-snapshot.json'), 'utf8')
);

const API = 'https://api.github.com';

async function gh(route) {
  const headers = { 'User-Agent': 'adcp-aamp-snapshot-check', Accept: 'application/vnd.github+json' };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${route}`, { headers });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GitHub API ${route} -> HTTP ${res.status}`);
  }
  return res.json();
}

// A missing repo (renamed or removed) changes the org's shape, which is
// itself drift the snapshot's claims depend on — report it, don't error.
async function tagNames(repo) {
  const tags = await gh(`/repos/${snapshot.org}/${repo}/tags?per_page=100`);
  return tags === null ? null : tags.map((t) => t.name);
}

async function main() {
  const drift = [];

  for (const repo of snapshot.expectNoTags) {
    const names = await tagNames(repo);
    if (names === null) {
      drift.push(
        `- \`${snapshot.org}/${repo}\` was not found (renamed or removed); re-verify the snapshot's component claims.`
      );
    } else if (names.length > 0) {
      drift.push(
        `- \`${snapshot.org}/${repo}\` now has tags (${names.join(', ')}); the "no tagged specification release" claim is stale.`
      );
    }
  }

  // Tag-list order is not guaranteed by the API, so compare the tag SET to
  // the single expected tag instead of trusting element 0 to be newest.
  for (const [repo, expected] of Object.entries(snapshot.expectLatestTag)) {
    const names = await tagNames(repo);
    if (names === null) {
      drift.push(
        `- \`${snapshot.org}/${repo}\` was not found (renamed or removed); re-verify the snapshot's component claims.`
      );
    } else if (names.length !== 1 || names[0] !== expected) {
      drift.push(
        `- \`${snapshot.org}/${repo}\` tags are now [${names.join(', ') || 'none'}] (snapshot expected exactly \`${expected}\`).`
      );
    }
  }

  if (drift.length === 0) {
    console.log(`No drift: IABTechLab org state still matches the ${snapshot.asOf} snapshot.`);
    return 0;
  }

  console.log(`## AAMP snapshot drift (pinned ${snapshot.asOf})`);
  console.log('');
  console.log('The published state of the IABTechLab GitHub org no longer matches the');
  console.log('dated claims in:');
  for (const surface of snapshot.claimSurfaces) console.log(`- ${surface}`);
  console.log('');
  console.log('Observed drift:');
  for (const line of drift) console.log(line);
  console.log('');
  console.log('Refresh the dated comparison (and this snapshot in `scripts/aamp-snapshot.json`)');
  console.log('so the absence claims stay accurate. Also re-check the AAMP conformance,');
  console.log('security-model, and support-policy claims against iabtechlab.com while updating.');
  return 3;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`aamp-snapshot check failed to run: ${err.message}`);
    process.exit(1);
  }
);
