#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { prepare, assess } = require('./sdk-response-conformance/lib.cjs');
const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'prepare') {
    const plan = prepare(args[0] || '3.2.0-rc.2');
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
  } else if (command === 'report') {
    // Pairs, because the language waves can be staggered across releases: each
    // driver is graded against the plan it was actually dispatched with.
    if (!args.length || args.length % 2) throw Error('report requires plan.json run.json pair(s)');
    const reports = [];
    for (let index = 0; index < args.length; index += 2) {
      reports.push(assess(JSON.parse(fs.readFileSync(args[index])), JSON.parse(fs.readFileSync(args[index + 1]))));
    }
    process.stdout.write(JSON.stringify({ reports }, null, 2) + '\n');
    if (reports.some(report => report.summary.cases_with_findings || report.summary.skipped)) process.exitCode = 1;
  } else throw Error('Usage: probe-sdk-response-conformance.cjs prepare [release] | report plan.json run.json [plan.json run.json ...]');
} catch (error) { process.stderr.write(`${error.stack}\n`); process.exitCode = 2; }
