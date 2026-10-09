const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { auditValue } = require('../scripts/docs-json-field-audit.cjs');

function audit(schema, value) {
  const findings = [];
  auditValue({ value, schema, schemas: new Map(), jsonPath: '$', findings });
  return findings;
}

describe('docs JSON field audit', () => {
  const forecastPoint = {
    type: 'object',
    properties: {
      budget: { type: 'number' },
      metrics: {
        type: 'object',
        properties: { coverage_rate: { type: 'object', properties: { mid: { type: 'number' } } } },
        additionalProperties: {
          type: 'object',
          properties: { low: { type: 'number' }, mid: { type: 'number' }, high: { type: 'number' } },
        },
      },
    },
  };

  it('treats an object whose additionalProperties is a schema as an open map', () => {
    assert.deepEqual(audit(forecastPoint, { budget: 1, metrics: { clicks: { mid: 10 }, coverage_rate: { mid: 0.5 } } }), []);
  });

  it('audits open-map values against the additionalProperties schema', () => {
    const findings = audit(forecastPoint, { metrics: { clicks: { mid: 10, median: 9 } } });
    assert.deepEqual(findings.map(finding => `${finding.path}.${finding.field}`), ['$.metrics.clicks.median']);
  });

  it('still flags unknown fields on closed objects', () => {
    const findings = audit(forecastPoint, { budget: 1, spend: 2 });
    assert.deepEqual(findings.map(finding => finding.field), ['spend']);
  });
});
