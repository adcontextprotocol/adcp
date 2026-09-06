import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseFixedTraceDiagnosticCliArguments } from "../../../src/addie/eval/fixed-trace-diagnostic-cli.js";

const REPOSITORY_ROOT = process.cwd();
const LOCAL_TSX_CLI = realpathSync(resolve(REPOSITORY_ROOT, "node_modules/.bin/tsx"));
const LOCAL_TSX_EXPECTED = resolve(REPOSITORY_ROOT, "node_modules/tsx/dist/cli.mjs");
const PROVIDER_FREE_ENV = { PATH: process.env.PATH ?? "", NODE_ENV: "test" };

function runPlanningCli(arguments_: readonly string[]) {
  // Execute Node against this checkout's resolved tsx CLI, never npx. The
  // minimal environment deliberately omits every provider credential.
  expect(LOCAL_TSX_CLI).toBe(LOCAL_TSX_EXPECTED);
  return spawnSync(
    process.execPath,
    [LOCAL_TSX_CLI, "server/tests/manual/fixed-trace-provider-eval.ts", ...arguments_],
    { cwd: REPOSITORY_ROOT, encoding: "utf8", env: PROVIDER_FREE_ENV },
  );
}

describe("fixed-trace diagnostic CLI parser", () => {
  it("accepts only the bare pinned validation flag", () => {
    expect(parseFixedTraceDiagnosticCliArguments([])).toEqual({ validateOnly: false });
    expect(parseFixedTraceDiagnosticCliArguments(["--validate-only"]))
      .toEqual({ validateOnly: true });
  });

  it.each([
    ["--validate-only=false"],
    ["--validate-only=true"],
    ["--validate-onl"],
    ["--providers=openai"],
    ["--architecture-arm=direct_generation"],
    ["--suite=canonical"],
    ["--trusted-manifest=forged.json"],
    ["--experiment-plan=forged.json"],
    ["--soft-max-usd=NaN"],
    ["--providers=openai", "--providers=google"],
    ["positional"],
    ["--judge-providers=openai"],
    ["--providers"],
    ["--suite=unknown"],
  ])("rejects unsafe option input %j", (args) => {
    expect(() => parseFixedTraceDiagnosticCliArguments(args)).toThrow();
  });

  it("emits one clean JSON line without credentials, writes, provider setup, or dispatch", () => {
    const result = runPlanningCli(["--validate-only"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const validated = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(validated).toMatchObject({
      diagnosticOnly: true,
      dispatchable: false,
      outputWritten: false,
      providerCalls: 0,
      architectureDiagnostic: {
        pilot: {
          plan: {
            dispatchable: false,
            candidateCeiling: { totalCalls: 21, candidateCostUsd: 1.431710 },
            separatelyReviewedPaidLauncherJudges: { included: false, additionalMaximumCalls: 18 },
          },
        },
        haikuRouter: { dispatchable: false, productionEligible: false, canaryEligible: false },
        lunaRouter: { dispatchable: false, productionEligible: false, canaryEligible: false },
      },
    });
  }, 20_000);

  it.each([
    ["--output=/tmp/out.json"],
    ["--providers=openai"],
    ["--architecture-arm=direct_generation"],
    ["--suite=canonical"],
    ["--trusted-manifest=forged.json"],
    ["--soft-max-usd=NaN"],
    ["--validate-only=false"],
  ])(
    "rejects unbound runtime option %j without stdout or side effects",
    (...args) => {
      const result = runPlanningCli(["--validate-only", ...args]);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("accepts only the bare --validate-only flag");
    },
  );
});
