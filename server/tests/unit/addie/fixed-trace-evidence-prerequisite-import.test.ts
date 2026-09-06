import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const probe = `
  const judge = await import("./server/src/addie/eval/fixed-trace-judge.ts");
  const coordinator = await import("./server/src/addie/eval/fixed-trace-evaluator-coordinator.ts");
  let clockReads = 0;
  let randomReads = 0;
  Date.now = () => { clockReads += 1; return 0; };
  Math.random = () => { randomReads += 1; return 0; };
  judge.fixedTraceJudgeUnavailable();
  judge.fixedTraceJudgeSummaryUnavailable();
  coordinator.fixedTraceEvaluatorCoordinatorUnavailable();
  process.stdout.write(JSON.stringify({ clockReads, randomReads }));
`;

describe("fixed-trace B import boundary", () => {
  it("loads the refusal modules, then runs every public refusal entry without clock or random reads", () => {
    const child = spawnSync(process.execPath, [
      "--import", "tsx", "--input-type=module", "--eval", probe,
    ], {
      cwd: process.cwd(), encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL",
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ clockReads: 0, randomReads: 0 });
  });
});
