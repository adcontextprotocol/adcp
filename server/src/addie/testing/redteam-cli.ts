#!/usr/bin/env npx tsx
/**
 * Red-team regression CLI.
 *
 * Runs all 25 hostile questions against a live Addie endpoint and reports
 * deterministic pass/fail.
 *
 * Usage:
 *   npm run test:redteam                       # localhost:${CONDUCTOR_PORT|55100}
 *   ADDIE_BASE_URL=https://addie.staging.example npm run test:redteam
 *   npx tsx server/src/addie/testing/redteam-cli.ts --only gov-1,priv-1
 *
 * Exits 0 on all-pass, 1 on any failure. Suitable for CI gating against a
 * deployed environment.
 */

import {
  runRedTeamScenarios,
  formatRedTeamReport,
} from './redteam-runner.js';

function parseArgs(): { only?: Set<string>; baseUrl?: string } {
  const args = process.argv.slice(2);
  const out: { only?: Set<string>; baseUrl?: string } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--only' && args[i + 1]) {
      out.only = new Set(args[++i].split(',').map((s) => s.trim()));
    } else if (args[i] === '--base-url' && args[i + 1]) {
      out.baseUrl = args[++i];
    }
  }
  if (!out.baseUrl && process.env.ADDIE_BASE_URL) {
    out.baseUrl = process.env.ADDIE_BASE_URL;
  }
  return out;
}

async function main(): Promise<void> {
  const { only, baseUrl } = parseArgs();

  try {
    const summary = await runRedTeamScenarios({ only, baseUrl });
    console.log(formatRedTeamReport(summary));
    process.exit(summary.failed === 0 ? 0 : 1);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nRed-team runner failed to start: ${message}`);
    console.error('Is Addie running? Check ADDIE_BASE_URL or CONDUCTOR_PORT.');
    process.exit(2);
  }
}

main();
