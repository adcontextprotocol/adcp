#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { prepare, assess } = require('./sdk-response-conformance/lib.cjs');
const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'prepare') {
    const plan = prepare(args[0] || '3.2.0-rc.3');
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
  } else if (command === 'report') {
    const [planFile, ...runs] = args;
    if (!planFile || !runs.length) throw Error('report requires plan.json and driver output file(s)');
    const plan = JSON.parse(fs.readFileSync(planFile));
    const reports = runs.map(file => assess(plan, JSON.parse(fs.readFileSync(file))));
    process.stdout.write(JSON.stringify({ reports }, null, 2) + '\n');
    if (reports.some(report => report.summary.cases_with_findings || report.summary.skipped)) process.exitCode = 1;
  } else if (command === 'report-matrix') {
    if (!args.length || args.length % 2 !== 0) {
      throw Error('report-matrix requires plan.json run.json pairs');
    }
    const reports = [];
    for (let index = 0; index < args.length; index += 2) {
      const plan = JSON.parse(fs.readFileSync(args[index]));
      const run = JSON.parse(fs.readFileSync(args[index + 1]));
      reports.push(assess(plan, run));
    }
    process.stdout.write(JSON.stringify({ reports }, null, 2) + '\n');
    if (reports.some(report => report.summary.cases_with_findings || report.summary.skipped)) process.exitCode = 1;
  } else throw Error('Usage: probe-sdk-response-conformance.cjs prepare [release] | report plan.json run.json [...] | report-matrix plan.json run.json [...]');
} catch (error) { process.stderr.write(`${error.stack}\n`); process.exitCode = 2; }
