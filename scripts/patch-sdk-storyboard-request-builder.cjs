#!/usr/bin/env node
/**
 * Temporary local SDK shim for current storyboard runs.
 *
 * @adcp/sdk 9.0.0-beta.23 treats sample_request.start_time: "asap" as an
 * unparsable stale date in the storyboard request builder and rewrites it to a
 * future timestamp. That prevents active-buy storyboards from testing the
 * intended lifecycle until the upstream SDK release lands.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'node_modules/@adcp/sdk/dist/lib/testing/storyboard/request-builder.js');

if (!fs.existsSync(TARGET)) {
  process.exit(0);
}

const backup = `${TARGET}.adcp-overlay-backup`;
if (!fs.existsSync(backup)) {
  fs.copyFileSync(TARGET, backup);
}

let text = fs.readFileSync(TARGET, 'utf8');
const legacyWindow = `    const sampleStartMs = parseTime(sampleStart);
    const sampleEndMs = parseTime(sampleEnd);
    const startTime = sampleStart && sampleStartMs !== undefined && sampleStartMs >= now ? sampleStart : defaultStart;
`;
const asapAwareWindow = `    if (sampleStart === 'asap') {
        const sampleEndMs = parseTime(sampleEnd);
        const endTime = sampleEnd && sampleEndMs !== undefined && sampleEndMs >= now ? sampleEnd : defaultEnd;
        return { startTime: 'asap', endTime };
    }
    const sampleStartMs = parseTime(sampleStart);
    const sampleEndMs = parseTime(sampleEnd);
    const startTime = sampleStart && sampleStartMs !== undefined && sampleStartMs >= now ? sampleStart : defaultStart;
`;

if (text.includes("sampleStart === 'asap'")) {
  process.exit(0);
}

if (!text.includes(legacyWindow)) {
  console.error('patch-sdk-storyboard-request-builder: expected request-builder window block not found');
  process.exit(1);
}

text = text.replace(legacyWindow, asapAwareWindow);
fs.writeFileSync(TARGET, text);
