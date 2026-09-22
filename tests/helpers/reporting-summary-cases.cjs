const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// One portable compliance matrix is exercised by source, generated, and public
// runtime validators. Apply only the JSON Patch operations used by these cases.
function reportingSummaryCases() {
  const fixture = JSON.parse(fs.readFileSync(path.join(
    __dirname, '../../static/compliance/source/test-vectors/reporting-summary/complete-summary.json',
  ), 'utf8'));
  return fixture.cases.map(({ name, valid, patch }) => {
    const response = structuredClone(fixture.response);
    for (const { op, path: pointer, value } of patch) {
      const segments = pointer.slice(1).split('/');
      const key = segments.pop();
      const parent = segments.reduce((object, segment) => object[segment], response);
      assert.ok(['add', 'replace', 'remove'].includes(op), `Unsupported fixture operation: ${op}`);
      if (op !== 'add') assert.ok(Object.hasOwn(parent, key), `Missing fixture path: ${pointer}`);
      if (op === 'remove') delete parent[key];
      else parent[key] = structuredClone(value);
    }
    return { name, valid, response };
  });
}

module.exports = { reportingSummaryCases };
