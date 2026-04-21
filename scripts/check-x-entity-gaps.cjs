#!/usr/bin/env node
/**
 * Report id-shaped schema fields that do NOT carry `x-entity`. Advisory
 * only — does not fail CI. Intended for authors adding new request/response
 * schemas who want to see what the context-entity lint might miss.
 *
 *   node scripts/check-x-entity-gaps.cjs              — all domains
 *   node scripts/check-x-entity-gaps.cjs governance   — one domain
 *
 * Fields matching `TRANSIENT_ID_NAMES` in lint-storyboard-context-entity.cjs
 * are excluded (idempotency_key, request_id, correlation_id, etc).
 *
 * If a field shows up here and is deliberately un-annotated, document the
 * decision in the changeset or the registry definition; don't silence.
 */

'use strict';

const path = require('node:path');
const { reportCoverage } = require('./lint-storyboard-context-entity.cjs');

const SCHEMA_DIR = path.resolve(__dirname, '..', 'static', 'schemas', 'source');

function main() {
  const domainFilter = process.argv[2] || null;
  const { unannotated } = reportCoverage();

  const buckets = new Map();
  for (const u of unannotated) {
    const rel = path.relative(SCHEMA_DIR, u.file);
    const domain = rel.split('/')[0];
    if (domainFilter && domain !== domainFilter) continue;
    const list = buckets.get(domain) || [];
    list.push(`${rel}:${u.path}`);
    buckets.set(domain, list);
  }

  if (buckets.size === 0) {
    console.log('No un-annotated id-shaped fields found.');
    return;
  }

  console.log(`Un-annotated id-shaped fields${domainFilter ? ` in ${domainFilter}/` : ''}:\n`);
  const sortedDomains = [...buckets.keys()].sort();
  for (const domain of sortedDomains) {
    const list = buckets.get(domain);
    console.log(`  ${domain}/ (${list.length})`);
    for (const entry of list.slice(0, 20)) console.log(`    ${entry}`);
    if (list.length > 20) console.log(`    … and ${list.length - 20} more`);
    console.log('');
  }
  console.log(
    'Some of these are genuine entities that need annotation. Others are ' +
      'catalog-item-internal ids (hotel_id, job_id), dedup keys, or ' +
      'structural refs that should be added to the TRANSIENT_ID_NAMES list ' +
      'in scripts/lint-storyboard-context-entity.cjs. See ' +
      'docs/contributing/x-entity-annotation.md.',
  );
}

main();
