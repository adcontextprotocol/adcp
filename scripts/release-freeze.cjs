#!/usr/bin/env node
// Release freeze (RELEASING.md "Release freeze").
//
// Sets the "Release freeze" commit status on the head of every open pull
// request to a release branch: failure while that branch has a release in
// flight, success otherwise. A branch has a release in flight when any of:
//
//   1. its Version Packages PR (head changeset-release/<branch> in this
//      repository) is open and not Draft;
//   2. the package.json version on the branch has no published GitHub Release
//      (a committed but unpublished release, including one stranded by a
//      failed run or awaiting supersession);
//   3. a Release run for a release commit on the branch, or any Release
//      dispatch (recovery or prepare_next), or a CDN recovery run, has not
//      completed.
//
// The Version Packages PR itself and PRs labelled `release` (supersession and
// recovery fixes) are exempt. Every run sweeps every release branch, so a run
// that GitHub's concurrency drops in favour of a newer one loses nothing.
//
// This reads repository metadata through the GitHub API only. It never
// checks out, fetches or runs pull request code, and no pull request text is
// interpolated into a shell. Any failure to establish a branch's state posts
// `error` (fail closed) on its non-exempt pull requests and exits non-zero.
"use strict";
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

const CONTEXT = "Release freeze";
const EXEMPT_LABEL = "release";
const RELEASE_BRANCHES = ["main", "3.2.x", "3.1.x", "3.0.x"];
const RELEASE_WORKFLOW = "release.yml";
const CDN_RECOVERY_WORKFLOW = "recover-protocol-cdn.yml";
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const shaPattern = /^[0-9a-f]{40}$/;
const repositoryPattern = /^[\w.-]+\/[\w.-]+$/;

const releasePrHead = (branch) => `changeset-release/${branch}`;
const isVersionPackagesPr = (pr, branch, repository) =>
  pr.headRepository === repository && pr.headRef === releasePrHead(branch);

// Why `branch` is frozen; an empty list means no release is in flight.
function freezeReasons({ branch, version, published, releasePulls, runs }) {
  const reasons = [];
  for (const pr of releasePulls)
    if (!pr.draft) reasons.push(`Version Packages PR #${pr.number} is ready for review`);
  if (!published) reasons.push(`${version} is committed on ${branch} without a published GitHub Release`);
  for (const run of runs) {
    if (run.workflow === CDN_RECOVERY_WORKFLOW) reasons.push(`CDN recovery run ${run.id} is in progress`);
    else if (run.event === "workflow_dispatch") reasons.push(`release dispatch run ${run.id} is in progress`);
    else if (run.releaseCommit) reasons.push(`release run ${run.id} is publishing ${run.headSha.slice(0, 12)}`);
  }
  return reasons;
}

// Commit status descriptions are limited to 140 characters.
const describe = (text) => (text.length <= 140 ? text : `${text.slice(0, 139)}…`);

// The status for one pull request. `reasons` is null when the branch's state
// could not be established.
function decide(pr, branch, reasons, repository) {
  if (isVersionPackagesPr(pr, branch, repository))
    return { state: "success", description: "Version Packages PR: exempt from the release freeze" };
  if (pr.labels.includes(EXEMPT_LABEL))
    return { state: "success", description: `Labelled "${EXEMPT_LABEL}": exempt from the release freeze` };
  if (reasons === null)
    return { state: "error", description: `Could not determine whether a ${branch} release is in flight; retrying` };
  if (reasons.length) {
    const more = reasons.length > 1 ? ` (+${reasons.length - 1} more)` : "";
    return { state: "failure", description: describe(`Release in flight: ${reasons[0]}${more}. Merge after it publishes.`) };
  }
  return { state: "success", description: `No ${branch} release in flight` };
}

// A head shared by pull requests to several branches gets the most
// restrictive status.
const severity = { success: 0, error: 1, failure: 2 };

function branchState(api, branch, pulls, repository) {
  const head = api.branchHead(branch);
  let version;
  try {
    version = JSON.parse(head.packageJson).version;
  } catch {
    throw new Error(`package.json at ${branch} ${head.sha} is not JSON`);
  }
  if (!versionPattern.test(version || "")) throw new Error(`package.json at ${branch} ${head.sha} has no exact version`);
  const releasePulls = pulls
    .filter((pr) => isVersionPackagesPr(pr, branch, repository))
    .map((pr) => ({ number: pr.number, draft: pr.draft }));
  const runs = [
    ...api.inFlightRuns(RELEASE_WORKFLOW, branch),
    ...(branch === "main" ? api.inFlightRuns(CDN_RECOVERY_WORKFLOW, branch) : []),
  ].map((run) => ({
    ...run,
    releaseCommit:
      run.workflow === RELEASE_WORKFLOW && run.event !== "workflow_dispatch" ? api.isReleaseCommit(run.headSha) : false,
  }));
  return { branch, version, published: api.publishedRelease(`v${version}`), releasePulls, runs };
}

function sweep(api, { repository, branches = RELEASE_BRANCHES, targetUrl, log = console.log }) {
  if (!repositoryPattern.test(repository || "")) throw new Error("A repository (owner/name) is required.");
  const byHead = new Map();
  const summary = [];
  let failed = false;
  for (const branch of branches) {
    let pulls;
    try {
      pulls = api.openPulls(branch);
    } catch (error) {
      failed = true;
      summary.push({ branch, error: `could not list open pull requests: ${error.message}` });
      continue;
    }
    let reasons = null;
    try {
      reasons = freezeReasons(branchState(api, branch, pulls, repository));
      summary.push({ branch, reasons, pulls: pulls.length });
    } catch (error) {
      failed = true;
      summary.push({ branch, error: error.message, pulls: pulls.length });
    }
    for (const pr of pulls) {
      if (!shaPattern.test(pr.headSha || "")) {
        failed = true;
        continue;
      }
      const decision = decide(pr, branch, reasons, repository);
      const entry = byHead.get(pr.headSha);
      if (!entry || severity[decision.state] > severity[entry.decision.state])
        byHead.set(pr.headSha, { decision, current: pr.currentStatus, numbers: [...(entry?.numbers || []), pr.number] });
      else entry.numbers.push(pr.number);
    }
  }
  let written = 0;
  for (const [sha, { decision, current, numbers }] of byHead) {
    if (current && current.state === decision.state && current.description === decision.description) continue;
    try {
      api.setStatus(sha, { ...decision, context: CONTEXT, targetUrl });
      written++;
      log(`#${numbers.join(", #")} ${sha.slice(0, 12)}: ${decision.state} - ${decision.description}`);
    } catch (error) {
      failed = true;
      log(`#${numbers.join(", #")} ${sha.slice(0, 12)}: could not set status: ${error.message}`);
    }
  }
  return { failed, summary, written, heads: byHead.size };
}

// --- GitHub adapter (gh CLI) ------------------------------------------------

function ghApi(repository, runGh = defaultGh) {
  const [owner, name] = String(repository).split("/");
  const graphql = (query, variables) => {
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [key, value] of Object.entries(variables))
      if (value !== null && value !== undefined) args.push("-f", `${key}=${value}`);
    const response = JSON.parse(runGh(args));
    if (response.errors?.length) throw new Error(`GraphQL: ${response.errors.map((e) => e.message).join("; ")}`);
    if (!response.data?.repository) throw new Error("GraphQL response has no repository");
    return response.data.repository;
  };
  const blobText = (entry) => entry?.object?.text;
  const versionOf = (text) => {
    try {
      const version = JSON.parse(text).version;
      return versionPattern.test(version || "") ? version : null;
    } catch {
      return null;
    }
  };

  return {
    openPulls(branch) {
      const pulls = [];
      let cursor = null;
      for (let page = 0; page < 20; page++) {
        const repo = graphql(
          `query($owner:String!,$name:String!,$base:String!,$cursor:String){repository(owner:$owner,name:$name){pullRequests(states:OPEN,baseRefName:$base,first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{number isDraft headRefName headRefOid headRepository{nameWithOwner} labels(first:100){nodes{name}} commits(last:1){nodes{commit{oid status{context(name:"${CONTEXT}"){state description}}}}}}}}}`,
          { owner, name, base: branch, cursor },
        );
        const connection = repo.pullRequests;
        if (!connection || !Array.isArray(connection.nodes)) throw new Error("Malformed pull request page");
        for (const node of connection.nodes) {
          const head = node.commits?.nodes?.[0]?.commit;
          const status = head?.oid === node.headRefOid ? head.status?.context : null;
          pulls.push({
            number: node.number,
            draft: node.isDraft === true,
            headRef: node.headRefName,
            headSha: node.headRefOid,
            headRepository: node.headRepository?.nameWithOwner ?? null,
            labels: (node.labels?.nodes || []).map((label) => label.name),
            currentStatus: status ? { state: String(status.state).toLowerCase(), description: status.description } : null,
          });
        }
        if (!connection.pageInfo?.hasNextPage) return pulls;
        cursor = connection.pageInfo.endCursor;
      }
      throw new Error("Too many open pull requests to page through");
    },
    branchHead(branch) {
      const repo = graphql(
        `query($owner:String!,$name:String!,$ref:String!){repository(owner:$owner,name:$name){ref(qualifiedName:$ref){target{oid ... on Commit{file(path:"package.json"){object{... on Blob{text}}}}}}}}`,
        { owner, name, ref: `refs/heads/${branch}` },
      );
      const target = repo.ref?.target;
      if (!shaPattern.test(target?.oid || "")) throw new Error(`Branch ${branch} has no readable head`);
      const packageJson = blobText(target.file);
      if (typeof packageJson !== "string") throw new Error(`Branch ${branch} has no readable package.json`);
      return { sha: target.oid, packageJson };
    },
    publishedRelease(tag) {
      const repo = graphql(
        `query($owner:String!,$name:String!,$tag:String!){repository(owner:$owner,name:$name){release(tagName:$tag){tagName isDraft}}}`,
        { owner, name, tag },
      );
      const release = repo.release;
      if (release === null) return false;
      if (typeof release?.isDraft !== "boolean" || release.tagName !== tag) throw new Error(`Malformed release ${tag}`);
      return release.isDraft === false;
    },
    inFlightRuns(workflow, branch) {
      // The newest 100 runs on the branch: the release queue holds at most
      // 100 pending runs, so an incomplete run cannot be older than that.
      const response = JSON.parse(
        runGh([
          "api",
          `/repos/${repository}/actions/workflows/${workflow}/runs?branch=${encodeURIComponent(branch)}&per_page=100&exclude_pull_requests=true`,
        ]),
      );
      if (!Array.isArray(response?.workflow_runs)) throw new Error(`Malformed ${workflow} run list`);
      return response.workflow_runs
        .filter((run) => run?.status !== "completed")
        .map((run) => {
          if (!Number.isSafeInteger(run?.id) || !shaPattern.test(run.head_sha || "") || typeof run.event !== "string")
            throw new Error(`Malformed ${workflow} run`);
          return { id: run.id, workflow, event: run.event, status: run.status, headSha: run.head_sha };
        });
    },
    // A Version Packages merge changes the package version relative to its
    // first parent. Anything unreadable counts as a release commit.
    isReleaseCommit(sha) {
      const repo = graphql(
        `query($owner:String!,$name:String!,$oid:GitObjectID!){repository(owner:$owner,name:$name){object(oid:$oid){... on Commit{file(path:"package.json"){object{... on Blob{text}}} parents(first:1){nodes{file(path:"package.json"){object{... on Blob{text}}}}}}}}}`,
        { owner, name, oid: sha },
      );
      const commit = repo.object;
      const version = versionOf(blobText(commit?.file));
      const parent = commit?.parents?.nodes?.[0];
      if (!version || !parent) return true;
      const parentVersion = versionOf(blobText(parent.file));
      return !parentVersion || parentVersion !== version;
    },
    setStatus(sha, { state, description, context, targetUrl }) {
      runGh([
        "api",
        "--method",
        "POST",
        `/repos/${repository}/statuses/${sha}`,
        "-f",
        `state=${state}`,
        "-f",
        `context=${context}`,
        "-f",
        `description=${description}`,
        ...(targetUrl ? ["-f", `target_url=${targetUrl}`] : []),
      ]);
    },
  };
}

function defaultGh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0)
    throw new Error((result.stderr || result.error?.message || `gh exited ${result.status}`).trim().split("\n")[0]);
  return result.stdout;
}

function writeSummary(result) {
  const lines = ["## Release freeze", "", "| Branch | Open PRs | State |", "| --- | --- | --- |"];
  for (const entry of result.summary) {
    const state = entry.error
      ? `unknown (${entry.error})`
      : entry.reasons.length
        ? `frozen: ${entry.reasons.join("; ")}`
        : "open";
    // Escape backslashes as well as pipes so a cell cannot end early.
    const cell = state.replace(/[\\|]/g, (character) => `\\${character}`).replace(/[\r\n]+/g, " ");
    lines.push(`| ${entry.branch} | ${entry.pulls ?? "?"} | ${cell} |`);
  }
  lines.push("", `${result.written} status update(s) across ${result.heads} pull request head(s).`);
  const text = lines.join("\n") + "\n";
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  console.log(text);
}

module.exports = { CONTEXT, EXEMPT_LABEL, RELEASE_BRANCHES, freezeReasons, decide, sweep, ghApi };

if (require.main === module) {
  const [mode] = process.argv.slice(2);
  try {
    if (mode !== "sweep") throw new Error("Usage: release-freeze.cjs sweep");
    const repository = process.env.GITHUB_REPOSITORY;
    const runUrl =
      process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : undefined;
    const result = sweep(ghApi(repository), { repository, targetUrl: runUrl });
    writeSummary(result);
    if (result.failed) {
      console.error("::error::The release freeze state could not be fully established; affected pull requests are marked error.");
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
