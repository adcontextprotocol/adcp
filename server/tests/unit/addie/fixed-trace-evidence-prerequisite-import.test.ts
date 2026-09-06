import { spawnSync } from "node:child_process";
import { buildSync } from "esbuild";
import { describe, expect, it } from "vitest";

function bundledModule(entryPoint: string): { readonly source: string; readonly inputs: readonly string[] } {
  const result = buildSync({
    entryPoints: [entryPoint],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    write: false,
    metafile: true,
  });
  return {
    source: result.outputFiles[0]!.text,
    inputs: Object.freeze(Object.keys(result.metafile!.inputs).sort()),
  };
}

const judgeModule = bundledModule("server/src/addie/eval/fixed-trace-judge.ts");
const coordinatorModule = bundledModule(
  "server/src/addie/eval/fixed-trace-evaluator-coordinator.ts",
);
const probe = `
  const bundles = JSON.parse(Buffer.from(${JSON.stringify(
    Buffer.from(JSON.stringify([judgeModule.source, coordinatorModule.source])).toString("base64"),
  )}, "base64").toString());
  let clockReads = 0;
  let randomReads = 0;
  Date.now = () => { clockReads += 1; return 0; };
  Math.random = () => { randomReads += 1; return 0; };
  const [judge, coordinator] = await Promise.all(bundles.map((source) =>
    import("data:text/javascript;base64," + Buffer.from(source).toString("base64")),
  ));
  judge.fixedTraceJudgeUnavailable();
  judge.fixedTraceJudgeSummaryUnavailable();
  coordinator.fixedTraceEvaluatorCoordinatorUnavailable();
  process.stdout.write(JSON.stringify({ clockReads, randomReads }));
`;

describe("fixed-trace B import boundary", () => {
  it("has only the pure A manifest and refusal modules in its import closure", () => {
    const expected = [
      "server/src/addie/eval/fixed-trace-a-prerequisite-manifest.ts",
      "server/src/addie/eval/fixed-trace-evaluator-coordinator.ts",
      "server/src/addie/eval/fixed-trace-evidence-prerequisite.ts",
      "server/src/addie/eval/fixed-trace-judge.ts",
    ];
    expect([...new Set([...judgeModule.inputs, ...coordinatorModule.inputs])].sort()).toEqual(expected);
  });

  it("traps clock and random before importing or invoking every bundled public refusal entry", () => {
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
