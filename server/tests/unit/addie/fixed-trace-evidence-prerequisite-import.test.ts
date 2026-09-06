import { spawnSync } from "node:child_process";
import { build, buildSync } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  FIXED_TRACE_A_PREREQUISITE_MANIFEST_CANONICAL_JSON,
  FIXED_TRACE_A_PREREQUISITE_MANIFEST_JSON,
  FIXED_TRACE_A_PREREQUISITE_MANIFEST_MAX_BYTES,
} from "../../../src/addie/eval/fixed-trace-a-prerequisite-manifest.js";

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
const prerequisiteModule = bundledModule(
  "server/src/addie/eval/fixed-trace-evidence-prerequisite.ts",
);
const probe = `
  const bundles = JSON.parse(Buffer.from(${JSON.stringify(
    Buffer.from(JSON.stringify([judgeModule.source, coordinatorModule.source, prerequisiteModule.source])).toString("base64"),
  )}, "base64").toString());
  let clockReads = 0;
  let randomReads = 0;
  const environmentKeys = [];
  Date.now = () => { clockReads += 1; return 0; };
  Math.random = () => { randomReads += 1; return 0; };
  process.env = new Proxy(process.env, {
    get: (_target, key) => { environmentKeys.push(String(key)); return undefined; },
    ownKeys: () => { environmentKeys.push("<ownKeys>"); return []; },
  });
  const [judge, coordinator, prerequisite] = await Promise.all(bundles.map((source) =>
    import("data:text/javascript;base64," + Buffer.from(source).toString("base64")),
  ));
  judge.fixedTraceJudgeUnavailable();
  judge.fixedTraceJudgeSummaryUnavailable();
  coordinator.fixedTraceEvaluatorCoordinatorUnavailable();
  prerequisite.fixedTraceEvidencePrerequisiteDiagnostic();
  prerequisite.assertFixedTraceEvidencePrerequisitePinned();
  process.stdout.write(JSON.stringify({ clockReads, randomReads, environmentKeys }));
`;

async function hostileManifestProbe(hostileExpression: string): Promise<string> {
  const result = await build({
  stdin: {
    resolveDir: process.cwd(),
    sourcefile: "fixed-trace-hostile-manifest-probe.ts",
    contents: `
      import { fixedTraceEvidencePrerequisiteDiagnostic } from "./server/src/addie/eval/fixed-trace-evidence-prerequisite.ts";
      import { reads } from "./server/src/addie/eval/fixed-trace-a-prerequisite-manifest.js";
      process.stdout.write(JSON.stringify({ diagnostic: fixedTraceEvidencePrerequisiteDiagnostic(), reads }));
    `,
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false,
  plugins: [{
    name: "hostile-fixed-trace-manifest",
    setup(build) {
      build.onResolve({ filter: /fixed-trace-a-prerequisite-manifest\.js$/ }, () => ({
        path: "hostile-manifest", namespace: "hostile-manifest",
      }));
      build.onLoad({ filter: /.*/, namespace: "hostile-manifest" }, () => ({
        contents: `
          export const reads = { get: 0, ownKeys: 0, prototype: 0, getter: 0, primitive: 0, json: 0 };
          export const FIXED_TRACE_A_PREREQUISITE_MANIFEST_CANONICAL_JSON = ${JSON.stringify(FIXED_TRACE_A_PREREQUISITE_MANIFEST_CANONICAL_JSON)};
          export const FIXED_TRACE_A_PREREQUISITE_MANIFEST_MAX_BYTES = ${FIXED_TRACE_A_PREREQUISITE_MANIFEST_MAX_BYTES};
          export const FIXED_TRACE_A_PREREQUISITE_MANIFEST_JSON = ${hostileExpression};
        `,
        loader: "js",
      }));
    },
  }],
  });
  return result.outputFiles[0]!.text;
}

describe("fixed-trace B import boundary", () => {
  it("has only the pure A manifest and refusal modules in its import closure", () => {
    const expected = [
      "server/src/addie/eval/fixed-trace-a-prerequisite-manifest.ts",
      "server/src/addie/eval/fixed-trace-evaluator-coordinator.ts",
      "server/src/addie/eval/fixed-trace-evidence-prerequisite.ts",
      "server/src/addie/eval/fixed-trace-judge.ts",
    ];
    expect([...new Set([...judgeModule.inputs, ...coordinatorModule.inputs, ...prerequisiteModule.inputs])].sort()).toEqual(expected);
  });

  it("traps clock, random, and environment before importing or invoking every bundled public refusal entry", () => {
    const child = spawnSync(process.execPath, [
      "--input-type=module", "--eval", probe,
    ], {
      cwd: process.cwd(), encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL",
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      clockReads: 0,
      randomReads: 0,
      // Node's ESM loader performs this capability-reporting lookup; the
      // bundled B closure itself has no environment access.
      environmentKeys: ["WATCH_REPORT_DEPENDENCIES", "WATCH_REPORT_DEPENDENCIES", "WATCH_REPORT_DEPENDENCIES", "WATCH_REPORT_DEPENDENCIES", "WATCH_REPORT_DEPENDENCIES", "WATCH_REPORT_DEPENDENCIES"],
    });
  });

  it.each([
    ["proxy", `new Proxy({}, {
      get() { reads.get += 1; throw new Error("hostile get"); },
      ownKeys() { reads.ownKeys += 1; throw new Error("hostile ownKeys"); },
      getPrototypeOf() { reads.prototype += 1; throw new Error("hostile prototype"); },
    })`],
    ["accessor", `Object.defineProperty({}, "manifest", {
      get() { reads.getter += 1; throw new Error("hostile getter"); },
    })`],
    ["custom prototype", `Object.create({ inherited: "not consulted" })`],
    ["cycle", `(() => { const value = {}; value.self = value; return value; })()`],
    ["coercion hooks", `{
      [Symbol.toPrimitive]() { reads.primitive += 1; throw new Error("coerced"); },
      toJSON() { reads.json += 1; throw new Error("serialized"); },
    }`],
    ["duplicate root key", JSON.stringify(FIXED_TRACE_A_PREREQUISITE_MANIFEST_JSON.replace(
      '"version":"addie-fixed-trace-A-prerequisite-manifest-v3"',
      '"version":"forged","version":"addie-fixed-trace-A-prerequisite-manifest-v3"',
    ))],
    ["duplicate nested key", JSON.stringify(FIXED_TRACE_A_PREREQUISITE_MANIFEST_JSON.replace(
      '"providerExposure":{"status":"unavailable","digest":null}',
      '"providerExposure":{"status":"forged","status":"unavailable","digest":null}',
    ))],
    ["oversized padded source", JSON.stringify(FIXED_TRACE_A_PREREQUISITE_MANIFEST_JSON + " ".repeat(16 * 1024))],
    ["deep source", JSON.stringify(`${"{".repeat(2_000)}null${"}".repeat(2_000)}`)],
    ["serialized prototype pollution", JSON.stringify('{"__proto__":{"polluted":true}}')],
  ])("killably refuses an actual hostile %s manifest export without a trap read", async (_kind, hostileExpression) => {
    const hostileProbe = await hostileManifestProbe(hostileExpression);
    const child = spawnSync(process.execPath, [
      "--input-type=module", "--eval",
      `await import("data:text/javascript;base64," + Buffer.from(${JSON.stringify(hostileProbe)}).toString("base64"));`,
    ], {
      cwd: process.cwd(), encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL",
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      diagnostic: {
        status: "pin_drift",
        code: "fixed_trace_A_prerequisite_pin_drift",
        reason: "manifest_invalid_or_pin_mismatch",
        mismatchedFields: ["manifest_shape"],
      },
      reads: { get: 0, ownKeys: 0, prototype: 0, getter: 0, primitive: 0, json: 0 },
    });
  });
});
