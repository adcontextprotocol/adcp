const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { readFileSync, mkdtempSync, rmSync } = require("node:fs");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { test } = require("node:test");

const REVIEW = "d6e930d4a2a01ee0d476fd8347eaf258f85d889c";
const IMPLEMENTATION = "d2422f6b24f6c0b7535c1155e9175d388be44174";
const REVIEWER = "a64a17ba369122d6b3401f614a31df7b8607f043";
const actions = resolve(
  process.env.LADON_ACTIONS_PATH || ".ladon-reviewed-actions",
);
// Use the reviewed action's locked YAML parser; no consumer dependency changes.
const { parse } = createRequire(join(actions, "package.json"))("yaml");
const read = (file) => readFileSync(file, "utf8");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const workflow = parse(read(".github/workflows/ai-review.yml"));
const steps = workflow.jobs.code_review.steps;
const gate = steps.find((step) => step.id === "workflow-mod");
const notice = steps.find(
  (step) => step.name === "Comment and skip when PR modifies review workflow",
);
const invocation = steps.find((step) => step.name === "Run Ladon");

function validateInvocation(step) {
  assert.equal(step.uses, `adcontextprotocol/actions/ladon/review@${REVIEW}`);
  // Require an explicit policy even though the audited runtime defaults false.
  // This rejects a partial migration or later regression in any invocation.
  assert.equal(step.with?.["auto-approve"], "false");
  assert.equal(step.if, "steps.workflow-mod.outputs.modified != 'true'");
  assert.equal(step["continue-on-error"], undefined);
}

function collectInvocations(value, location, result = []) {
  if (!value || typeof value !== "object") return result;
  if (typeof value.uses === "string" && /ladon/i.test(value.uses)) {
    result.push({ location, step: value });
  }
  for (const [key, child] of Object.entries(value)) {
    collectInvocations(child, `${location}.${key}`, result);
  }
  return result;
}

function runGate(paths, failedApi = false) {
  const directory = mkdtempSync(join(tmpdir(), "ladon-gate-"));
  const output = join(directory, "output");
  try {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `gh() { ${failedApi ? "return 1;" : 'printf "%s\\n" "$TEST_PATHS";'} }; ${gate.run}`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          TEST_PATHS: paths.join("\n"),
          PR_NUMBER: "1",
          REPO: "adcontextprotocol/test",
          GITHUB_OUTPUT: output,
        },
      },
    );
    return { ...result, output: result.status === 0 ? read(output) : "" };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("all tracked workflow and local-action Ladon sites are inventoried, pinned, and disabled", () => {
  const files = git(
    "ls-files",
    "-z",
    "--",
    ".github/workflows",
    ":(glob)**/action.yml",
    ":(glob)**/action.yaml",
  )
    .split("\0")
    .filter(
      (file) =>
        /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file) ||
        /(^|\/)action\.ya?ml$/.test(file),
    );
  const sites = files.flatMap((file) =>
    collectInvocations(parse(read(file)), file),
  );
  assert.equal(
    sites.length,
    1,
    "new invocation sites require an explicit human-reviewed policy update",
  );
  assert.match(
    sites[0].location,
    /^\.github\/workflows\/ai-review\.yml\.jobs\.code_review\.steps\./,
  );
  sites.forEach(({ step }) => validateInvocation(step));
});

test("consumer contract rejects missing, malformed, enabled, boolean, and expression inputs", () => {
  for (const value of [
    undefined,
    null,
    "",
    "true",
    true,
    false,
    "False",
    "off",
    " false",
    "${{ inputs.auto-approve }}",
  ]) {
    const changed = structuredClone(invocation);
    if (value === undefined) delete changed.with["auto-approve"];
    else changed.with["auto-approve"] = value;
    assert.throws(() => validateInvocation(changed), String(value));
  }
  for (const pin of ["ladon/review/v1", "main", IMPLEMENTATION]) {
    assert.throws(() =>
      validateInvocation({
        ...invocation,
        uses: `adcontextprotocol/actions/ladon/review@${pin}`,
      }),
    );
  }
});

test("trusted base checkout, draft guard, modification gate, and COMMENT-only human notice remain", async () => {
  assert.ok(workflow.on.pull_request_target);
  assert.equal(workflow.on.pull_request, undefined);
  assert.deepEqual(workflow.on.pull_request_target["paths-ignore"], [
    ".github/workflows/ai-review.yml",
    "LADON.md",
  ]);
  assert.match(
    workflow.jobs.code_review.if,
    /github\.event\.pull_request\.draft == false/,
  );
  assert.equal(workflow.jobs.code_review["continue-on-error"], undefined);
  assert.equal(steps[0].with.ref, "${{ github.event.pull_request.base.sha }}");
  assert.ok(steps.indexOf(gate) < steps.indexOf(invocation));
  assert.equal(notice.if, "steps.workflow-mod.outputs.modified == 'true'");
  const calls = [];
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction("github", "context", "process", notice.with.script)(
    { rest: { pulls: { createReview: async (review) => calls.push(review) } } },
    {
      repo: { owner: "adcontextprotocol", repo: "test" },
      issue: { number: 1 },
    },
    { env: { MODIFIED_FILES: ".github/workflows/ai-review.yml" } },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].event, "COMMENT");
  assert.match(calls[0].body, /human reviewer/i);
});

for (const files of [
  [".github/workflows/ai-review.yml"],
  ["LADON.md"],
  [
    ".github/workflows/ai-review.yml",
    ".github/ladon-policy.test.cjs",
    "src/example.ts",
  ],
  ["LADON.md", "src/example.ts"],
]) {
  test(`existing shell gate holds pure/mixed review-system changes: ${files.join(", ")}`, () => {
    const result = runGate(files);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /^modified=true$/m);
  });
}

test("file API failure cannot proceed past the workflow-modification gate", () => {
  assert.notEqual(runGate([], true).status, 0);
});

test("ordinary source review proceeds only through the disabled invocation", () => {
  const result = runGate(["src/example.ts"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.output, /^modified=false$/m);
  validateInvocation(invocation);
});

test("reviewed checkout and every nested Ladon implementation are immutable and byte-identical", () => {
  assert.equal(git("-C", actions, "rev-parse", "HEAD"), REVIEW);
  const orchestrator = parse(read(join(actions, "ladon/review/action.yml")));
  for (const name of ["review", "setup", "arbiter"]) {
    const manifest = parse(read(join(actions, `ladon/${name}/action.yml`)));
    assert.equal(manifest.inputs["auto-approve"].default, "false");
  }
  const nested = collectInvocations(orchestrator, "review");
  assert.deepEqual(
    nested.map(({ step }) => step.uses),
    [
      `adcontextprotocol/actions/ladon/setup@${IMPLEMENTATION}`,
      `adcontextprotocol/actions/ladon/reviewer@${REVIEWER}`,
      `adcontextprotocol/actions/ladon/arbiter@${IMPLEMENTATION}`,
    ],
  );
  for (const name of ["setup", "arbiter", "reviewer"]) {
    const pin = name === "reviewer" ? REVIEWER : IMPLEMENTATION;
    // Compare the full action directory, including executable dist bundles.
    // Reviewer's later tests/docs may change; only runtime files are compared.
    const paths =
      name === "reviewer"
        ? ["ladon/reviewer/action.yml", "ladon/reviewer/src"]
        : [
            `ladon/${name}/action.yml`,
            `ladon/${name}/src`,
            `ladon/${name}/dist`,
          ];
    git("-C", actions, "diff", "--exit-code", pin, REVIEW, "--", ...paths);
  }
});

test("read-only policy CI runs exact-head parsing and upstream approval/race regressions without secrets", () => {
  const ci = parse(read(".github/workflows/ladon-policy.yml"));
  assert.ok(Object.hasOwn(ci.on, "pull_request"));
  assert.equal(ci.on.pull_request_target, undefined);
  assert.deepEqual(ci.permissions, { contents: "read" });
  assert.doesNotMatch(read(".github/workflows/ladon-policy.yml"), /secrets\./);
  const checkouts = ci.jobs.policy.steps.filter((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  assert.equal(checkouts.length, 2);
  assert.equal(
    checkouts[0].with.ref,
    "${{ github.event.pull_request.head.sha || github.sha }}",
  );
  assert.equal(checkouts[1].with.ref, REVIEW);
  assert.equal(checkouts[1].with.repository, "adcontextprotocol/actions");
  checkouts.forEach((step) =>
    assert.equal(step.with["persist-credentials"], false),
  );
  const run = ci.jobs.policy.steps.map((step) => step.run || "").join("\n");
  assert.match(run, /node --test \.github\/ladon-policy\.test\.cjs/);
  assert.match(run, /npm test -- --force/);
  assert.equal(ci.jobs.policy.if, undefined);
  assert.equal(ci.jobs.policy["continue-on-error"], undefined);
  ci.jobs.policy.steps.forEach((step) => {
    assert.equal(step.if, undefined);
    assert.equal(step["continue-on-error"], undefined);
  });
});

test("human hold and two distinct protection bypasses remain visible", () => {
  assert.match(read(".github/workflows/ai-review.yml"), /HUMAN MERGE HOLD/);
  const adoption = read(".github/LADON-ADOPTION.md");
  for (const marker of [
    "#2911",
    "#7521",
    "exact-head",
    "PR author",
    "CODEOWNERS",
    "ordinary authors",
    "older runs",
    "not fixed",
  ]) {
    assert.ok(
      adoption.includes(marker),
      `missing hold/audit evidence: ${marker}`,
    );
  }
});

test("local, reusable and direct-subaction Ladon sites cannot evade inventory", () => {
  for (const uses of [
    "./ladon/review",
    "./.github/workflows/ladon-review.yml",
    "adcontextprotocol/actions/ladon/setup@" + IMPLEMENTATION,
    "adcontextprotocol/actions/ladon/arbiter@" + IMPLEMENTATION,
  ]) {
    const step = { uses, with: { "auto-approve": "true" } };
    const sites = collectInvocations(
      { jobs: { added: { steps: [step] } } },
      "new-workflow.yml",
    );
    assert.equal(sites.length, 1, `uninventoried invocation: ${uses}`);
    assert.throws(() => validateInvocation(sites[0].step));
  }
});
