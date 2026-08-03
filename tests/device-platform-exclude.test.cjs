const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const targeting = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'static', 'schemas', 'source', 'core', 'targeting.json'),
  'utf8',
));

describe('device_platform_exclude targeting overlay', () => {
  it('uses the canonical device-platform enum with a non-empty array', () => {
    const field = targeting.properties.device_platform_exclude;
    assert.equal(field.type, 'array');
    assert.equal(field.minItems, 1);
    assert.equal(field.items.$ref, '/schemas/enums/device-platform.json');
  });

  it('pins exclude-wins and reject-rather-than-drop semantics', () => {
    const description = targeting.properties.device_platform_exclude.description;
    assert.match(description, /Exclusion wins/);
    assert.match(description, /MUST reject/);
    assert.match(description, /silently dropping/);
  });
});
