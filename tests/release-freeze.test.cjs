// The "Release freeze" status (RELEASING.md "Release freeze",
// scripts/release-freeze.cjs). The workflow's triggers and trust boundary are
// pinned in tests/release-workflow-immutability.test.cjs.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const script = path.join(root, "scripts/release-freeze.cjs");
const { CONTEXT, freezeReasons, decide, sweep, RELEASE_BRANCHES } = require(script);

const repository = "adcontextprotocol/adcp";
const sha = (n) => n.toString(16).padStart(40, "0");
const pr = (number, extra = {}) => ({
  number,
  draft: false,
  headRef: `feature/${number}`,
  headSha: sha(number),
  headRepository: repository,
  labels: [],
  currentStatus: null,
  ...extra,
});
const versionPackages = (number, branch = "main", extra = {}) =>
  pr(number, { headRef: `changeset-release/${branch}`, draft: true, ...extra });

// A repository snapshot behind the evaluator's API boundary.
function world(overrides = {}) {
  const state = {
    pulls: { main: [] },
    versions: { main: "3.3.0-rc.2", "3.2.x": "3.2.12", "3.1.x": "3.1.34", "3.0.x": "3.0.28" },
    published: ["v3.3.0-rc.2", "v3.2.12", "v3.1.34", "v3.0.28"],
    runs: [],
    releaseCommits: [],
    fail: {},
    ...overrides,
  };
  const writes = [];
  const api = {
    openPulls(branch) {
      if (state.fail.pulls === branch) throw new Error("HTTP 502");
      return state.pulls[branch] || [];
    },
    branchHead(branch) {
      if (state.fail.head === branch) throw new Error("HTTP 502");
      return { sha: sha(0xb0 + RELEASE_BRANCHES.indexOf(branch)), packageJson: JSON.stringify({ version: state.versions[branch] }) };
    },
    publishedRelease(tag) {
      if (state.fail.release === tag) throw new Error("HTTP 502");
      return state.published.includes(tag);
    },
    inFlightRuns(workflow, branch) {
      return state.runs.filter((run) => run.workflow === workflow && run.branch === branch);
    },
    isReleaseCommit(head) {
      return state.releaseCommits.includes(head);
    },
    setStatus(head, status) {
      if (state.fail.write === head) throw new Error("HTTP 422");
      writes.push({ sha: head, ...status });
    },
  };
  const run = (options = {}) => sweep(api, { repository, targetUrl: "https://run.invalid/1", log: () => {}, ...options });
  const statusOf = (number) => {
    const head = Object.values(state.pulls).flat().find((p) => p.number === number).headSha;
    return writes.filter((write) => write.sha === head).at(-1);
  };
  return { state, writes, run, statusOf };
}

const releaseRun = (id, extra = {}) => ({
  id,
  workflow: "release.yml",
  branch: "main",
  event: "push",
  status: "in_progress",
  headSha: sha(0xfeed),
  ...extra,
});

test("no release in flight: every pull request may merge", () => {
  const w = world({ pulls: { main: [pr(1), pr(2, { draft: true }), versionPackages(9141)] } });
  const result = w.run();
  assert.equal(result.failed, false);
  for (const number of [1, 2]) {
    assert.equal(w.statusOf(number).state, "success");
    assert.equal(w.statusOf(number).description, "No main release in flight");
    assert.equal(w.statusOf(number).context, CONTEXT);
    assert.equal(w.statusOf(number).targetUrl, "https://run.invalid/1");
  }
  // A Draft Version Packages PR (e.g. rc.3's #9141 today) starts no freeze.
  assert.deepEqual(result.summary.find((entry) => entry.branch === "main").reasons, []);
});

test("a ready Version Packages PR freezes every other pull request", () => {
  // rc.1: #9073 was ready and approved when #9080 merged without a changeset.
  const w = world({
    pulls: { main: [versionPackages(9073, "main", { draft: false }), pr(9080), pr(9081, { draft: true })] },
  });
  w.run();
  assert.equal(w.statusOf(9080).state, "failure");
  assert.equal(w.statusOf(9080).description, "Release in flight: Version Packages PR #9073 is ready for review. Merge after it publishes.");
  assert.equal(w.statusOf(9081).state, "failure");
  assert.equal(w.statusOf(9073).state, "success");
  assert.match(w.statusOf(9073).description, /Version Packages PR: exempt/);
});

test("a committed but unpublished version freezes the branch", () => {
  // After the Version Packages merge, before the release publishes; also a
  // quarantined or stranded release waiting for supersession or recovery.
  const w = world({ versions: { main: "3.3.0-rc.1" }, pulls: { main: [pr(9107)] } });
  w.run({ branches: ["main"] });
  assert.equal(w.statusOf(9107).state, "failure");
  assert.match(w.statusOf(9107).description, /3\.3\.0-rc\.1 is committed on main without a published GitHub Release/);
});

test("a release run publishing a release commit freezes the branch until it completes", () => {
  // rc.2: #9125 merged after the release merge, before its run started; and
  // the R2 upload runs ~38 minutes after the GitHub Release is published.
  const releaseCommit = sha(0x3569);
  const w = world({
    pulls: { main: [pr(9125)] },
    runs: [releaseRun(44711592865, { headSha: releaseCommit })],
    releaseCommits: [releaseCommit],
  });
  w.run({ branches: ["main"] });
  assert.equal(w.statusOf(9125).state, "failure");
  assert.match(w.statusOf(9125).description, /release run 44711592865 is publishing 000000000000/);

  // An ordinary push only regenerates the Draft Version Packages PR.
  const ordinary = world({ pulls: { main: [pr(9125)] }, runs: [releaseRun(1, { headSha: sha(0xabc) })] });
  ordinary.run({ branches: ["main"] });
  assert.equal(ordinary.statusOf(9125).state, "success");
});

test("every release dispatch and CDN recovery run freezes main", () => {
  for (const [run, pattern] of [
    [releaseRun(44726375353, { event: "workflow_dispatch", status: "queued" }), /release dispatch run 44726375353/],
    [releaseRun(44758301588, { workflow: "recover-protocol-cdn.yml", event: "workflow_dispatch" }), /CDN recovery run 44758301588/],
  ]) {
    const w = world({ pulls: { main: [pr(1)] }, runs: [run] });
    w.run({ branches: ["main"] });
    assert.equal(w.statusOf(1).state, "failure");
    assert.match(w.statusOf(1).description, pattern);
  }
});

test("reasons accumulate and the description stays within GitHub's 140 characters", () => {
  const reasons = freezeReasons({
    branch: "main",
    version: "3.3.0-rc.99999999999999999999999999",
    published: false,
    releasePulls: [{ number: 9073, draft: false }],
    runs: [releaseRun(1, { event: "workflow_dispatch" })],
  });
  assert.equal(reasons.length, 3);
  const decision = decide(pr(1), "main", reasons, repository);
  assert.equal(decision.state, "failure");
  assert.ok(decision.description.length <= 140, decision.description);
  assert.match(decision.description, /\(\+2 more\)/);
});

test("a pull request labelled release is exempt", () => {
  const w = world({
    versions: { main: "3.3.0-rc.1" },
    pulls: { main: [pr(9090, { labels: ["release"] }), pr(9091, { labels: ["Release", "release-notes"] })] },
  });
  w.run({ branches: ["main"] });
  // The rc.1 supersession plan lands mid-freeze; similar labels do not count.
  assert.equal(w.statusOf(9090).state, "success");
  assert.match(w.statusOf(9090).description, /Labelled "release": exempt/);
  assert.equal(w.statusOf(9091).state, "failure");
});

test("only this repository's changeset-release/<base> head is the Version Packages PR", () => {
  const w = world({
    versions: { main: "3.3.0-rc.1" },
    pulls: {
      main: [
        versionPackages(1, "main", { headRepository: "someone/adcp" }),
        versionPackages(2, "3.2.x"),
        versionPackages(3, "main", { headRepository: null }),
      ],
    },
  });
  w.run({ branches: ["main"] });
  for (const number of [1, 2, 3]) assert.equal(w.statusOf(number).state, "failure", `#${number}`);
  // A fork's ready "Version Packages" PR starts no freeze either.
  const fork = world({ pulls: { main: [versionPackages(1, "main", { draft: false, headRepository: "someone/adcp" }), pr(2)] } });
  fork.run({ branches: ["main"] });
  assert.equal(fork.statusOf(2).state, "success");
});

test("each maintenance branch's freeze is about its own release", () => {
  const w = world({
    pulls: { main: [pr(1)], "3.1.x": [versionPackages(10, "3.1.x", { draft: false }), pr(11)], "3.2.x": [pr(20)] },
    runs: [releaseRun(5, { branch: "3.2.x", headSha: sha(0x32) })],
    releaseCommits: [sha(0x32)],
  });
  const result = w.run();
  assert.equal(w.statusOf(1).state, "success");
  assert.equal(w.statusOf(10).state, "success");
  assert.equal(w.statusOf(11).state, "failure");
  assert.match(w.statusOf(11).description, /Version Packages PR #10/);
  assert.equal(w.statusOf(20).state, "failure");
  assert.match(w.statusOf(20).description, /release run 5/);
  assert.deepEqual(result.summary.map((entry) => entry.branch), RELEASE_BRANCHES);
});

test("CDN recovery runs freeze main only", () => {
  const w = world({
    pulls: { main: [pr(1)], "3.1.x": [pr(2)] },
    runs: [releaseRun(7, { workflow: "recover-protocol-cdn.yml", branch: "3.1.x", event: "workflow_dispatch" })],
  });
  w.run();
  assert.equal(w.statusOf(2).state, "success");
});

test("the status follows the freeze in both directions without a push", () => {
  const w = world({ pulls: { main: [versionPackages(9091), pr(9125)] } });
  w.run({ branches: ["main"] });
  assert.equal(w.statusOf(9125).state, "success");
  w.state.pulls.main[0].draft = false; // marked ready for review
  w.run({ branches: ["main"] });
  assert.equal(w.statusOf(9125).state, "failure");
  w.state.pulls.main.shift(); // merged; the version is committed, unpublished
  w.state.versions.main = "3.3.0-rc.3";
  w.state.runs = [releaseRun(1, { headSha: sha(0x99) })];
  w.state.releaseCommits = [sha(0x99)];
  w.run({ branches: ["main"] });
  assert.equal(w.statusOf(9125).state, "failure");
  w.state.published.push("v3.3.0-rc.3"); // GitHub Release published, R2 still uploading
  w.run({ branches: ["main"] });
  assert.equal(w.statusOf(9125).state, "failure");
  assert.match(w.statusOf(9125).description, /release run 1/);
  w.state.runs = []; // run completed
  w.run({ branches: ["main"] });
  assert.equal(w.statusOf(9125).state, "success");
});

test("an unchanged status is not rewritten", () => {
  const w = world({
    pulls: {
      main: [
        pr(1, { currentStatus: { state: "success", description: "No main release in flight" } }),
        pr(2, { currentStatus: { state: "failure", description: "No main release in flight" } }),
      ],
    },
  });
  const result = w.run({ branches: ["main"] });
  assert.deepEqual(w.writes.map((write) => write.sha), [sha(2)]);
  assert.equal(result.written, 1);
});

test("a head shared with a frozen branch gets the failure", () => {
  const shared = sha(0x5);
  const w = world({
    pulls: { main: [pr(1, { headSha: shared })], "3.1.x": [pr(2, { headSha: shared })] },
    versions: { main: "3.3.0-rc.2", "3.1.x": "3.1.35", "3.2.x": "3.2.12", "3.0.x": "3.0.28" },
  });
  w.run();
  assert.equal(w.writes.filter((write) => write.sha === shared).length, 1);
  assert.equal(w.writes.find((write) => write.sha === shared).state, "failure");
});

test("an unknown state fails closed with error, but exemptions still pass", () => {
  for (const fail of [{ release: "v3.3.0-rc.2" }, { head: "main" }]) {
    const w = world({ pulls: { main: [pr(1), versionPackages(2), pr(3, { labels: ["release"] })] }, fail });
    const result = w.run({ branches: ["main"] });
    assert.equal(result.failed, true);
    assert.equal(w.statusOf(1).state, "error");
    assert.match(w.statusOf(1).description, /Could not determine whether a main release is in flight/);
    assert.equal(w.statusOf(2).state, "success");
    assert.equal(w.statusOf(3).state, "success");
  }
});

test("a branch whose pull requests cannot be listed fails the sweep without touching others", () => {
  const w = world({ pulls: { main: [pr(1)], "3.1.x": [pr(2)] }, fail: { pulls: "main" } });
  const result = w.run();
  assert.equal(result.failed, true);
  assert.equal(w.writes.length, 1);
  assert.equal(w.statusOf(2).state, "success");
});

test("a failed status write fails the sweep but the rest are written", () => {
  const w = world({ pulls: { main: [pr(1), pr(2)] }, fail: { write: sha(1) } });
  const result = w.run({ branches: ["main"] });
  assert.equal(result.failed, true);
  assert.equal(w.statusOf(2).state, "success");
});

test("a malformed package version is an unknown state", () => {
  const w = world({ pulls: { main: [pr(1)] }, versions: { main: "next" } });
  const result = w.run({ branches: ["main"] });
  assert.equal(result.failed, true);
  assert.equal(w.statusOf(1).state, "error");
});

// --- the gh adapter and CLI -------------------------------------------------

function cliFixture(t, responses) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-freeze-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "responses.json"), JSON.stringify(responses));
  fs.mkdirSync(path.join(dir, "bin"));
  fs.writeFileSync(
    path.join(dir, "bin/gh"),
    `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);
const r=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, "responses.json"))},'utf8'));
fs.appendFileSync(${JSON.stringify(path.join(dir, "calls.jsonl"))},JSON.stringify(args)+'\\n');
const field=k=>{const i=args.findIndex((a,n)=>args[n-1]==='-f'&&a.startsWith(k+'='));return i<0?undefined:args[i].slice(k.length+1);};
if(r.error){console.error(r.errorMessage||'HTTP 502: Bad Gateway');process.exit(1);}
if(args[1]==='graphql'){
  const q=field('query');
  if(q.includes('pullRequests')){const page=r.pulls[field('base')]?.[field('cursor')||'first']||{nodes:[],pageInfo:{hasNextPage:false}};console.log(JSON.stringify({data:{repository:{pullRequests:page}}}));}
  else if(q.includes('ref(qualifiedName')){const b=field('ref').replace('refs/heads/','');console.log(JSON.stringify({data:{repository:{ref:{target:{oid:r.heads[b].oid,file:{object:{text:JSON.stringify({version:r.heads[b].version})}}}}}}}));}
  else if(q.includes('release(tagName')){console.log(JSON.stringify({data:{repository:{release:r.releases[field('tag')]??null}}}));}
  else if(q.includes('object(oid')){const c=r.commits[field('oid')];console.log(JSON.stringify({data:{repository:{object:{file:{object:{text:JSON.stringify({version:c[0]})}},parents:{nodes:[{file:{object:{text:JSON.stringify({version:c[1]})}}}]}}}}}));}
  else throw Error('unexpected graphql');
} else if(args.includes('--method')){ /* status write */ }
else { const m=args[1].match(/workflows\\/([^/]+)\\/runs\\?branch=([^&]+)/); console.log(JSON.stringify({workflow_runs:(r.runs[m[1]]?.[decodeURIComponent(m[2])])||[]})); }
`,
  );
  fs.chmodSync(path.join(dir, "bin/gh"), 0o755);
  const run = (extra = {}) =>
    spawnSync(process.execPath, [script, "sweep"], {
      cwd: dir,
      env: {
        PATH: `${path.join(dir, "bin")}:${process.env.PATH}`,
        GITHUB_REPOSITORY: repository,
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_RUN_ID: "77",
        GITHUB_STEP_SUMMARY: path.join(dir, "summary.md"),
        ...extra,
      },
      encoding: "utf8",
    });
  const calls = () =>
    fs.existsSync(path.join(dir, "calls.jsonl"))
      ? fs.readFileSync(path.join(dir, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse)
      : [];
  const statusWrites = () =>
    calls()
      .filter((args) => args.includes("--method"))
      .map((args) => ({
        path: args[3],
        ...Object.fromEntries(args.filter((a, n) => args[n - 1] === "-f").map((a) => a.split(/=(.*)/s).slice(0, 2))),
      }));
  return { dir, run, calls, statusWrites };
}

const node = (number, extra = {}) => ({
  number,
  isDraft: false,
  headRefName: `feature/${number}`,
  headRefOid: sha(number),
  headRepository: { nameWithOwner: repository },
  labels: { nodes: [] },
  commits: { nodes: [{ commit: { oid: sha(number), status: null } }] },
  ...extra,
});
const quietHeads = {
  main: { oid: sha(0xa), version: "3.3.0-rc.2" },
  "3.2.x": { oid: sha(0xb), version: "3.2.12" },
  "3.1.x": { oid: sha(0xc), version: "3.1.34" },
  "3.0.x": { oid: sha(0xd), version: "3.0.28" },
};
const publishedReleases = Object.fromEntries(
  Object.values(quietHeads).map(({ version }) => [`v${version}`, { tagName: `v${version}`, isDraft: false }]),
);

test("the CLI pages through pull requests, classifies runs and posts statuses through gh", (t) => {
  const releaseCommit = sha(0x3569);
  const f = cliFixture(t, {
    heads: quietHeads,
    releases: publishedReleases,
    pulls: {
      main: {
        first: { nodes: [node(1), node(2, { labels: { nodes: [{ name: "release" }] } })], pageInfo: { hasNextPage: true, endCursor: "Y3Vyc29y" } },
        Y3Vyc29y: {
          nodes: [
            // An outdated status on the head is replaced.
            node(3, {
              commits: { nodes: [{ commit: { oid: sha(3), status: { context: { state: "SUCCESS", description: "No main release in flight" } } } }] },
            }),
          ],
          pageInfo: { hasNextPage: false },
        },
      },
    },
    runs: {
      "release.yml": {
        main: [
          { id: 40, status: "completed", event: "push", head_sha: sha(0x40) },
          { id: 41, status: "in_progress", event: "push", head_sha: releaseCommit },
          { id: 42, status: "queued", event: "push", head_sha: sha(0x42) },
        ],
      },
    },
    commits: { [releaseCommit]: ["3.3.0-rc.2", "3.3.0-rc.1"], [sha(0x42)]: ["3.3.0-rc.2", "3.3.0-rc.2"] },
  });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const writes = f.statusWrites();
  assert.deepEqual(
    writes.map((write) => [write.path, write.state]),
    [
      [`/repos/${repository}/statuses/${sha(1)}`, "failure"],
      [`/repos/${repository}/statuses/${sha(2)}`, "success"],
      [`/repos/${repository}/statuses/${sha(3)}`, "failure"],
    ],
  );
  assert.equal(writes[0].context, "Release freeze");
  assert.equal(writes[0].description, "Release in flight: release run 41 is publishing 000000000000. Merge after it publishes.");
  assert.equal(writes[0].target_url, `https://github.com/${repository}/actions/runs/77`);
  // The completed run is never classified; the queued ordinary push is.
  const classified = f.calls().filter((args) => args.some((a) => a.startsWith("query=") && a.includes("object(oid")));
  assert.deepEqual(classified.map((args) => args.find((a) => a.startsWith("oid="))), [`oid=${releaseCommit}`, `oid=${sha(0x42)}`]);
  assert.match(fs.readFileSync(path.join(f.dir, "summary.md"), "utf8"), /\| main \| 3 \| frozen: release run 41/);
  // Every API call is a read except the status writes.
  for (const args of f.calls()) assert.ok(!args.includes("--method") || args[2] === "POST");
});

test("the CLI skips a status that already matches", (t) => {
  const f = cliFixture(t, {
    heads: quietHeads,
    releases: publishedReleases,
    pulls: {
      main: {
        first: {
          nodes: [
            node(1, { commits: { nodes: [{ commit: { oid: sha(1), status: { context: { state: "SUCCESS", description: "No main release in flight" } } } }] } }),
            // A status on an older commit than the head does not count.
            node(2, { commits: { nodes: [{ commit: { oid: sha(0x99), status: { context: { state: "SUCCESS", description: "No main release in flight" } } } }] } }),
          ],
          pageInfo: { hasNextPage: false },
        },
      },
    },
    runs: {},
    commits: {},
  });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.statusWrites().map((write) => write.path), [`/repos/${repository}/statuses/${sha(2)}`]);
});

test("the CLI treats a draft or missing release as unpublished", (t) => {
  for (const release of [null, { tagName: "v3.3.0-rc.2", isDraft: true }]) {
    const f = cliFixture(t, {
      heads: quietHeads,
      releases: { ...publishedReleases, "v3.3.0-rc.2": release },
      pulls: { main: { first: { nodes: [node(1)], pageInfo: { hasNextPage: false } } } },
      runs: {},
      commits: {},
    });
    assert.equal(f.run().status, 0);
    assert.equal(f.statusWrites()[0].state, "failure");
    assert.match(f.statusWrites()[0].description, /without a published GitHub Release/);
  }
});

test("the CLI exits non-zero when the API is unavailable", (t) => {
  const f = cliFixture(t, { error: true });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /::error::/);
  assert.deepEqual(f.statusWrites(), []);
});

test("the job summary escapes table cells", (t) => {
  const f = cliFixture(t, { error: true, errorMessage: "bad \\| cell" });
  assert.notEqual(f.run().status, 0);
  const summary = fs.readFileSync(path.join(f.dir, "summary.md"), "utf8");
  assert.ok(summary.includes("bad \\\\\\| cell"), summary);
  for (const line of summary.split("\n").filter((l) => l.startsWith("| main")))
    assert.equal(line.split(/(?<!\\)\|/).length, 5, line);
});

test("the CLI requires a repository and the sweep mode", (t) => {
  const f = cliFixture(t, { heads: quietHeads, releases: publishedReleases, pulls: {}, runs: {}, commits: {} });
  assert.match(f.run({ GITHUB_REPOSITORY: "" }).stderr, /repository/);
  const wrongMode = spawnSync(process.execPath, [script, "apply"], { encoding: "utf8" });
  assert.notEqual(wrongMode.status, 0);
  assert.match(wrongMode.stderr, /Usage/);
});
