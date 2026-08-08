const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const root = path.join(__dirname, '..');
const architecture = fs.readFileSync(path.join(root, 'docs', 'trusted-match', 'router-architecture.mdx'), 'utf8');
const registration = JSON.parse(fs.readFileSync(
  path.join(root, 'static', 'schemas', 'source', 'trusted-match', 'provider-registration.json'),
  'utf8',
));

describe('TMP router 3.2 merge semantics', () => {
  it('uses provider priority for Context Match offer conflicts', () => {
    assert.match(architecture, /higher-priority provider \(lower `priority` value\)/);
    assert.match(architecture, /Equal priorities are broken by first response received/);
    assert.match(registration.properties.priority.description, /equal priorities are broken by first response received/i);
  });

  it('ratifies responder-scoped union for Identity Match', () => {
    assert.match(architecture, /successful responders only/);
    assert.match(architecture, /union of every responder's `eligible_package_ids`/);
    assert.match(architecture, /MUST NOT intersect omissions or require a quorum/);
    assert.match(architecture, /zero successful responders/);
    assert.match(architecture, /one successful responder/);
    assert.match(registration.properties.priority.description, /Identity Match eligibility remains a responder-scoped union/);
  });
});
