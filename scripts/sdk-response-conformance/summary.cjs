'use strict';
const fs = require('node:fs');
const { reports } = JSON.parse(fs.readFileSync(process.argv[2]));
console.log('SDK fixture evidence. Known findings remain; this is not a full conformance or purchase-workflow pass.\n');
console.log('| SDK | Calls | Skips | Schema invalid | Cases with findings |');
console.log('| --- | ---: | ---: | ---: | ---: |');
for (const { sdk, summary } of reports) console.log(`| ${sdk.package} ${sdk.version} | ${summary.dispatched} | ${summary.skipped} | ${summary.schema_invalid} | ${summary.cases_with_findings} |`);
console.log('\nFull responses, served-version evidence, semantic checks and unimplemented manifest tools are in the sdk-response-evidence artifact.');
