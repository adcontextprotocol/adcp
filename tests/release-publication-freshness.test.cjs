// Publication-scoped freshness (`publication-current`) and the verify-release
// skip for a provenance-verified release merge (`verified-merge`).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const YAML = require("yaml");

const root = path.resolve(__dirname, "..");
const fence = path.join(root, "scripts/check-release-state.cjs");
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const version = "3.3.0-beta.0";
const release = YAML.parse(
  fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8"),
);

const gitIn = (cwd) => (...args) =>
  execFileSync(realGit, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

function writeIn(dir) {
  return (file, value) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), value);
  };
}

function identity(git) {
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
}

// A bare origin, a maintainer clone that advances main, and a separate
// publisher clone at the tested commit that has never seen the advance.
function freshnessFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publication-freshness-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bare = path.join(dir, "origin.git");
  const work = path.join(dir, "work");
  const publisher = path.join(dir, "publisher");
  execFileSync(realGit, ["init", "-q", "--bare", "-b", "main", bare]);
  fs.mkdirSync(work);
  const git = gitIn(work);
  const write = writeIn(work);
  git("init", "-q", "-b", "main");
  identity(git);
  git("remote", "add", "origin", bare);
  write("package.json", JSON.stringify({ version, dependencies: { a: "1.0.0" } }, null, 2));
  write(".changeset/pre.json", JSON.stringify({ mode: "pre", tag: "beta" }));
  write(`dist/schemas/${version}/index.json`, "{}\n");
  write(`dist/compliance/${version}/index.json`, "{}\n");
  for (const suffix of ["", ".sha256", ".sig", ".crt"])
    write(`dist/protocol/${version}.tgz${suffix}`, `signed${suffix}\n`);
  write("server/app.ts", "export {};\n");
  git("add", ".");
  git("commit", "-qm", "Version Packages");
  const tested = git("rev-parse", "HEAD");
  git("push", "-q", "origin", "main");
  execFileSync(realGit, ["clone", "-q", bare, publisher]);
  const commit = (files, message = "Later main commit") => {
    for (const [file, body] of Object.entries(files)) {
      if (body === null) git("rm", "-q", "--", file);
      else {
        write(file, body);
        git("add", "--", file);
      }
    }
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  const push = (sha, force = false) =>
    git("push", "-q", ...(force ? ["--force"] : []), "origin", `${sha}:refs/heads/main`);
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    GIT_CONFIG_NOSYSTEM: "1",
    TESTED_SHA: tested,
    PUBLICATION_BRANCH: "main",
  };
  const run = (mode, extra = {}, args = []) =>
    spawnSync(process.execPath, [fence, mode, ...args], {
      cwd: publisher,
      env: { ...env, ...extra },
      encoding: "utf8",
    });
  return { dir, git, publisher: gitIn(publisher), tested, commit, push, run };
}

const accepted = (result) => {
  assert.equal(result.status, 0, result.stderr);
};
const refused = (result, pattern) => {
  assert.notEqual(result.status, 0, result.stdout);
  if (pattern) assert.match(result.stderr, pattern);
};

test("publication-current accepts the identical tested head", (t) => {
  const f = freshnessFixture(t);
  const result = f.run("publication-current");
  accepted(result);
  assert.doesNotMatch(result.stdout, /accepted origin/);
});

test("publication-current accepts an unrelated descendant and logs the advance", (t) => {
  const f = freshnessFixture(t);
  f.commit({ "server/app.ts": "export const later = 1;\n" });
  // Dependency bumps edit package.json without changing the release version.
  const head = f.commit({
    "package.json": JSON.stringify({ version, dependencies: { a: "1.0.1" } }, null, 2),
  });
  f.push(head);
  assert.throws(() => f.publisher("cat-file", "-e", `${head}^{commit}`));
  const result = f.run("publication-current");
  accepted(result);
  assert.ok(
    result.stdout.includes(`advance from tested ${f.tested} to ${head} (2 commit(s))`),
    result.stdout,
  );
  assert.equal(f.publisher("rev-parse", "FETCH_HEAD"), head);
  // The strict fence still refuses the same advance.
  refused(f.run("current"), /Refusing stale tested SHA/);
});

for (const [name, files, pattern] of [
  ["a package version bump", { "package.json": JSON.stringify({ version: "3.3.0-beta.1" }) }, /package version changed/],
  ["a dist/protocol tarball change", { [`dist/protocol/${version}.tgz`]: "resigned\n" }, /release paths: dist\/protocol\/3\.3\.0-beta\.0\.tgz/],
  ["a protocol signature deletion", { [`dist/protocol/${version}.tgz.sig`]: null }, /release paths/],
  ["a schema tree change", { [`dist/schemas/${version}/extra.json`]: "{}\n" }, /release paths: dist\/schemas\//],
  ["a compliance tree change", { [`dist/compliance/${version}/index.json`]: "[]\n" }, /release paths: dist\/compliance\//],
  ["a .changeset/pre.json change", { ".changeset/pre.json": JSON.stringify({ mode: "exit" }) }, /release paths: \.changeset\/pre\.json/],
  ["a supersession marker", { ".changeset/release-supersession.json": "{}" }, /release paths: \.changeset\/release-supersession\.json/],
]) {
  test(`publication-current refuses ${name}`, (t) => {
    const f = freshnessFixture(t);
    f.commit({ "server/app.ts": "export const later = 1;\n" });
    f.push(f.commit(files));
    refused(f.run("publication-current"), pattern);
  });
}

test("publication-current refuses a move out of a protected path", (t) => {
  const f = freshnessFixture(t);
  fs.mkdirSync(path.join(f.dir, "work/archive"));
  f.git("mv", `dist/protocol/${version}.tgz.crt`, "archive/cert.crt");
  f.git("commit", "-qm", "Move certificate");
  f.push(f.git("rev-parse", "HEAD"));
  refused(f.run("publication-current"), /release paths: .*dist\/protocol\/3\.3\.0-beta\.0\.tgz\.crt/);
});

test("publication-current protects an explicitly named version too", (t) => {
  const f = freshnessFixture(t);
  f.push(f.commit({ "dist/schemas/3.0.27/index.json": "{}\n" }));
  accepted(f.run("publication-current"));
  refused(f.run("publication-current", {}, ["3.0.27"]), /release paths: dist\/schemas\/3\.0\.27\//);
});

test("publication-current refuses a head not descended from the tested commit", (t) => {
  const f = freshnessFixture(t);
  f.git("checkout", "-q", "--orphan", "rewrite");
  const sibling = f.commit({ "server/app.ts": "export const rewritten = 1;\n" }, "Rewritten history");
  f.push(sibling, true);
  refused(f.run("publication-current"), /not an ancestor/);
});

test("publication-current treats an ls-remote failure as an error", (t) => {
  const f = freshnessFixture(t);
  f.publisher("remote", "set-url", "origin", path.join(f.dir, "missing.git"));
  refused(f.run("publication-current"), /Publication stopped/);
});

test("publication-current refuses when the fetched head is not the advertised head", (t) => {
  const f = freshnessFixture(t);
  const pushed = f.commit({ "server/app.ts": "export const later = 1;\n" });
  f.push(pushed);
  // Advertise a commit the remote never serves; fetch returns the real head.
  const advertised = f.commit({ "server/app.ts": "export const unpushed = 1;\n" });
  const bin = path.join(f.dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!${process.execPath}\nconst args=process.argv.slice(2);if(args[0]==='ls-remote'){console.log(process.env.ADVERTISED+'\\t'+args.at(-1));process.exit(0);}const r=require('node:child_process').spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(r.status??1);`,
  );
  fs.chmodSync(path.join(bin, "git"), 0o755);
  refused(
    f.run("publication-current", { PATH: `${bin}:${process.env.PATH}`, ADVERTISED: advertised }),
    new RegExp(`fetched ${pushed}, not the advertised head`),
  );
});

test("publication-current keeps branch and SHA validation", (t) => {
  const f = freshnessFixture(t);
  refused(f.run("publication-current", { PUBLICATION_BRANCH: "feature" }), /supported release branch/);
  refused(f.run("publication-current", { TESTED_SHA: "abc" }), /exact tested SHA/);
});

// verified-merge: a squash release merge whose tree equals the reviewed head,
// with every gh API response stubbed from a JSON file.
function mergeFixture(t, { tamperTree = false, headFiles = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verified-merge-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = gitIn(dir);
  const write = writeIn(dir);
  git("init", "-q", "-b", "main");
  identity(git);
  write("package.json", JSON.stringify({ version: "3.3.0-alpha.9" }));
  write(".github/workflows/training-agent-storyboards.yml", "name: Training Agent Storyboards\n");
  write("scripts/run-storyboards-matrix.sh", "#!/usr/bin/env bash\n");
  git("add", ".");
  git("commit", "-qm", "Prior main");
  const base = git("rev-parse", "HEAD");
  write("package.json", JSON.stringify({ version }));
  for (const suffix of ["", ".sha256", ".sig", ".crt"])
    write(`dist/protocol/${version}.tgz${suffix}`, `signed${suffix}\n`);
  for (const [file, body] of Object.entries(headFiles)) write(file, body);
  git("add", ".");
  git("commit", "-qm", "Version Packages");
  const head = git("rev-parse", "HEAD");
  let tree = git("rev-parse", `${head}^{tree}`);
  if (tamperTree) {
    write("server/extra.ts", "export {};\n");
    git("add", ".");
    tree = execFileSync(realGit, ["write-tree"], { cwd: dir, encoding: "utf8" }).trim();
  }
  const source = execFileSync(
    realGit,
    ["commit-tree", tree, "-p", base, "-m", "Version Packages (#9)"],
    { cwd: dir, encoding: "utf8" },
  ).trim();
  git("checkout", "-q", "--detach", source);
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.copyFileSync(fence, path.join(dir, "scripts/check-release-state.cjs"));
  const job = (name, conclusion = "success") => ({ name, status: "completed", conclusion });
  const passingJobs = [
    ...["signals", "governance", "creative", "creative-builder", "brand", "si", "typed-negotiation", "constrained-seller"].map(
      (tenant) => job(`Storyboards (current /${tenant})`),
    ),
    ...["signals", "sales", "governance", "creative", "creative-builder", "brand", "si"].map(
      (tenant) => job(`Storyboards (3.0-compat /${tenant})`),
    ),
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((n) => job(`Sales storyboard orchestrator (${n}/8)`)),
    job("Storyboards (current /sales)"),
  ];
  const responses = {
    pulls: [{ number: 9, merged_at: "2026-10-22T00:00:00Z", base: { ref: "main" } }],
    pr: {
      number: 9,
      merged: true,
      merge_commit_sha: source,
      head: { sha: head, ref: "changeset-release/main", repo: { full_name: "adcontextprotocol/adcp" } },
      base: { ref: "main", repo: { full_name: "adcontextprotocol/adcp" } },
      user: { id: 7, login: "aao-release-bot[bot]" },
    },
    runs: [
      {
        id: 41,
        head_sha: head,
        head_branch: "changeset-release/main",
        head_repository: { full_name: "adcontextprotocol/adcp" },
        path: ".github/workflows/training-agent-storyboards.yml",
        event: "pull_request",
        status: "completed",
        conclusion: "success",
      },
    ],
    jobs: { 41: passingJobs },
  };
  const responsesPath = path.join(dir, "gh-responses.json");
  const save = () => fs.writeFileSync(responsesPath, JSON.stringify(responses));
  fs.mkdirSync(path.join(dir, "bin"));
  fs.writeFileSync(
    path.join(dir, "bin/gh"),
    `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);
const r=JSON.parse(fs.readFileSync(${JSON.stringify(responsesPath)},'utf8'));
const url=args.find(a=>a.startsWith('/repos/'))||'';
fs.appendFileSync(${JSON.stringify(path.join(dir, "gh-calls"))},url+'\\n');
const out=v=>console.log(JSON.stringify(args.includes('--slurp')?[v]:v));
if(process.env.GH_ERROR){console.error('HTTP 502');process.exit(1);}
if(/\\/commits\\/[0-9a-f]{40}\\/pulls$/.test(url)) out(r.pulls);
else if(/\\/pulls\\/9$/.test(url)) out(r.pr);
else if(url.includes('/actions/workflows/training-agent-storyboards.yml/runs?')) out({total_count:r.runs.length,workflow_runs:r.runs});
else { const m=url.match(/\\/actions\\/runs\\/(\\d+)\\/jobs\\?/); if(!m) throw Error('unexpected gh '+url); out({total_count:0,jobs:r.jobs[m[1]]||[]}); }
`,
  );
  fs.chmodSync(path.join(dir, "bin/gh"), 0o755);
  const env = {
    PATH: `${path.join(dir, "bin")}:${process.env.PATH}`,
    HOME: dir,
    GITHUB_SHA: source,
    GITHUB_REPOSITORY: "adcontextprotocol/adcp",
    GITHUB_REF_NAME: "main",
    PUBLICATION_BRANCH: "main",
    GH_TOKEN: "fixture",
  };
  const run = (extra = {}) => {
    save();
    return spawnSync(process.execPath, ["scripts/check-release-state.cjs", "verified-merge"], {
      cwd: dir,
      env: { ...env, ...extra },
      encoding: "utf8",
    });
  };
  // Run the workflow step itself to check its fallback contract.
  const step = release.jobs["verify-release"].steps.find(
    (s) => s.name === "Detect provenance-verified release merge",
  );
  const runStep = (extra = {}) => {
    save();
    const output = path.join(dir, "github-output");
    fs.writeFileSync(output, "");
    const result = spawnSync("bash", ["--noprofile", "--norc", "-c", step.run], {
      cwd: dir,
      env: { ...env, GITHUB_OUTPUT: output, ...extra },
      encoding: "utf8",
    });
    return { ...result, output: fs.readFileSync(output, "utf8") };
  };
  const ghCalls = () =>
    fs.existsSync(path.join(dir, "gh-calls"))
      ? fs.readFileSync(path.join(dir, "gh-calls"), "utf8").split("\n").filter(Boolean)
      : [];
  return { dir, git, base, head, source, responses, passingJobs, job, run, runStep, ghCalls };
}

const notVerified = (result, pattern) => {
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /::notice::Release merge is not provenance-verified/);
  assert.doesNotMatch(result.stderr, /::error::/);
  if (pattern) assert.match(result.stderr, pattern);
};

test("verified-merge accepts the exact approved head with a passing storyboard run", (t) => {
  const f = mergeFixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`release PR #9 head ${f.head}.*storyboard run 41 passed`));
  assert.ok(
    f.ghCalls().some((url) =>
      url.includes(`/actions/workflows/training-agent-storyboards.yml/runs?head_sha=${f.head}&event=pull_request&status=completed`),
    ),
  );
  const step = f.runStep();
  assert.equal(step.status, 0, step.stderr);
  assert.equal(step.output, "verified=true\n");
});

test("verified-merge refuses a run whose storyboard job was skipped", (t) => {
  const f = mergeFixture(t);
  f.responses.jobs[41] = f.passingJobs.map((job) =>
    job.name === "Storyboards (current /brand)" ? f.job(job.name, "skipped") : job,
  );
  notVerified(f.run(), /No completed pull_request training-agent-storyboards\.yml run/);
});

test("verified-merge refuses a Draft run that skipped the whole matrix", (t) => {
  const f = mergeFixture(t);
  f.responses.jobs[41] = [
    f.job("Storyboards (${{ matrix.surface }} /${{ matrix.tenant }})", "skipped"),
    f.job("Sales storyboard orchestrator (${{ matrix.orchestrator }}/8)", "skipped"),
    f.job("Storyboards (current /sales)", "skipped"),
  ];
  notVerified(f.run());
  // A later ready-for-review run on the same head does count.
  f.responses.runs.push({ ...f.responses.runs[0], id: 42 });
  f.responses.jobs[42] = f.passingJobs;
  assert.equal(f.run().status, 0);
});

test("verified-merge refuses a cancelled or failed storyboard job", (t) => {
  for (const conclusion of ["cancelled", "failure"]) {
    const f = mergeFixture(t);
    f.responses.jobs[41] = [...f.passingJobs, f.job("Storyboards (3.0-compat /extra)", conclusion)];
    notVerified(f.run());
  }
});

test("verified-merge requires both storyboard surfaces", (t) => {
  const f = mergeFixture(t);
  f.responses.jobs[41] = f.passingJobs.filter((job) => !job.name.startsWith("Storyboards (3.0-compat"));
  notVerified(f.run());
});

test("verified-merge refuses when no storyboard run exists", (t) => {
  const f = mergeFixture(t);
  f.responses.runs = [];
  notVerified(f.run(), /No completed pull_request/);
  const step = f.runStep();
  assert.equal(step.status, 0, "an unproven merge must not fail verify-release");
  assert.equal(step.output, "");
});

test("verified-merge refuses a run on a different head", (t) => {
  const f = mergeFixture(t);
  f.responses.runs = [{ ...f.responses.runs[0], head_sha: f.base }];
  notVerified(f.run(), /No completed pull_request/);
});

test("verified-merge refuses a run that did not succeed or was not a pull_request", (t) => {
  for (const change of [{ conclusion: "failure" }, { event: "push" }, { status: "in_progress" }]) {
    const f = mergeFixture(t);
    f.responses.runs = [{ ...f.responses.runs[0], ...change }];
    notVerified(f.run());
  }
});

test("verified-merge refuses a provenance mismatch", (t) => {
  const f = mergeFixture(t, { tamperTree: true });
  notVerified(f.run(), /Quarantined release/);
  assert.ok(!f.ghCalls().some((url) => url.includes("/actions/")), "storyboard runs are not consulted");
  const step = f.runStep();
  assert.equal(step.status, 0);
  assert.equal(step.output, "");
});

test("verified-merge refuses an ambiguous or missing merged release PR", (t) => {
  const f = mergeFixture(t);
  f.responses.pulls = [...f.responses.pulls, { ...f.responses.pulls[0], number: 10 }];
  notVerified(f.run(), /exactly one merged release PR/);
  f.responses.pulls = [];
  notVerified(f.run(), /exactly one merged release PR/);
});

test("verified-merge treats API failures as unproven", (t) => {
  const f = mergeFixture(t);
  notVerified(f.run({ GH_ERROR: "1" }));
});

test("the verified-merge step skips the API for a push that is not a release merge", (t) => {
  const f = mergeFixture(t);
  const step = f.runStep({ GITHUB_SHA: f.base });
  assert.equal(step.status, 0, step.stderr);
  // A non-release push is generation-only: storyboards are deferred to the
  // Version Packages PR, and it is never marked verified.
  assert.equal(step.output, "generation_only=true\n");
  assert.match(step.stdout, /Not a release merge/);
  assert.deepEqual(f.ghCalls(), []);
});

test("a release merge is never generation-only, verified or not", (t) => {
  const f = mergeFixture(t);
  f.responses.pulls = [];
  const step = f.runStep();
  assert.equal(step.status, 0, step.stderr);
  assert.doesNotMatch(step.output, /generation_only/);
  assert.doesNotMatch(step.output, /verified=true/);
});

// Security review follow-ups (#8424).
const { publicationAuthority, storyboardJobs } = require(fence);
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

test("publication-current refuses every release-status and publication-machinery change", (t) => {
  for (const file of [
    ".changeset/withdrawn-release.json",
    "scripts/build-schemas.cjs",
    "server/src/schemas-middleware.ts",
    "workers/artifact-cdn/src/index.js",
    ".github/workflows/release.yml",
    ".github/workflows/recover-protocol-cdn.yml",
    "scripts/check-release-state.cjs",
    "scripts/backfill-cdn-artifacts.sh",
    "scripts/recover-cdn-version-trees.sh",
    "scripts/check-protocol-bundle-parity.cjs",
  ])
    assert.ok(publicationAuthority.includes(file), `${file} must be publication authority`);
  for (const file of publicationAuthority) {
    const f = freshnessFixture(t);
    f.commit({ "server/app.ts": "export const later = 1;\n" });
    f.push(f.commit({ [file]: "// changed mid-publication\n" }));
    refused(f.run("publication-current"), new RegExp(`release paths: ${escape(file)}`));
  }
});

test("publication-current refuses a withdrawal landing mid-publication", (t) => {
  const f = freshnessFixture(t);
  f.push(
    f.commit({
      ".changeset/withdrawn-release.json": JSON.stringify({ version, reason: "withdrawn" }),
      "scripts/build-schemas.cjs": `const RELEASE_STATUS_OVERRIDES = { "${version}": "withdrawn" };\n`,
    }),
  );
  refused(f.run("publication-current"), /release paths: .*withdrawn-release\.json/);
});

test("publication-current refuses a mode-only change at a protected path", (t) => {
  const f = freshnessFixture(t);
  f.git("update-index", "--chmod=+x", `dist/protocol/${version}.tgz.sig`);
  f.git("commit", "-qm", "Mode only");
  f.push(f.git("rev-parse", "HEAD"));
  refused(f.run("publication-current"), /release paths: dist\/protocol\/3\.3\.0-beta\.0\.tgz\.sig/);
});

test("publication-current refuses a symlink typechange at a protected path", (t) => {
  const f = freshnessFixture(t);
  const target = path.join(f.dir, "work", `dist/schemas/${version}/index.json`);
  fs.rmSync(target);
  fs.symlinkSync("../../../server/app.ts", target);
  f.git("add", "--", `dist/schemas/${version}/index.json`);
  f.git("commit", "-qm", "Typechange to symlink");
  f.push(f.git("rev-parse", "HEAD"));
  refused(f.run("publication-current"), /release paths: dist\/schemas\/3\.3\.0-beta\.0\/index\.json/);
});

test("publication-current refuses a gitlink added under a protected path", (t) => {
  const f = freshnessFixture(t);
  f.git("update-index", "--add", "--cacheinfo", `160000,${f.tested},dist/compliance/${version}/vendored`);
  f.git("commit", "-qm", "Gitlink");
  f.push(f.git("rev-parse", "HEAD"));
  refused(f.run("publication-current"), /release paths: dist\/compliance\/3\.3\.0-beta\.0\/vendored/);
});

test("publication-current compares the net diff, so a change-then-revert is accepted", (t) => {
  const f = freshnessFixture(t);
  f.commit({ [`dist/protocol/${version}.tgz`]: "resigned\n" });
  const head = f.commit({ [`dist/protocol/${version}.tgz`]: "signed\n" }, "Revert tarball change");
  f.push(head);
  const result = f.run("publication-current");
  accepted(result);
  assert.ok(result.stdout.includes(`to ${head} (2 commit(s))`), result.stdout);
});

test("publication-current re-reads after a fetch race and then accepts", (t) => {
  const f = freshnessFixture(t);
  const pushed = f.commit({ "server/app.ts": "export const later = 1;\n" });
  f.push(pushed);
  // The first ls-remote advertises a head the remote no longer serves (the
  // branch moved before fetch); later reads advertise the real head.
  const raced = f.commit({ "server/app.ts": "export const raced = 1;\n" });
  const bin = path.join(f.dir, "bin");
  fs.mkdirSync(bin);
  const counter = path.join(f.dir, "ls-remote-count");
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);
if(args[0]==='ls-remote'){
  const n=(fs.existsSync(${JSON.stringify(counter)})?Number(fs.readFileSync(${JSON.stringify(counter)},'utf8')):0)+1;
  fs.writeFileSync(${JSON.stringify(counter)},String(n));
  if(n===1){console.log(process.env.RACED+'\\t'+args.at(-1));process.exit(0);}
}
const r=require('node:child_process').spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(r.status??1);`,
  );
  fs.chmodSync(path.join(bin, "git"), 0o755);
  const result = f.run("publication-current", { PATH: `${bin}:${process.env.PATH}`, RACED: raced });
  accepted(result);
  assert.ok(result.stdout.includes(`to ${pushed} (1 commit(s))`), result.stdout);
  assert.equal(fs.readFileSync(counter, "utf8"), "2");
});

test("verified-merge requires the full expected storyboard matrix", (t) => {
  assert.equal(storyboardJobs.length, 24);
  const f = mergeFixture(t);
  // The narrowed shape the first version accepted: one job per surface plus
  // the aggregate /sales job.
  f.responses.jobs[41] = [
    f.job("Storyboards (current /signals)"),
    f.job("Storyboards (3.0-compat /signals)"),
    f.job("Storyboards (current /sales)"),
  ];
  notVerified(f.run(), /every expected storyboard job/);
  f.responses.jobs[41] = [f.job("Storyboards (current /sales)")];
  notVerified(f.run());
  f.responses.jobs[41] = f.passingJobs.filter(
    (job) => job.name !== "Storyboards (current /typed-negotiation)",
  );
  notVerified(f.run());
});

test("verified-merge refuses a fork run with the same head SHA", (t) => {
  const f = mergeFixture(t);
  f.responses.runs = [{ ...f.responses.runs[0], head_repository: { full_name: "attacker/adcp" } }];
  notVerified(f.run(), /No completed pull_request/);
});

test("verified-merge refuses a run from another PR branch (cross-base)", (t) => {
  const f = mergeFixture(t);
  f.responses.runs = [{ ...f.responses.runs[0], head_branch: "changeset-release/3.2.x" }];
  notVerified(f.run(), /No completed pull_request/);
});

test("verified-merge refuses a run of a different workflow file", (t) => {
  const f = mergeFixture(t);
  f.responses.runs = [{ ...f.responses.runs[0], path: ".github/workflows/other.yml" }];
  notVerified(f.run(), /No completed pull_request/);
});

test("verified-merge refuses a release PR whose head lives in a fork", (t) => {
  const f = mergeFixture(t);
  f.responses.pr.head.repo = { full_name: "attacker/adcp" };
  notVerified(f.run(), /head must be a branch of this repository/);
});

for (const [name, file] of [
  ["the storyboard workflow", ".github/workflows/training-agent-storyboards.yml"],
  ["a storyboard runner script", "scripts/run-storyboards-matrix.sh"],
  ["the training agent", "server/src/training-agent/index.ts"],
  ["the compliance bundle builder", "scripts/build-compliance.cjs"],
])
  test(`verified-merge refuses a release head that modifies ${name}`, (t) => {
    const f = mergeFixture(t, { headFiles: { [file]: "# narrowed\n" } });
    notVerified(f.run(), /changes storyboard verification inputs/);
    assert.ok(
      !f.ghCalls().some((url) => url.includes("/actions/")),
      "storyboard runs are not consulted",
    );
  });

test("verified-merge is main-only", (t) => {
  const f = mergeFixture(t);
  for (const branch of ["3.2.x", "3.1.x", "3.0.x"])
    notVerified(f.run({ GITHUB_REF_NAME: branch, PUBLICATION_BRANCH: branch }), /the main branch/);
  assert.deepEqual(f.ghCalls(), []);
  const step = release.jobs["verify-release"].steps.find(
    (s) => s.name === "Detect provenance-verified release merge",
  );
  assert.match(step.if, /github\.ref_name == 'main'/);
});
