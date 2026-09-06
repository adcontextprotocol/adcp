import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const requiredTypecheck = "tsc --project server/tsconfig.json --noEmit && npm run typecheck:fixed-trace-rollout-tests";
const productionTypecheck = "tsc --project server/tsconfig.json --noEmit";

type RootScripts = Readonly<Record<string, string>>;

function assertRequiredRolloutTypecheckWiring(scripts: RootScripts): void {
  expect(scripts.typecheck).toBe(requiredTypecheck);
  expect(scripts.typecheck.indexOf(productionTypecheck)).toBeLessThan(
    scripts.typecheck.indexOf("npm run typecheck:fixed-trace-rollout-tests"),
  );
  expect(scripts.test.split(/\s+&&\s+/)).toContain("npm run typecheck");
  expect(scripts.precommit.split(/\s+&&\s+/)).toContain("npm run typecheck");
}

describe("fixed-trace rollout test-aware typecheck wiring", () => {
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
    readonly scripts: RootScripts;
  };

  it("is reached through required root test and precommit command manifests", () => {
    assertRequiredRolloutTypecheckWiring(packageJson.scripts);

    const canonicalShardRunner = readFileSync(resolve(root, "scripts/run-test-stage-shard.mjs"), "utf8");
    expect(canonicalShardRunner).toContain("const testCommand = packageJson.scripts?.test");
    expect(canonicalShardRunner).toContain("spawnSync('npm', ['run', stage.scriptName]");

    const workflow = readFileSync(resolve(root, ".github/workflows/build-check.yml"), "utf8");
    expect(workflow).toContain("node scripts/run-test-stage-shard.mjs");
    expect(workflow).toContain("needs: [build-worker, canonical-tests, server-unit-worker]");
  });

  it("fails independently when an isolated script manifest drops the parent invocation", () => {
    // This is deliberately the production compiler command, without the root
    // script wrapper. It succeeds for the current source, which demonstrates
    // why the independent root manifest assertion is necessary.
    const compiler = spawnSync(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["tsc", "--project", "server/tsconfig.json", "--noEmit", "--pretty", "false"],
      { cwd: root, encoding: "utf8" },
    );
    expect(compiler.status, `${compiler.stdout}${compiler.stderr}`).toBe(0);

    const orphaned = {
      ...packageJson.scripts,
      typecheck: productionTypecheck,
    };
    const isolated = mkdtempSync(resolve(tmpdir(), "fixed-trace-typecheck-wiring-"));
    try {
      writeFileSync(resolve(isolated, "package.json"), JSON.stringify({ scripts: orphaned }));
      const isolatedScripts = JSON.parse(readFileSync(resolve(isolated, "package.json"), "utf8")) as {
        readonly scripts: RootScripts;
      };
      expect(() => assertRequiredRolloutTypecheckWiring(isolatedScripts.scripts)).toThrow();
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  }, 30_000);
});
