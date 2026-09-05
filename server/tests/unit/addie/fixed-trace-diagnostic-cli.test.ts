import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { parseFixedTraceDiagnosticCliArguments } from "../../../src/addie/eval/fixed-trace-diagnostic-cli.js";

describe("fixed-trace diagnostic CLI parser", () => {
  it("accepts only bounded dry-run forms", () => {
    expect(
      parseFixedTraceDiagnosticCliArguments([
        "--validate-only",
        "--providers=openai",
      ]),
    ).toEqual({
      validateOnly: true,
      providers: "openai",
      architectureArm: undefined,
      suite: undefined,
      softMaxUsd: undefined,
      output: undefined,
      experimentPlan: undefined,
      trustedManifest: undefined,
    });
    expect(
      parseFixedTraceDiagnosticCliArguments(["--validate-only=true"])
        .validateOnly,
    ).toBe(true);
  });

  it.each([
    ["--validate-only=false"],
    ["--validate-onl"],
    ["--providers=openai", "--providers=google"],
    ["positional"],
    ["--judge-providers=openai"],
    ["--providers"],
    ["--suite=unknown"],
  ])("rejects unsafe option input %j", (args) => {
    expect(() => parseFixedTraceDiagnosticCliArguments(args)).toThrow();
  });

  it("validates without credentials, writes, provider setup, or dispatch", () => {
    const result = execFileSync(
      "npx",
      [
        "tsx",
        "server/tests/manual/fixed-trace-provider-eval.ts",
        "--validate-only",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "" },
      },
    );
    const validated = result
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find((line) => line?.diagnosticOnly === true);
    expect(validated).toMatchObject({
      diagnosticOnly: true,
      dispatchable: false,
      outputWritten: false,
      providerCalls: 0,
    });
  }, 20_000);

  it.each([["--output=/tmp/out.json"], ["--validate-only=false"]])(
    "rejects malformed dry run configuration",
    (...args) => {
      expect(() =>
        execFileSync(
          "npx",
          [
            "tsx",
            "server/tests/manual/fixed-trace-provider-eval.ts",
            "--validate-only",
            ...args,
          ],
          { cwd: process.cwd(), stdio: "pipe" },
        ),
      ).toThrow();
    },
  );
});
