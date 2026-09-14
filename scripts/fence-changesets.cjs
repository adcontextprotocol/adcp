#!/usr/bin/env node
// Transaction containment for the pinned Changesets git-CLI push. State lives
// outside the generated checkout and is retained as a workflow artifact.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const directory = path.join(process.env.RUNNER_TEMP, "release-hooks");
const stateFile = path.join(directory, "state.json");
const realGit = fs
  .readFileSync(path.join(directory, "git-path"), "utf8")
  .trim();
function invoke(command, args, mutation = false) {
  // GNU timeout bounds the whole process group, including Git's transport
  // children. The optional test/operator setting can only shorten the bound.
  const maximum = mutation ? 600000 : 60000;
  const requested = Number(process.env.CHANGESETS_FENCE_TIMEOUT_MS || maximum);
  if (!Number.isSafeInteger(requested) || requested < 1)
    throw Error("Invalid command timeout");
  const limit = Math.min(requested, maximum);
  const env = { ...process.env };
  if (
    (command === realGit &&
      args.some((arg) => ["ls-remote", "fetch", "push"].includes(arg))) ||
    command === process.execPath
  ) {
    // The always-run reconciler has its own fresh token. Override the expired
    // checkout/action header without storing tokens in state, argv, or config.
    if (!env.GH_TOKEN || !state?.url)
      throw Error("Fresh Git credentials are unavailable");
    const count = Number(env.GIT_CONFIG_COUNT || 0);
    if (!Number.isSafeInteger(count) || count < 0 || count > 1000)
      throw Error("Ambiguous Git authentication config");
    env.GIT_CONFIG_COUNT = String(count + 2);
    for (let offset = 0; offset < 2; offset++)
      env[`GIT_CONFIG_KEY_${count + offset}`] = `http.${state.url}.extraheader`;
    env[`GIT_CONFIG_VALUE_${count}`] = "";
    env[`GIT_CONFIG_VALUE_${count + 1}`] =
      `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${env.GH_TOKEN}`).toString("base64")}`;
  }
  return spawnSync(
    "timeout",
    ["--kill-after=5s", `${limit / 1000}s`, command, ...args],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: limit + 10000,
      killSignal: "SIGKILL",
      env,
    },
  );
}
function run(command, args) {
  const result = invoke(command, args);
  if (result.status !== 0)
    throw Error(`${path.basename(command)} command failed or timed out`);
  return result.stdout.trim();
}
const git = (...args) => run(realGit, args);
const sha = (value) => /^[a-f0-9]{40}$/.test(value || "");
let state;
function save(event) {
  state.events.push(event);
  fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(state, null, 2));
  fs.renameSync(`${stateFile}.tmp`, stateFile);
  // Actions logs and summary survive even when a token expires or artifact
  // upload fails. Never include credentials or raw API responses.
  console.log(`Changesets fence: ${JSON.stringify(event)}`);
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `\nChangesets fence: ${JSON.stringify(event)}\n`,
    );
}
function api(endpoint, options = [], pages = false) {
  const result = JSON.parse(
    run("gh", [
      "api",
      ...(pages ? ["--paginate", "--slurp"] : []),
      endpoint,
      ...options,
    ]),
  );
  if (!pages) return result;
  if (!Array.isArray(result) || !result.every(Array.isArray))
    throw Error("Ambiguous PR pagination");
  return result.flat();
}
function current() {
  originIdentity();
  if (remote(`refs/heads/${state.branch}`) !== state.tested)
    throw Error("Main/release branch advanced");
}
function remote(ref = state.ref) {
  noUrlRewrites();
  // An empty successful result proves absence; transport/API errors do not.
  const value = git("ls-remote", state.url, ref);
  if (!value) return null;
  const parts = value.split("\t");
  if (parts.length !== 2 || !sha(parts[0]) || parts[1] !== ref)
    throw Error("Ambiguous remote ref");
  return parts[0];
}
function originIdentity() {
  const expected = `https://github.com/${state.repository}`;
  const fetch = git("remote", "get-url", "--all", "origin");
  const push = git("remote", "get-url", "--push", "--all", "origin");
  if (
    ![expected, `${expected}.git`].includes(fetch) ||
    ![expected, `${expected}.git`].includes(push) ||
    fetch !== push
  )
    throw Error("Origin does not identify the authorized repository");
  noUrlRewrites();
  if (state.url && (state.url !== push || state.fetchUrl !== fetch))
    throw Error("Origin changed after capture");
  state.url = push;
  state.fetchUrl = fetch;
}
function noUrlRewrites() {
  const rewrites = invoke(realGit, ["config", "--get-regexp", "^url\\."]);
  if (rewrites.status !== 1 || rewrites.stdout || rewrites.stderr)
    throw Error("URL rewrites or ambiguous Git config are not allowed");
}
function validPR(pr) {
  if (
    !pr ||
    !Number.isSafeInteger(pr.number) ||
    pr.number < 1 ||
    typeof pr.node_id !== "string" ||
    !pr.node_id ||
    pr.state !== "open" ||
    typeof pr.draft !== "boolean" ||
    pr.title !== state.title ||
    pr.base?.ref !== state.branch ||
    pr.base?.repo?.full_name !== state.repository ||
    pr.head?.ref !== state.releaseBranch ||
    pr.head?.repo?.full_name !== state.repository ||
    !sha(pr.head.sha)
  )
    throw Error("Ambiguous Version Packages PR identity");
  return pr;
}
function expectedTitle() {
  const file = ".changeset/pre.json";
  const present = git("ls-tree", "--name-only", state.tested, "--", file);
  if (!present) return "Version Packages";
  if (present !== file) throw Error("Ambiguous tested prerelease state");
  const pre = JSON.parse(git("show", `${state.tested}:${file}`));
  if (!pre || typeof pre !== "object" || Array.isArray(pre))
    throw Error("Malformed tested prerelease state");
  // Mirrors the pinned readChangesetState -> finalPrTitle contract. Exit mode
  // supplies no preState; only active pre mode appends its exact tested tag.
  if (pre.mode !== "pre") return "Version Packages";
  if (
    typeof pre.tag !== "string" ||
    !/^[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*$/.test(pre.tag)
  )
    throw Error("Invalid tested prerelease tag");
  return `Version Packages (${pre.tag})`;
}
function openPR() {
  const owner = state.repository.split("/")[0];
  const endpoint = `/repos/${state.repository}/pulls?state=open&base=${encodeURIComponent(state.branch)}&head=${encodeURIComponent(`${owner}:${state.releaseBranch}`)}&per_page=100`;
  const prs = api(endpoint, [], true);
  if (prs.length > 1) throw Error("Multiple open Version Packages PRs");
  return prs.length ? validPR(prs[0]) : null;
}
function readPR() {
  const pr = validPR(
    api(`/repos/${state.repository}/pulls/${state.pr.number}`),
  );
  if (pr.node_id !== state.pr.node_id) throw Error("PR identity changed");
  return pr;
}
function draft() {
  let pr = readPR();
  if (!pr.draft) {
    const converted = api("graphql", [
      "-f",
      "query=mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){pullRequest{id isDraft}}}",
      "-f",
      `id=${pr.node_id}`,
    ]);
    const result = converted?.data?.convertPullRequestToDraft?.pullRequest;
    if (
      converted.errors ||
      result?.id !== pr.node_id ||
      result?.isDraft !== true
    )
      throw Error("Draft mutation response is ambiguous");
    pr = readPR();
  }
  if (!pr.draft) throw Error("Draft quarantine could not be verified");
  save({ event: "draft-verified", pr: pr.number, head: pr.head.sha });
  return pr;
}
function hold(reason) {
  const body = `HOLD: generated release branch requires human reconciliation/review. ${reason}\nTested base: ${state.tested}\nPrior ref: ${state.prior || "absent"}\nCandidate: ${state.candidate || "not pushed"}\nObserved ref: ${state.observed || "absent/unknown"}\nWorkflow: ${process.env.GITHUB_SERVER_URL || "https://github.com"}/${state.repository}/actions/runs/${process.env.GITHUB_RUN_ID || "unknown"}\nDo not mark Ready or merge without checking this run and fresh release provenance.`;
  const posted = api(
    `/repos/${state.repository}/issues/${state.pr.number}/comments`,
    ["-f", `body=${body}`],
  );
  const validate = (comment) => {
    if (
      !Number.isSafeInteger(comment?.id) ||
      comment.id < 1 ||
      comment.body !== body ||
      comment.issue_url !==
        `https://api.github.com/repos/${state.repository}/issues/${state.pr.number}`
    )
      throw Error("HOLD comment response is ambiguous");
  };
  validate(posted);
  const recorded = api(
    `/repos/${state.repository}/issues/comments/${posted.id}`,
  );
  validate(recorded);
  if (recorded.id !== posted.id) throw Error("HOLD comment identity changed");
  save({ event: "hold-verified", pr: state.pr.number, comment: posted.id });
}
function prepare() {
  if (fs.existsSync(stateFile))
    throw Error("Fence already prepared; reconcile the recorded transaction");
  const branch = process.env.PUBLICATION_BRANCH;
  const repository = process.env.GITHUB_REPOSITORY;
  if (
    !["main", "3.1.x", "3.0.x"].includes(branch) ||
    !sha(process.env.TESTED_SHA) ||
    !/^[\w.-]+\/[\w.-]+$/.test(repository || "")
  )
    throw Error("Invalid fence authority");
  state = {
    branch,
    repository,
    tested: process.env.TESTED_SHA,
    releaseBranch: `changeset-release/${branch}`,
    ref: `refs/heads/changeset-release/${branch}`,
    events: [],
    status: "preparing",
  };
  current();
  run(process.execPath, [path.join(directory, "check.cjs"), "pending"]);
  state.title = expectedTitle();
  const pr = openPR();
  state.prior = remote();
  state.pr = pr
    ? { number: pr.number, node_id: pr.node_id, wasDraft: pr.draft }
    : null;
  save({ event: "captured", prior: state.prior, pr: state.pr });
  // Never adopt/delete an orphan branch, or mutate a PR whose ref is missing.
  if (
    Boolean(pr) !== Boolean(state.prior) ||
    (pr && pr.head.sha !== state.prior)
  )
    throw Error("PR and release ref disagree; manual reconciliation required");
  if (pr) {
    git("fetch", "--no-tags", state.url, state.ref);
    if (git("rev-parse", "FETCH_HEAD") !== state.prior)
      throw Error("Release ref changed during capture");
    state.priorTree = git("rev-parse", `${state.prior}^{tree}`);
    draft();
    hold("Automation is preparing a leased update. The PR must remain Draft.");
  }
  current();
  if (remote() !== state.prior)
    throw Error("Release ref changed during preparation");
  state.status = "prepared";
  save({ event: "prepared" });
}
function verifyPR(expected) {
  const pr = openPR();
  if (state.pr) {
    if (
      !pr ||
      pr.number !== state.pr.number ||
      pr.node_id !== state.pr.node_id ||
      pr.head.sha !== expected ||
      !pr.draft
    )
      throw Error("Release PR changed or left Draft");
  } else if (pr) throw Error("Another PR appeared during generation");
}
function reconcile(reason) {
  state.status = "quarantined";
  state.restored = false;
  save({ event: "quarantine", reason });
  const errors = [];
  try {
    // A new action-created PR may now exist. Adopt only this run's exact head;
    // never mutate an unrelated PR if lookup is ambiguous or the lease lost.
    if (!state.pr) {
      const pr = openPR();
      if (pr) {
        if (pr.head.sha !== state.candidate)
          throw Error("Unrelated PR appeared");
        state.pr = {
          number: pr.number,
          node_id: pr.node_id,
          wasDraft: pr.draft,
        };
        save({ event: "action-created-pr", pr: state.pr });
      }
    }
    if (state.pr) draft();
  } catch {
    errors.push(
      "Draft quarantine not currently verifiable; manual reconciliation required",
    );
  }
  try {
    state.observed = remote();
    if (
      state.candidate &&
      state.observed === state.candidate &&
      state.candidate !== state.prior
    ) {
      // Rollback must work after main advances. Bypass only our current-main
      // pre-push hook, and only with a lease on this transaction's new OID.
      const result = invoke(
        realGit,
        [
          "-c",
          "core.hooksPath=/dev/null",
          "push",
          state.url,
          `${state.prior || ""}:${state.ref}`,
          `--force-with-lease=${state.ref}:${state.candidate}`,
        ],
        true,
      );
      state.observed = remote();
      save({
        event: "rollback",
        acknowledged: result.status === 0,
        observed: state.observed,
      });
    }
    if (state.observed !== state.prior)
      throw Error("Rollback lost lease or failed; observed ref preserved");
    if (
      state.prior &&
      git("rev-parse", `${state.prior}^{tree}`) !== state.priorTree
    )
      throw Error("Restored content differs");
    state.restored = true;
    save({ event: "restored", observed: state.observed });
  } catch {
    errors.push(
      "Ref restoration unverified or lease lost; do not overwrite the observed ref",
    );
  }
  try {
    if (state.pr) {
      // Deleting a newly created ref may close its newly created PR. Existing
      // PRs are never deleted: their prior ref is restored and they stay Draft.
      if (state.prior || !state.restored) draft();
      hold(
        `${reason}. ${errors.join(". ") || "Prior ref restored and verified."}`,
      );
    }
  } catch {
    errors.push(
      "GitHub HOLD/update unavailable; use retained transaction evidence",
    );
  }
  state.errors = errors;
  save({
    event: "reconciliation",
    observed: state.observed,
    restored: state.restored === true,
    errors,
  });
}
function push(args) {
  if (
    state.status !== "prepared" ||
    JSON.stringify(args) !==
      JSON.stringify([
        "push",
        "origin",
        `HEAD:${state.releaseBranch}`,
        "--force",
      ])
  )
    throw Error("Unexpected or replayed Changesets push");
  current();
  verifyPR(state.prior);
  if (remote() !== state.prior)
    throw Error("Release ref lease changed before push");
  const candidate = git("rev-parse", "HEAD");
  if (
    !sha(candidate) ||
    git("rev-list", "--parents", "-n", "1", candidate) !==
      `${candidate} ${state.tested}`
  )
    throw Error("Generated head must have exactly the tested base parent");
  state.candidate = candidate;
  state.status = "pushing";
  save({ event: "push-intent", candidate });
  try {
    current();
    const result = invoke(
      realGit,
      [
        "push",
        state.url,
        `${candidate}:${state.ref}`,
        `--force-with-lease=${state.ref}:${state.prior || ""}`,
      ],
      true,
    );
    state.observed = remote();
    save({
      event: "push-result",
      acknowledged: result.status === 0,
      observed: state.observed,
    });
    if (result.status !== 0 || state.observed !== candidate)
      throw Error("Push failed or acknowledgement/ref ambiguous");
    current();
    verifyPR(candidate);
    state.status = "pushed";
    save({ event: "pushed", candidate });
  } catch (error) {
    reconcile(error.message);
    throw error;
  }
}
function finalize() {
  if (state.status === "complete") {
    // A completed transaction cannot be reopened to roll back a later human
    // Ready transition or branch change. Replays are read-only.
    current();
    if (remote() !== (state.candidate || state.prior))
      throw Error("Completed transaction ref changed");
    verifyPR(state.candidate || state.prior);
    return;
  }
  if (state.status === "quarantined" || state.status === "pushing") {
    reconcile("Incomplete or previously quarantined action");
    throw Error("Changesets transaction remains quarantined");
  }
  try {
    if (process.env.CHANGESETS_OUTCOME !== "success")
      throw Error("Changesets action did not complete successfully");
    current();
    const expected = state.candidate || state.prior;
    if (remote() !== expected) throw Error("Release ref changed after action");
    const pr = openPR();
    if (state.candidate && !pr)
      throw Error("Successful push has no verifiable Draft PR");
    if (pr) {
      if (
        (state.pr &&
          (pr.number !== state.pr.number || pr.node_id !== state.pr.node_id)) ||
        pr.head.sha !== expected ||
        !pr.draft
      )
        throw Error("Final PR identity/head/Draft mismatch");
      state.pr ||= {
        number: pr.number,
        node_id: pr.node_id,
        wasDraft: pr.draft,
      };
    }
    state.status = "complete";
    save({ event: "complete", pr: state.pr, head: expected });
  } catch (error) {
    reconcile(error.message);
    throw error;
  }
}
try {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "prepare") prepare();
  else {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (mode === "push") push(args);
    else if (mode === "finalize") finalize();
    else throw Error("Expected prepare, push, or finalize");
  }
} catch (error) {
  console.error(`::error::Changesets fence stopped: ${error.message}`);
  process.exitCode = 1;
}
