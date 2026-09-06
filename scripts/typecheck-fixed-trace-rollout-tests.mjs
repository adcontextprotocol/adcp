import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const requiredTypecheck = "tsc --project server/tsconfig.json --noEmit && npm run typecheck:fixed-trace-rollout-tests";

// This compiler pass protects a test-only contract, so it must be reached by
// the normal required typecheck path. Keep this exact assertion beside the
// gate: removing or reordering the wiring makes even a direct invocation fail.
if (packageJson?.scripts?.typecheck !== requiredTypecheck) {
  process.stderr.write("fixed-trace rollout test-aware typecheck is not wired into the required typecheck script\n");
  process.exit(1);
}

const result = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["tsc", "--project", "server/tsconfig.fixed-trace-rollout-tests.json", "--noEmit", "--pretty", "false"],
  { cwd: process.cwd(), encoding: "utf8" },
);
const output = `${result.stdout}${result.stderr}`;

// These SDK-version diagnostics are pre-existing in production-only billing
// files reached transitively by the legacy rollout module. Keep the exception
// exact so any fixture or other dependency diagnostic fails this test-aware
// check rather than being hidden by a broad path allowlist.
const knownBaseline = new Set([
  "server/src/billing/lazy-reconcile.ts(183,5): error TS2352:",
  "server/src/billing/stripe-client.ts(812,35): error TS2339:",
  "server/src/billing/stripe-client.ts(856,33): error TS2339:",
  "server/src/billing/stripe-client.ts(856,70): error TS2339:",
  "server/src/billing/stripe-client.ts(857,33): error TS2339:",
  "server/src/billing/stripe-client.ts(869,27): error TS2339:",
  "server/src/billing/stripe-client.ts(873,37): error TS2339:",
  "server/src/billing/stripe-client.ts(873,67): error TS2339:",
  "server/src/billing/stripe-client.ts(878,48): error TS2339:",
  "server/src/billing/stripe-client.ts(879,21): error TS2339:",
  "server/src/billing/stripe-client.ts(880,21): error TS2339:",
  "server/src/billing/stripe-client.ts(881,50): error TS2339:",
  "server/src/billing/stripe-client.ts(882,21): error TS2339:",
  "server/src/billing/stripe-client.ts(883,21): error TS2339:",
  "server/src/billing/stripe-client.ts(1872,22): error TS2339:",
  "server/src/billing/stripe-client.ts(1873,35): error TS2339:",
  "server/src/billing/stripe-client.ts(1978,30): error TS2339:",
]);
const diagnostics = output.split("\n").filter((line) => line.includes(": error TS"));
const unexpected = diagnostics.filter((line) => ![...knownBaseline].some((prefix) => line.startsWith(prefix)));

if (unexpected.length > 0 || diagnostics.length !== knownBaseline.size) {
  process.stderr.write(`${output}\n`);
  process.stderr.write(`fixed-trace rollout test-aware typecheck found ${unexpected.length} unexpected diagnostic(s)\n`);
  process.exit(1);
}

process.stdout.write("fixed-trace rollout test-aware typecheck passed (no rollout fixture diagnostics)\n");
