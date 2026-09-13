'use strict';
// A regression baseline records defects, never converts them into conformance.
// The ordinary report command still exits 1 while any finding/skip is present.
const fs = require('node:fs');
const assert = require('node:assert/strict');
function baseline(reports) {
  return reports.map(report => ({
    sdk: { package: report.sdk.package, version: report.sdk.version },
    protocol: report.protocol,
    summary: report.summary,
    findings: report.results.filter(row => row.findings.length || row.skip).map(row => ({
      id: row.id, findings: row.findings, ...(row.skip && { skip: row.skip }),
    })),
  }));
}
if (require.main === module) {
  try {
    const actual = JSON.parse(fs.readFileSync(process.argv[2]));
    const expected = JSON.parse(fs.readFileSync(process.argv[3]));
    assert.deepEqual(baseline(actual.reports), expected);
    console.log('SDK evidence matches the reviewed baseline. Known findings and skips remain; this is not a conformance pass.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { baseline };
