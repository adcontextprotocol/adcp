const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const registryDoc = fs.readFileSync(path.join(__dirname, '..', 'docs/registry/index.mdx'), 'utf8');
const measurementSection = registryDoc.slice(
  registryDoc.indexOf('#### Measurement-vendor discovery'),
  registryDoc.indexOf('#### Creative-agent discovery')
);

test('measurement catalog links have distinct documented trust semantics', () => {
  assert.match(measurementSection, /`methodology_url` \| Vendor-published methodology documentation/);
  assert.match(measurementSection, /`standard_reference` \| The industry-standard document the vendor says the metric implements/);
  assert.match(measurementSection, /`accreditations\[\]\.evidence_url` \| The vendor-supplied pointer intended to lead to the accreditor's public listing/);
  assert.match(measurementSection, /separate, explicit attestation or verification state/);
  assert.match(measurementSection, /Enrollment, catalog caching, a plausible accreditor name, and an `evidence_url` alone do not establish that state/);
});

test('measurement link guidance covers safe rendering and retrieval', () => {
  assert.match(measurementSection, /clickable links only for HTTPS destinations/);
  assert.match(measurementSection, /target="_blank"` with `rel="noopener noreferrer"/);
  assert.match(measurementSection, /rather than interpolating catalog values through `innerHTML`/);
  assert.match(measurementSection, /blocking private, loopback, link-local, and metadata-service destinations/);
  assert.match(measurementSection, /does not repeat them in a top-level `_meta` path list or per-value provenance flag/);
});
