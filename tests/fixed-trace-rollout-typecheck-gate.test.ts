import { describe, expect, it } from "vitest";

import {
  assertNoUnexpectedDiagnostics,
  knownBaseline,
} from "../scripts/typecheck-fixed-trace-rollout-tests.mjs";

const baselineOutput = [...knownBaseline].map((diagnostic) => `${diagnostic} simulated baseline detail`).join("\n");

describe("fixed-trace rollout test-aware typecheck diagnostic gate", () => {
  it("tolerates a removed known unrelated baseline diagnostic", () => {
    const outputWithoutOneBaselineDiagnostic = baselineOutput.split("\n").slice(1).join("\n");

    expect(() => assertNoUnexpectedDiagnostics(outputWithoutOneBaselineDiagnostic)).not.toThrow();
  });

  it("rejects a new diagnostic with its accurate count", () => {
    const outputWithInjectedDiagnostic = `${baselineOutput}\nserver/tests/unit/addie/fixed-trace-rollout.test.ts(1,1): error TS9999: introduced fixture failure`;

    expect(() => assertNoUnexpectedDiagnostics(outputWithInjectedDiagnostic)).toThrow(
      "fixed-trace rollout test-aware typecheck found 1 unexpected diagnostic(s)",
    );
  });

  it("rejects a duplicate known diagnostic", () => {
    const [firstBaseline] = knownBaseline;
    const duplicateOutput = `${baselineOutput}\n${firstBaseline} duplicate`;

    expect(() => assertNoUnexpectedDiagnostics(duplicateOutput)).toThrow(
      "fixed-trace rollout test-aware typecheck found 1 unexpected diagnostic(s)",
    );
  });
});
