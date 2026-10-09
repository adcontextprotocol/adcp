const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync, spawnSync } = require("node:child_process");
const YAML = require("yaml");
const root = path.resolve(__dirname, "..");
const workflow = YAML.parse(
  fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8"),
);
const step = (name) =>
  workflow.jobs.release.steps.find((step) => step.name === name);
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const ref = "refs/heads/changeset-release/main";
const repositoryUrl = "https://github.com/adcontextprotocol/adcp.git";

test("the intercepted push shape matches the pinned Changesets producer", () => {
  const source = fs.readFileSync(
    path.join(root, "tests/fixtures/changesets-action-v2.1.2/github-push.ts"),
    "utf8",
  );
  const args = JSON.parse(
    source
      .match(/await exec\("git", (\[.*\]), options\)/)[1]
      .replace("`HEAD:${branch}`", '"HEAD:changeset-release/main"'),
  );
  assert.deepEqual(args, [
    "push",
    "origin",
    "HEAD:changeset-release/main",
    "--force",
  ]);
  assert.equal(
    step("Create Release Pull Request or Tag Release").env.GH_TOKEN,
    "${{ steps.changesets-token.outputs.token }}",
  );
  assert.equal(
    step("Reconcile Changesets transaction").if,
    "always() && steps.release-artifacts.outputs.has_release_artifacts == 'false'",
  );
  assert.equal(
    step("Retain Changesets reconciliation evidence").if,
    step("Reconcile Changesets transaction").if,
  );
});

function gitStub() {
  const fs = require("node:fs");
  const { spawnSync, execFileSync } = require("node:child_process");
  const args = process.argv.slice(2);
  const env = process.env;
  const command = (extra) =>
    execFileSync(env.REAL_GIT, extra, { encoding: "utf8" }).trim();
  const update = (ref, oid) =>
    command(["--git-dir", env.REMOTE_REPO, "update-ref", ref, oid]);
  const rollback = args.includes("core.hooksPath=/dev/null");
  const push = args.includes("push");
  if (
    env.ENFORCE_GIT_AUTH &&
    args.some((arg) => ["ls-remote", "fetch", "push"].includes(arg))
  ) {
    const count = Number(env.GIT_CONFIG_COUNT);
    const expected =
      "AUTHORIZATION: basic " +
      Buffer.from(
        "x-access-token:" + (env.EXPECT_GIT_TOKEN || env.GH_TOKEN),
      ).toString("base64");
    if (
      env[`GIT_CONFIG_VALUE_${count - 2}`] !== "" ||
      env[`GIT_CONFIG_VALUE_${count - 1}`] !== expected ||
      env[`GIT_CONFIG_KEY_${count - 1}`] !==
        `http.${env.REPOSITORY_URL}.extraheader`
    )
      throw Error("Missing fresh command-scoped Git credentials");
  }
  if (args[0] === "remote" && args[1] === "get-url") {
    console.log(
      env.FAULT === "wrong-origin" ||
        (env.FAULT === "wrong-push-url" && args.includes("--push"))
        ? "https://github.com/other/unrelated.git"
        : env.FAULT === "multiple-push-urls" && args.includes("--push")
          ? `${env.REPOSITORY_URL}\n${env.REPOSITORY_URL}`
          : env.REPOSITORY_URL,
    );
    return;
  }
  if (
    args[0] === "config" &&
    args.includes("--get-regexp") &&
    env.FAULT === "url-rewrite"
  ) {
    console.log("url.https://other.invalid/.insteadof https://github.com/");
    return;
  }
  if (args[0] === "ls-remote" && fs.existsSync("ref-read-error")) {
    fs.unlinkSync("ref-read-error");
    process.exit(1);
  }
  if (args[0] === "ls-remote" && env.FAULT === "lookup") process.exit(1);
  if (push) {
    fs.appendFileSync("git-calls.jsonl", JSON.stringify(args) + "\n");
    if (!args.some((arg) => arg.startsWith("--force-with-lease=")))
      throw Error("Unleased branch mutation");
    if (rollback && env.FAULT === "rollback-lease")
      update(env.RELEASE_REF, env.THIRD_SHA);
    if (rollback && env.FAULT === "rollback-failure") process.exit(1);
    if (rollback && env.FAULT === "rollback-timeout-before")
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
    if (!rollback && env.FAULT === "push-lease")
      update(env.RELEASE_REF, env.THIRD_SHA);
    if (!rollback && env.FAULT === "push-reject") process.exit(1);
  }
  const result = spawnSync(
    env.REAL_GIT,
    args.map((arg) => (arg === env.REPOSITORY_URL ? env.REMOTE_REPO : arg)),
    {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    },
  );
  if (push) {
    const value = command(["ls-remote", "origin", env.RELEASE_REF]).split(
      "\t",
    )[0];
    const prs = JSON.parse(fs.readFileSync("prs.json", "utf8"));
    for (const pr of prs) {
      if (value) pr.head.sha = value;
      else pr.state = "closed";
    }
    fs.writeFileSync("prs.json", JSON.stringify(prs));
    if (
      !rollback &&
      [
        "drift",
        "rollback-lease",
        "rollback-failure",
        "rollback-lost-ack",
        "api-after-push",
        "rollback-timeout-before",
        "rollback-timeout-after",
      ].includes(env.FAULT)
    )
      update("refs/heads/main", env.ADVANCED_SHA);
    if (!rollback && env.FAULT === "api-after-push")
      fs.writeFileSync("api-down", "1");
    if (!rollback && env.FAULT === "ref-read-error")
      fs.writeFileSync("ref-read-error", "1");
    if (
      (!rollback && env.FAULT === "push-timeout") ||
      (rollback && env.FAULT === "rollback-timeout-after")
    )
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
    if (
      (!rollback && env.FAULT === "lost-ack") ||
      (rollback && env.FAULT === "rollback-lost-ack")
    )
      process.exit(1);
  }
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  process.exit(result.status ?? 1);
}
function ghStub() {
  const fs = require("node:fs");
  const args = process.argv.slice(2);
  const env = process.env;
  fs.appendFileSync("gh-calls.jsonl", JSON.stringify(args) + "\n");
  if (env.FAULT === "api" || fs.existsSync("api-down")) process.exit(1);
  if (!env.GH_TOKEN) process.exit(1);
  if (env.FAULT === "api-timeout")
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
  const prs = JSON.parse(fs.readFileSync("prs.json", "utf8"));
  const url = args.find((arg) => arg.startsWith("/repos/"));
  let result;
  if (args.includes("graphql")) {
    if (env.FAULT === "draft-failure") process.exit(1);
    const pr = prs.find((pr) => args.includes(`id=${pr.node_id}`));
    if (!pr) throw Error("Wrong Draft target");
    if (env.FAULT !== "draft-noop") pr.draft = true;
    fs.writeFileSync("prs.json", JSON.stringify(prs));
    result = {
      data: {
        convertPullRequestToDraft: {
          pullRequest: { id: pr.node_id, isDraft: pr.draft },
        },
      },
    };
    if (env.FAULT === "draft-response")
      result = { errors: [{ message: "mutation rejected" }] };
    if (env.FAULT === "draft-lost-ack") process.exit(1);
  } else if (url.endsWith("/comments")) {
    if (env.FAULT === "hold-failure") process.exit(1);
    const comments = JSON.parse(fs.readFileSync("comments.json", "utf8"));
    result = {
      id: comments.length + 1,
      body: args.find((arg) => arg.startsWith("body=")).slice(5),
      issue_url: "https://api.github.com" + url.replace(/\/comments$/, ""),
    };
    comments.push(result);
    // Each isolated fixture invokes this mock synchronously. Replace the
    // initialized store atomically without an existence-check/write gap.
    fs.writeFileSync("comments.next.json", JSON.stringify(comments), { flag: "wx" });
    fs.renameSync("comments.next.json", "comments.json");
    if (env.FAULT === "hold-lost-ack") process.exit(1);
    if (env.FAULT === "hold-response") result.body = "not the hold";
    if (env.FAULT === "hold-wrong-issue")
      result.issue_url = "https://api.github.com/repos/other/repo/issues/1";
  } else if (url.includes("/issues/comments/")) {
    if (env.FAULT === "hold-read") process.exit(1);
    result = JSON.parse(fs.readFileSync("comments.json", "utf8")).find(
      (comment) => String(comment.id) === url.split("/").at(-1),
    );
    if (env.FAULT === "hold-read-body") result.body = "changed hold";
  } else if (url.includes("?"))
    result = [prs.filter((pr) => pr.state === "open")];
  else result = prs.find((pr) => url.endsWith(`/pulls/${pr.number}`));
  console.log(JSON.stringify(result));
}
function fixture(t, existing = true, pre = { mode: "pre", tag: "rc" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "changesets-fence-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (file, bytes) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), bytes);
  };
  const git = (...args) =>
    execFileSync(realGit, args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgSign", "false");
  write("package.json", '{"version":"3.2.0-rc.3"}');
  git("add", "package.json");
  if (pre !== null) {
    write(".changeset/pre.json", JSON.stringify(pre));
    git("add", ".changeset/pre.json");
  }
  git("commit", "-qm", "Initial");
  const initial = git("rev-parse", "HEAD");
  const commit = (file, text) => {
    write(file, text);
    git("add", file);
    git("commit", "-qm", text);
    return git("rev-parse", "HEAD");
  };
  const prior = commit("release", "previous generated release");
  git("checkout", "--detach", initial);
  const tested = commit("main", "tested main");
  const advanced = commit("later", "advanced main");
  const third = commit("third", "third-party ref");
  git("checkout", "--detach", tested);
  const candidate = commit("release", "new generated release");
  const bare = path.join(dir, "remote.git");
  git("init", "--bare", "-q", bare);
  git("remote", "add", "origin", bare);
  git(
    "push",
    "-q",
    "origin",
    `${tested}:refs/heads/main`,
    `${advanced}:refs/heads/advanced`,
    `${third}:refs/heads/third`,
    ...(existing ? [`${prior}:${ref}`] : []),
  );
  git("checkout", "--detach", tested);
  const pr = {
    number: 8,
    node_id: "PR_8",
    title:
      pre?.mode === "pre"
        ? `Version Packages (${pre.tag})`
        : "Version Packages",
    state: "open",
    draft: false,
    head: {
      ref: "changeset-release/main",
      sha: prior,
      repo: { full_name: "adcontextprotocol/adcp" },
    },
    base: { ref: "main", repo: { full_name: "adcontextprotocol/adcp" } },
  };
  write("prs.json", JSON.stringify(existing ? [pr] : []));
  write("comments.json", "[]");
  write("git-calls.jsonl", "");
  write("gh-calls.jsonl", "");
  for (const name of ["check-release-state.cjs", "fence-changesets.cjs"])
    write(`scripts/${name}`, fs.readFileSync(path.join(root, "scripts", name)));
  for (const [name, stub] of [
    ["git", gitStub],
    ["gh", ghStub],
  ]) {
    write(`bin/${name}`, `#!${process.execPath}\n(${stub.toString()})();`);
    fs.chmodSync(path.join(dir, "bin", name), 0o755);
  }
  const temporary = path.join(dir, "temp");
  const wrapper = path.join(temporary, "release-hooks");
  const env = {
    ...process.env,
    PATH: `${dir}/bin:${process.env.PATH}`,
    RUNNER_TEMP: temporary,
    GITHUB_PATH: path.join(dir, "github-path"),
    GITHUB_STEP_SUMMARY: path.join(dir, "summary"),
    TESTED_SHA: tested,
    PUBLICATION_BRANCH: "main",
    GITHUB_REPOSITORY: "adcontextprotocol/adcp",
    GH_TOKEN: "fixture-token",
    ENFORCE_GIT_AUTH: "1",
    REAL_GIT: realGit,
    REPOSITORY_URL: repositoryUrl,
    REMOTE_REPO: bare,
    RELEASE_REF: ref,
    ADVANCED_SHA: advanced,
    THIRD_SHA: third,
  };
  const run = (cmd, args, extra = {}) =>
    spawnSync(cmd, args, {
      cwd: dir,
      env: { ...env, ...extra },
      encoding: "utf8",
    });
  const install = (extra) =>
    run("bash", ["-c", step("Fence Changesets mutations").run], extra);
  const push = (
    extra,
    args = ["push", "origin", "HEAD:changeset-release/main", "--force"],
  ) => {
    git("-c", "core.hooksPath=/dev/null", "checkout", "--detach", candidate);
    return run(path.join(wrapper, "git"), args, extra);
  };
  const finalize = (extra) =>
    run("bash", ["-c", step("Reconcile Changesets transaction").run], {
      CHANGESETS_OUTCOME: "success",
      ...extra,
    });
  const prs = () =>
    JSON.parse(fs.readFileSync(path.join(dir, "prs.json"), "utf8"));
  const state = () =>
    JSON.parse(fs.readFileSync(path.join(wrapper, "state.json"), "utf8"));
  const observed = () => git("ls-remote", "origin", ref).split("\t")[0] || null;
  const calls = () =>
    fs
      .readFileSync(path.join(dir, "git-calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
  return {
    run,
    wrapper,
    dir,
    write,
    git,
    install,
    push,
    finalize,
    prs,
    state,
    observed,
    calls,
    prior,
    tested,
    candidate,
    advanced,
    third,
    pr,
    bare,
  };
}
function ok(result) {
  assert.equal(result.status, 0, result.stderr);
}
function stopped(result) {
  assert.notEqual(result.status, 0, result.stdout);
}

test("ready existing PR is verified Draft before a leased push and stays Draft on success", (t) => {
  const f = fixture(t);
  ok(f.install());
  assert.equal(f.prs()[0].draft, true);
  assert.equal(f.observed(), f.prior);
  ok(f.push());
  assert.equal(f.observed(), f.candidate);
  ok(f.finalize());
  assert.equal(f.state().status, "complete");
  assert.equal(f.prs()[0].draft, true);
  assert.deepEqual(f.calls()[0], [
    "push",
    repositoryUrl,
    `${f.candidate}:${ref}`,
    `--force-with-lease=${ref}:${f.prior}`,
  ]);
  assert.equal(
    step("Create Release Pull Request or Tag Release").with["pr-draft"],
    "always",
  );
});
test("no PR/ref creates with an empty lease; action-created PR must be Draft", (t) => {
  const f = fixture(t, false);
  ok(f.install());
  ok(f.push());
  assert.equal(f.calls()[0].at(-1), `--force-with-lease=${ref}:`);
  f.write(
    "prs.json",
    JSON.stringify([
      { ...f.pr, draft: true, head: { ...f.pr.head, sha: f.candidate } },
    ]),
  );
  ok(f.finalize());
  assert.equal(f.state().status, "complete");
});
for (const fault of [
  "api",
  "lookup",
  "draft-failure",
  "draft-noop",
  "draft-response",
  "draft-lost-ack",
  "hold-failure",
  "hold-lost-ack",
  "hold-response",
  "hold-wrong-issue",
  "hold-read",
  "hold-read-body",
  "wrong-origin",
  "wrong-push-url",
  "multiple-push-urls",
  "url-rewrite",
])
  test(`preparation fails closed before a branch write: ${fault}`, (t) => {
    const f = fixture(t);
    stopped(f.install({ FAULT: fault }));
    assert.deepEqual(f.calls(), []);
    assert.equal(f.observed(), f.prior);
  });
for (const kind of [
  "duplicate",
  "orphan",
  "missing-ref",
  "wrong-head",
  "wrong-repository",
  "wrong-title",
  "wrong-tag",
  "missing-suffix",
  "malformed",
])
  test(`ambiguous capture stops: ${kind}`, (t) => {
    const f = fixture(t);
    if (kind === "duplicate")
      f.write(
        "prs.json",
        JSON.stringify([f.pr, { ...f.pr, number: 9, node_id: "PR_9" }]),
      );
    if (kind === "orphan") f.write("prs.json", "[]");
    if (kind === "missing-ref")
      f.git("--git-dir", f.bare, "update-ref", "-d", ref);
    if (kind === "wrong-head")
      f.write(
        "prs.json",
        JSON.stringify([{ ...f.pr, head: { ...f.pr.head, sha: f.third } }]),
      );
    if (kind === "wrong-repository")
      f.write(
        "prs.json",
        JSON.stringify([
          {
            ...f.pr,
            head: { ...f.pr.head, repo: { full_name: "other/repository" } },
          },
        ]),
      );
    if (kind === "wrong-title")
      f.write(
        "prs.json",
        JSON.stringify([{ ...f.pr, title: "Unrelated pull request" }]),
      );
    if (kind === "wrong-tag" || kind === "missing-suffix")
      f.write(
        "prs.json",
        JSON.stringify([
          {
            ...f.pr,
            title:
              kind === "wrong-tag"
                ? "Version Packages (beta)"
                : "Version Packages",
          },
        ]),
      );
    if (kind === "malformed") f.write("prs.json", '[{"state":"open"}]');
    stopped(f.install());
    assert.deepEqual(f.calls(), []);
  });
test("main advances during long generation: no push, existing PR remains Draft", (t) => {
  const f = fixture(t);
  ok(f.install());
  f.git("--git-dir", f.bare, "update-ref", "refs/heads/main", f.advanced);
  stopped(f.push());
  assert.deepEqual(f.calls(), []);
  assert.equal(f.observed(), f.prior);
  assert.equal(f.prs()[0].draft, true);
});
for (const existing of [true, false])
  for (const fault of [
    "drift",
    "lost-ack",
    "rollback-lost-ack",
    "ref-read-error",
  ])
    test(`${existing ? "existing" : "new"} ref is restored with an exact lease after ${fault}`, (t) => {
      const f = fixture(t, existing);
      ok(f.install());
      stopped(f.push({ FAULT: fault }));
      assert.equal(f.observed(), existing ? f.prior : null);
      assert.equal(f.state().restored, true);
      assert.equal(f.calls().length, 2);
      assert.equal(
        f.calls()[1].at(-1),
        `--force-with-lease=${ref}:${f.candidate}`,
      );
      if (existing) {
        assert.equal(f.prs()[0].draft, true);
        assert.equal(f.prs()[0].head.sha, f.prior);
      }
      const before = f.calls().length;
      stopped(f.finalize({ CHANGESETS_OUTCOME: "failure" }));
      stopped(f.push());
      assert.equal(
        f.calls().length,
        before,
        "replay must not mutate any branch",
      );
    });
for (const fault of ["rollback-lease", "rollback-failure", "api-after-push"])
  test(`failed restoration retains containment and durable evidence: ${fault}`, (t) => {
    const f = fixture(t);
    ok(f.install());
    stopped(f.push({ FAULT: fault }));
    assert.equal(f.prs()[0].draft, true);
    assert.equal(f.state().status, "quarantined");
    assert.ok(f.state().errors.length);
    assert.ok(
      fs
        .readFileSync(path.join(f.dir, "summary"), "utf8")
        .includes("reconciliation"),
    );
    assert.equal(
      f.observed(),
      fault === "rollback-lease"
        ? f.third
        : fault === "api-after-push"
          ? f.prior
          : f.candidate,
    );
    if (fault === "rollback-lease") {
      const count = f.calls().length;
      stopped(f.finalize());
      assert.equal(f.observed(), f.third);
      assert.equal(f.calls().length, count);
    }
  });
test("concurrent branch update loses initial lease without overwriting it", (t) => {
  const f = fixture(t);
  ok(f.install());
  stopped(f.push({ FAULT: "push-lease" }));
  assert.equal(f.observed(), f.third);
  assert.equal(f.calls().length, 1);
  assert.equal(f.prs()[0].draft, true);
});
test("rejected push is a verified no-op and stays quarantined", (t) => {
  const f = fixture(t);
  ok(f.install());
  stopped(f.push({ FAULT: "push-reject" }));
  assert.equal(f.observed(), f.prior);
  assert.equal(f.state().restored, true);
  assert.equal(f.calls().length, 1);
});
for (const args of [
  [
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "origin",
    "HEAD:changeset-release/main",
    "--force",
  ],
  ["-C", ".", "push", "origin", "HEAD:changeset-release/main", "--force"],
  ["push", "other", "HEAD:changeset-release/main", "--force"],
  ["push", "origin", "HEAD:unrelated", "--force"],
  ["push", "origin", "HEAD:changeset-release/main", "--force", "--delete"],
])
  test(`unexpected push is refused: ${args.join(" ")}`, (t) => {
    const f = fixture(t);
    ok(f.install());
    stopped(f.push({}, args));
    assert.deepEqual(f.calls(), []);
  });
test("drift after the push and action API call is reconciled by the installed finalizer", (t) => {
  const f = fixture(t);
  ok(f.install());
  ok(f.push());
  f.git("--git-dir", f.bare, "update-ref", "refs/heads/main", f.advanced);
  stopped(f.finalize());
  assert.equal(f.observed(), f.prior);
  assert.equal(f.prs()[0].draft, true);
});
test("action failure after successful push is restored, including PR API outage", (t) => {
  const f = fixture(t);
  ok(f.install());
  ok(f.push());
  stopped(f.finalize({ CHANGESETS_OUTCOME: "failure", FAULT: "api" }));
  assert.equal(f.observed(), f.prior);
  assert.equal(f.prs()[0].draft, true);
  assert.ok(f.state().errors.length);
});
test("replay after success never pushes twice", (t) => {
  const f = fixture(t);
  ok(f.install());
  ok(f.push());
  ok(f.finalize());
  ok(f.finalize());
  stopped(f.push());
  assert.equal(f.calls().length, 1);
});
test("pinned read-only Git identity probes still work through the installed wrapper", (t) => {
  const f = fixture(t);
  ok(f.install());
  const source = fs.readFileSync(
    path.join(root, "tests/fixtures/changesets-action-v2.1.2/github-push.ts"),
    "utf8",
  );
  const probes = [
    ...source.matchAll(/getExecOutput\(\s*"git",\s*(\[[^\]]+\])/g),
  ].map((match) => JSON.parse(match[1]));
  assert.equal(probes.length, 2);
  for (const probe of probes)
    ok(f.run(path.join(f.wrapper, "git"), [...probe]));
  assert.equal(f.calls().length, 0);
});
test("completed replay cannot roll back a later human Ready transition", (t) => {
  const f = fixture(t);
  ok(f.install());
  ok(f.push());
  ok(f.finalize());
  f.write(
    "prs.json",
    JSON.stringify(f.prs().map((pr) => ({ ...pr, draft: false }))),
  );
  stopped(f.finalize());
  assert.equal(f.calls().length, 1);
  assert.equal(f.prs()[0].draft, false);
  assert.equal(f.observed(), f.candidate);
});
for (const changed of ["ready", "missing-ref", "new-pr", "api"])
  test(`state changes during generation stop before push: ${changed}`, (t) => {
    const f = fixture(t, changed !== "new-pr");
    ok(f.install());
    if (changed === "ready")
      f.write(
        "prs.json",
        JSON.stringify(f.prs().map((pr) => ({ ...pr, draft: false }))),
      );
    if (changed === "missing-ref")
      f.git("--git-dir", f.bare, "update-ref", "-d", ref);
    if (changed === "new-pr") f.write("prs.json", JSON.stringify([f.pr]));
    stopped(f.push(changed === "api" ? { FAULT: "api" } : {}));
    assert.equal(f.calls().length, 0);
  });
test("new ref is conditionally removed if action fails before creating its PR", (t) => {
  const f = fixture(t, false);
  ok(f.install());
  ok(f.push());
  stopped(f.finalize({ CHANGESETS_OUTCOME: "failure", FAULT: "api" }));
  assert.equal(f.observed(), null);
  assert.equal(f.state().restored, true);
  assert.ok(f.state().errors.length);
});
test("a new Ready PR from a broken action is quarantined before deleting only its owned new ref", (t) => {
  const f = fixture(t, false);
  ok(f.install());
  ok(f.push());
  f.write(
    "prs.json",
    JSON.stringify([{ ...f.pr, head: { ...f.pr.head, sha: f.candidate } }]),
  );
  stopped(f.finalize());
  assert.equal(f.observed(), null);
  assert.equal(f.prs()[0].draft, true);
  assert.equal(f.prs()[0].state, "closed");
});
test("an empty initial lease never overwrites a concurrently created ref", (t) => {
  const f = fixture(t, false);
  ok(f.install());
  stopped(f.push({ FAULT: "push-lease" }));
  assert.equal(f.observed(), f.third);
  assert.equal(f.calls().length, 1);
});
for (const fault of [
  "push-timeout",
  "rollback-timeout-before",
  "rollback-timeout-after",
])
  test(`bounded subprocess timeout reconciles a possibly applied write: ${fault}`, (t) => {
    const f = fixture(t);
    ok(f.install());
    stopped(f.push({ FAULT: fault, CHANGESETS_FENCE_TIMEOUT_MS: "1000" }));
    assert.equal(
      f.observed(),
      fault === "rollback-timeout-before" ? f.candidate : f.prior,
    );
    assert.equal(f.prs()[0].draft, true);
    assert.equal(f.state().status, "quarantined");
    stopped(f.finalize({ CHANGESETS_OUTCOME: "failure" }));
    assert.equal(f.observed(), f.prior);
  });
test("API timeout before mutation leaves the release ref unchanged", (t) => {
  const f = fixture(t);
  stopped(
    f.install({ FAULT: "api-timeout", CHANGESETS_FENCE_TIMEOUT_MS: "1000" }),
  );
  assert.equal(f.observed(), f.prior);
  assert.equal(f.calls().length, 0);
});
test("a changed push target during generation cannot redirect the leased write", (t) => {
  const f = fixture(t);
  ok(f.install());
  stopped(f.push({ FAULT: "wrong-push-url" }));
  assert.equal(f.observed(), f.prior);
  assert.equal(f.calls().length, 0);
});
test("reconciliation replay reports a later third-party ref as unrestored without overwriting it", (t) => {
  const f = fixture(t);
  ok(f.install());
  stopped(f.push({ FAULT: "drift" }));
  assert.equal(f.state().restored, true);
  f.git("--git-dir", f.bare, "update-ref", ref, f.third);
  const before = f.calls().length;
  stopped(f.finalize());
  assert.equal(f.state().restored, false);
  assert.equal(f.observed(), f.third);
  assert.equal(f.calls().length, before);
});
test("reconciliation uses its fresh token instead of inherited expired Git headers", (t) => {
  const f = fixture(t);
  ok(f.install());
  ok(f.push());
  stopped(
    f.finalize({
      CHANGESETS_OUTCOME: "failure",
      GH_TOKEN: "refreshed-token",
      EXPECT_GIT_TOKEN: "refreshed-token",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `http.${repositoryUrl}.extraheader`,
      GIT_CONFIG_VALUE_0: "expired-header",
    }),
  );
  assert.equal(f.observed(), f.prior);
  assert.equal(f.state().restored, true);
  assert.doesNotMatch(
    JSON.stringify(f.state()),
    /refreshed-token|expired-header|AUTHORIZATION/,
  );
});
test("failed token refresh never falls back to expired credentials; later reconciliation is resumable", (t) => {
  const f = fixture(t);
  ok(f.install());
  ok(f.push());
  stopped(f.finalize({ CHANGESETS_OUTCOME: "failure", GH_TOKEN: "" }));
  assert.equal(f.observed(), f.candidate);
  assert.equal(f.state().restored, false);
  stopped(
    f.finalize({ CHANGESETS_OUTCOME: "failure", GH_TOKEN: "refreshed-token" }),
  );
  assert.equal(f.observed(), f.prior);
});
test("mutation and reconciliation mint separate tokens after setup, including failed actions", () => {
  const steps = workflow.jobs.release.steps;
  const index = (name) => steps.findIndex((step) => step.name === name);
  assert.ok(
    index("Mint Changesets mutation token") > index("Install Dependencies"),
  );
  assert.ok(
    index("Mint Changesets mutation token") <
      index("Fence Changesets mutations"),
  );
  assert.match(step("Mint Changesets reconciliation token").if, /^always\(\)/);
  assert.equal(
    step("Mint Changesets reconciliation token")["timeout-minutes"],
    2,
  );
  assert.equal(step("Mint Changesets mutation token")["timeout-minutes"], 2);
  assert.equal(
    step("Reconcile Changesets transaction").env.GH_TOKEN,
    "${{ steps.reconciliation-token.outputs.token }}",
  );
  assert.equal(
    step("Create Release Pull Request or Tag Release")["timeout-minutes"],
    40,
  );
});
for (const pre of [
  null,
  { mode: "exit", tag: "rc" },
  { mode: "pre", tag: "beta" },
])
  test(`expected PR title comes from the tested prerelease state: ${JSON.stringify(pre)}`, (t) => {
    const f = fixture(t, true, pre);
    ok(f.install());
    assert.equal(f.state().title, f.pr.title);
  });
test("working-tree prerelease edits cannot change the captured tested title", (t) => {
  const f = fixture(t);
  f.write(".changeset/pre.json", JSON.stringify({ mode: "pre", tag: "beta" }));
  ok(f.install());
  assert.equal(f.state().title, "Version Packages (rc)");
});
