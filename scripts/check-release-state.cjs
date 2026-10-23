#!/usr/bin/env node
// Release/deploy fences. Remote failures are errors, never evidence of absence.
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const run = (command, args) =>
  execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const git = (...args) => run("git", args);
const shaPattern = /^[a-f0-9]{40}$/;

const supportedBranches = ["main", "3.2.x", "3.1.x", "3.0.x"];
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function publicationTarget() {
  const expected = process.env.TESTED_SHA || process.env.GITHUB_SHA;
  const branch = process.env.PUBLICATION_BRANCH || process.env.GITHUB_REF_NAME;
  if (!shaPattern.test(expected || "") || !supportedBranches.includes(branch)) {
    throw new Error(
      "Publication requires an exact tested SHA and a supported release branch.",
    );
  }
  return { expected, branch };
}

const staleMessage = (expected, branch, observed, reason) =>
  `Refusing stale tested SHA ${expected}; origin/${branch} is ${observed || "unavailable"}${reason ? ` (${reason})` : ""}. Use the current branch and the explicit recovery procedure in RELEASING.md.`;

// Strict freshness: origin/<branch> must still be exactly the tested commit.
// Generation (Changesets), pending, recovery and deploy decisions use this.
function current() {
  const { expected, branch } = publicationTarget();
  const remote = git(
    "ls-remote",
    "--exit-code",
    "origin",
    `refs/heads/${branch}`,
  );
  if (remote !== `${expected}\trefs/heads/${branch}`) {
    throw new Error(staleMessage(expected, branch, remote));
  }
  return expected;
}

// Publication-scoped freshness, only for a run publishing an already-committed
// release. The strict fence stops a stale run from publishing over a newer
// release or over changed release artifacts. A later branch commit is neither
// when it descends from the tested commit, keeps the package version, and
// leaves this version's artifacts and the release-authority files untouched.
// Anything else, including any remote or Git failure, still refuses.
function publicationCurrent(extraVersions = []) {
  const { expected, branch } = publicationTarget();
  for (let attempt = 1; ; attempt++) {
    const remote = git(
      "ls-remote",
      "--exit-code",
      "origin",
      `refs/heads/${branch}`,
    );
    if (remote === `${expected}\trefs/heads/${branch}`) return expected;
    const [head, ref, ...rest] = remote.split("\t");
    if (!shaPattern.test(head || "") || ref !== `refs/heads/${branch}` || rest.length)
      throw new Error(staleMessage(expected, branch, remote));
    const refuse = (reason) =>
      new Error(staleMessage(expected, branch, head, reason));
    // Fetch the advertised head unless it is already a local commit (objects
    // are content-addressed); the fetched OID must be exactly that head.
    let present = true;
    try {
      git("cat-file", "-e", `${head}^{commit}`);
    } catch {
      present = false;
    }
    if (!present) {
      try {
        git("fetch", "--no-tags", "--quiet", "origin", `refs/heads/${branch}`);
      } catch (error) {
        throw refuse(`could not fetch the advanced head: ${error.message.trim()}`);
      }
      const fetched = git("rev-parse", "FETCH_HEAD");
      if (fetched !== head) {
        // The branch moved again between ls-remote and fetch: re-read it.
        if (attempt < 3) continue;
        throw refuse(`fetched ${fetched}, not the advertised head`);
      }
    }
    try {
      git("merge-base", "--is-ancestor", expected, head);
    } catch {
      throw refuse("the tested commit is not an ancestor of the branch head");
    }
    // Compare the parsed version only: dependency bumps also edit package.json.
    const versionAt = (sha) => {
      const version = JSON.parse(git("show", `${sha}:package.json`)).version;
      if (!versionPattern.test(version || ""))
        throw refuse(`package.json at ${sha} has no exact version`);
      return version;
    };
    const version = versionAt(expected);
    if (versionAt(head) !== version)
      throw refuse("the package version changed after the tested commit");
    const versions = [version, ...extraVersions.filter(Boolean)];
    const authority = [".changeset/pre.json", ".changeset/release-supersession.json"];
    const releasePath = (file) =>
      authority.includes(file) ||
      versions.some(
        (v) =>
          [`dist/schemas/${v}`, `dist/compliance/${v}`].some(
            (tree) => file === tree || file.startsWith(`${tree}/`),
          ) || file.startsWith(`dist/protocol/${v}.tgz`),
      );
    // --no-renames reports both sides of a move into or out of a release path.
    const changed = git("diff", "--name-only", "--no-renames", "-z", expected, head)
      .split("\0")
      .filter((file) => file && releasePath(file));
    if (changed.length)
      throw refuse(`later commits change release paths: ${changed.slice(0, 5).join(", ")}`);
    const count = git("rev-list", "--count", `${expected}..${head}`);
    console.log(
      `Publication fence accepted origin/${branch} advance from tested ${expected} to ${head} (${count} commit(s)); version ${version}, its artifacts and the release-authority files are unchanged.`,
    );
    return expected;
  }
}

// Read metadata and bytes through one opened descriptor. O_NOFOLLOW refuses a
// leaf replaced with a symlink; fstat checks the exact inode read below.
function readPublicationFile(file, expectedMode) {
  const descriptor = fs.openSync(
    file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const metadata = fs.fstatSync(descriptor);
    const mode = metadata.mode & 0o111 ? "100755" : "100644";
    if (!metadata.isFile() || (expectedMode && (mode !== expectedMode || metadata.mode & 0o7000)))
      throw new Error(`Uncommitted publication file or mode: ${file}`);
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

// Publication authority applies to this checkout's committed current version,
// not to arbitrary historical artifacts that happen to remain in dist/.
function committed(version) {
  const tested = publicationCurrent();
  const source = process.env.RELEASE_SHA;
  if (!shaPattern.test(source || "") || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version || ""))
    throw new Error("Committed publication requires an exact original release SHA and version.");
  if (git("rev-parse", "HEAD") !== tested)
    throw new Error("Local checkout is not the current tested publication commit.");
  git("merge-base", "--is-ancestor", source, tested);
  const localPackage = readPublicationFile("package.json");
  const testedPackage = execFileSync("git", ["show", `${tested}:package.json`], { stdio: ["ignore", "pipe", "pipe"] });
  const localVersion = JSON.parse(localPackage).version;
  const testedVersion = JSON.parse(testedPackage).version;
  const sourceVersion = JSON.parse(git("show", `${source}:package.json`)).version;
  if (version !== localVersion || version !== sourceVersion || version !== testedVersion)
    throw new Error("Publication version must equal the local, current tested and original committed package version; historical recovery is separate.");
  if (!localPackage.equals(testedPackage))
    throw new Error("Local package authority differs from the current tested commit.");
  for (const ancestor of ["dist", "dist/schemas", "dist/compliance", "dist/protocol"]) {
    const metadata = fs.lstatSync(ancestor);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error(`Symlinked or non-directory publication ancestor: ${ancestor}`);
  }
  const surfaces = [
    `dist/schemas/${version}`,
    `dist/compliance/${version}`,
    ...["", ".sha256", ".sig", ".crt"].map(suffix => `dist/protocol/${version}.tgz${suffix}`),
  ];
  for (const surface of surfaces) git("cat-file", "-e", `${source}:${surface}`);
  if (git("diff", "--name-only", source, tested, "--", ...surfaces))
    throw new Error("Current tested publication artifacts differ from the original release commit.");
  // One tree read and local raw blob hashing include ignored/untracked files,
  // executable-mode changes even when core.fileMode=false, and symlinks.
  const expected = new Map();
  for (const row of git("ls-tree", "-r", "-z", source, "--", ...surfaces).split("\0").filter(Boolean)) {
    const separator = row.indexOf("\t");
    const [mode, type, oid] = row.slice(0, separator).split(" ");
    const file = row.slice(separator + 1);
    if (separator < 0 || type !== "blob" || !["100644", "100755"].includes(mode) || !shaPattern.test(oid) || expected.has(file))
      throw new Error("Committed publication contains an unsupported or ambiguous file.");
    expected.set(file, { mode, oid });
  }
  const actual = new Set();
  const inspect = file => {
    const metadata = fs.lstatSync(file);
    if (metadata.isSymbolicLink()) throw new Error(`Symlinked publication surface: ${file}`);
    if (metadata.isDirectory()) {
      for (const child of fs.readdirSync(file)) inspect(path.join(file, child));
      return;
    }
    const entry = expected.get(file);
    if (!entry)
      throw new Error(`Uncommitted publication file or mode: ${file}`);
    const bytes = readPublicationFile(file, entry.mode);
    const oid = crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (oid !== entry.oid) throw new Error(`Publication bytes differ from original commit: ${file}`);
    actual.add(file);
  };
  for (const surface of surfaces) inspect(surface);
  if (actual.size !== expected.size) throw new Error("Publication file set differs from the original committed tree.");
  publicationCurrent();
}

// `pending` is a generation-time check and passes the strict fence instead.
function published(
  version = JSON.parse(fs.readFileSync("package.json")).version,
  releaseSha,
  fence = publicationCurrent,
) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error("Invalid release version.");
  const tag = `v${version}`;
  const refs = git(
    "ls-remote",
    "--exit-code",
    "origin",
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  )
    .split("\n")
    .map((line) => line.split("\t"));
  const target =
    refs.find(([, ref]) => ref.endsWith("^{}"))?.[0] || refs[0]?.[0];
  if (!shaPattern.test(target || "") || (releaseSha && target !== releaseSha)) {
    throw new Error(
      `Tag ${tag} does not identify the approved release commit ${releaseSha || ""}.`,
    );
  }
  const paths = [
    `dist/schemas/${version}`,
    `dist/compliance/${version}`,
    ...["", ".sha256", ".sig", ".crt"].map(
      (s) => `dist/protocol/${version}.tgz${s}`,
    ),
  ];
  if (git("diff", "--name-only", target, "--", ...paths))
    throw new Error("Local release artifacts differ from the published tag.");
  const release = JSON.parse(
    run("gh", [
      "release",
      "view",
      tag,
      "--json",
      "tagName,isDraft,isPrerelease,assets",
    ]),
  );
  const names = Array.isArray(release?.assets)
    ? release.assets.map((asset) => asset?.name)
    : [];
  if (
    release.tagName !== tag ||
    release.isDraft !== false ||
    release.isPrerelease !== version.includes("-") ||
    names.length !== 4 ||
    new Set(names).size !== 4 ||
    !["", ".sha256", ".sig", ".crt"].every((suffix) =>
      names.includes(`${version}.tgz${suffix}`),
    )
  ) {
    throw new Error(
      `Release ${tag} is not published with the complete signed tuple.`,
    );
  }
  // Names/digests alone do not prove that recovery preserves the published
  // tuple. Compare all four assets, including signature and certificate bytes.
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "adcp-release-"));
  try {
    for (const suffix of ["", ".sha256", ".sig", ".crt"]) {
      const name = `${version}.tgz${suffix}`;
      git("cat-file", "-e", `${target}:dist/protocol/${name}`);
      run("gh", [
        "release",
        "download",
        tag,
        "--pattern",
        name,
        "--dir",
        temporary,
      ]);
      try {
        run("cmp", ["-s", `dist/protocol/${name}`, path.join(temporary, name)]);
      } catch {
        throw new Error(
          `GitHub release asset ${name} differs from the tagged local tuple.`,
        );
      }
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  fence([version]);
}

function recovery(source) {
  const tested = current();
  if (!shaPattern.test(source || ""))
    throw new Error("Recovery requires the original release merge SHA.");
  git("merge-base", "--is-ancestor", source, tested);
  const version = JSON.parse(git("show", `${source}:package.json`)).version;
  if (version !== JSON.parse(fs.readFileSync("package.json")).version)
    throw new Error("Recovery must precede the next version bump.");
  const paths = [
    `dist/schemas/${version}`,
    `dist/compliance/${version}`,
    ...["", ".sha256", ".sig", ".crt"].map(
      (s) => `dist/protocol/${version}.tgz${s}`,
    ),
  ];
  for (const path of paths) git("cat-file", "-e", `${source}:${path}`);
  if (git("diff", "--name-only", source, tested, "--", ...paths))
    throw new Error(
      "Recovery artifacts differ from the original approved commit.",
    );
}

function reviewedSupersession(version) {
  const markerPath = path.join(".changeset", "release-supersession.json");
  if (!fs.existsSync(markerPath)) return false;
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  if (marker?.version !== version)
    throw new Error("Supersession marker does not match the pending release version.");
  run(process.execPath, [
    path.join("scripts", "check-release-supersession.cjs"),
    "verify",
  ]);
  current();
  return true;
}

function provenance(source, head) {
  if (!shaPattern.test(source || "") || !shaPattern.test(head || ""))
    throw new Error(
      "Release provenance requires exact merge and reviewed head SHAs.",
    );
  const generated = git("rev-list", "--parents", "-n", "1", head).split(" ");
  const merged = git("rev-list", "--parents", "-n", "1", source).split(" ");
  if (
    generated.length !== 2 ||
    ![2, 3].includes(merged.length) ||
    generated[1] !== merged[1] ||
    (merged.length === 3 && merged[2] !== head) ||
    git("rev-parse", `${head}^{tree}`) !== git("rev-parse", `${source}^{tree}`)
  ) {
    throw new Error(
      "Quarantined release: the reviewed generated head must have the merge's exact base parent and released tree. A stale existing PR update cannot authorize publication; see RELEASING.md.",
    );
  }
}

const identity = (user) =>
  Number.isSafeInteger(user?.id) &&
  user.id > 0 &&
  typeof user.login === "string" &&
  /^[a-z0-9][a-z0-9-]{0,38}(?:\[bot\])?$/i.test(user.login);

function repositoryApi(repository) {
  return (endpoint, paginate = false) => {
    const value = JSON.parse(
      run("gh", [
        "api",
        ...(paginate ? ["--paginate", "--slurp"] : []),
        `/repos/${repository}${endpoint}`,
      ]),
    );
    if (!paginate) return value;
    if (!Array.isArray(value) || !value.every(Array.isArray))
      throw new Error("Ambiguous paginated approval response.");
    return value.flat();
  };
}

// Identify exactly one merged release PR for the release merge `source`.
function mergedReleasePr(api, source, repository, branch) {
  const associated = api(`/commits/${source}/pulls`, true);
  if (
    !associated.every(
      (pr) =>
        pr &&
        Number.isSafeInteger(pr.number) &&
        pr.number > 0 &&
        typeof pr.base?.ref === "string" &&
        (pr.merged_at === null ||
          (typeof pr.merged_at === "string" &&
            Number.isFinite(Date.parse(pr.merged_at)))),
    )
  )
    throw new Error("Malformed associated release PR response.");
  const pulls = associated.filter(
    (pr) => pr.merged_at && pr.base?.ref === branch,
  );
  if (
    pulls.length !== 1 ||
    !Number.isSafeInteger(pulls[0].number) ||
    pulls[0].number < 1
  )
    throw new Error(
      "Release commit must identify exactly one merged release PR.",
    );
  const pr = api(`/pulls/${pulls[0].number}`);
  const head = pr.head?.sha;
  if (
    pr.number !== pulls[0].number ||
    pr.merged !== true ||
    pr.merge_commit_sha !== source ||
    pr.base?.ref !== branch ||
    pr.base.repo?.full_name !== repository ||
    !shaPattern.test(head || "") ||
    !identity(pr.user)
  )
    throw new Error("Ambiguous merged release PR identity.");
  return { pr, head };
}

// Provenance must read the immutable reviewed head commit itself.
function fetchReviewedHead(number, head) {
  try {
    git("cat-file", "-e", `${head}^{commit}`);
  } catch {
    git("fetch", "--no-tags", "origin", `refs/pull/${number}/head`);
    if (git("rev-parse", "FETCH_HEAD") !== head)
      throw new Error(
        "Fetched release PR head differs from its approval record.",
      );
  }
}

function approval() {
  const tested = publicationCurrent();
  const source = process.env.RELEASE_SHA;
  const repository = process.env.GITHUB_REPOSITORY;
  const branch = process.env.PUBLICATION_BRANCH || process.env.GITHUB_REF_NAME;
  if (
    !shaPattern.test(source || "") ||
    !/^[\w.-]+\/[\w.-]+$/.test(repository || "")
  )
    throw new Error("Approval requires an exact release SHA and repository.");
  git("merge-base", "--is-ancestor", source, tested);
  const api = repositoryApi(repository);
  const { pr, head } = mergedReleasePr(api, source, repository, branch);

  const reviews = api(`/pulls/${pr.number}/reviews`, true);
  if (
    new Set(reviews.map((review) => review?.id)).size !== reviews.length ||
    !reviews.every(
      (review) =>
        identity(review.user) &&
        Number.isSafeInteger(review.id) &&
        review.id > 0 &&
        typeof review.submitted_at === "string" &&
        Number.isFinite(Date.parse(review.submitted_at)),
    )
  )
    throw new Error("Ambiguous release review identity or ordering.");
  const latest = new Map();
  reviews.sort(
    (a, b) =>
      Date.parse(a.submitted_at) - Date.parse(b.submitted_at) || a.id - b.id,
  );
  for (const review of reviews) {
    if (review.state !== "COMMENTED") latest.set(review.user.id, review);
  }
  let trusted = 0;
  for (const review of latest.values()) {
    const user = review.user;
    if (
      review.state !== "APPROVED" ||
      review.commit_id !== head ||
      user.type !== "User" ||
      user.id === pr.user.id ||
      user.login.toLowerCase() === pr.user.login.toLowerCase()
    )
      continue;
    // Current effective access, not public-review ability or author_association.
    // GitHub maps maintain to permission=write and triage to permission=read.
    // https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user
    const access = api(
      `/collaborators/${encodeURIComponent(user.login)}/permission`,
    );
    if (
      !identity(access?.user) ||
      access.user.id !== user.id ||
      access.user.type !== "User" ||
      access.user.login.toLowerCase() !== user.login.toLowerCase()
    )
      throw new Error("Ambiguous collaborator permission identity.");
    const role = `${access.permission}:${access.role_name}`;
    if (
      [
        "write:write",
        "write:maintain",
        "admin:admin",
      ].includes(role)
    )
      trusted++;
    else if (!["read:read", "read:triage", "none:none"].includes(role))
      throw new Error("Ambiguous or unsupported collaborator permission.");
  }
  if (!trusted)
    throw new Error(
      "Release PR has no current write/maintain/admin non-author approval on its final head.",
    );

  // An App push updates an already-open PR before the post-push fence runs.
  // Validate immutable commit provenance again at publication, even if an
  // administrator merged that stale update through non-strict branch rules.
  fetchReviewedHead(pr.number, head);
  provenance(source, head);
  publicationCurrent();
  console.log(
    `Release PR #${pr.number} has ${trusted} trusted maintainer approval(s) and matching merge provenance.`,
  );
}

// Storyboard jobs in training-agent-storyboards.yml. The aggregate /sales
// job and both matrix surfaces must be present; every job must succeed, so a
// Draft run that skipped its matrix, or any cancelled/failed job, never counts.
const storyboardWorkflow = "training-agent-storyboards.yml";
function storyboardJobsPassed(jobs) {
  const names = jobs.map((job) => job?.name);
  return (
    jobs.length > 0 &&
    jobs.every(
      (job) =>
        typeof job?.name === "string" &&
        job.status === "completed" &&
        job.conclusion === "success",
    ) &&
    names.some((name) => name.startsWith("Storyboards (current /")) &&
    names.some((name) => name.startsWith("Storyboards (3.0-compat /")) &&
    names.includes("Storyboards (current /sales)")
  );
}

// Optimization only: proves that a Version Packages push merges the exact
// approved head whose pull_request storyboard run passed, so verify-release
// need not re-run the matrix. Any failure falls back to full verification;
// publication authority (approval/provenance in the release job) is separate.
function verifiedMerge() {
  const source = process.env.GITHUB_SHA;
  const repository = process.env.GITHUB_REPOSITORY;
  const branch = process.env.PUBLICATION_BRANCH || process.env.GITHUB_REF_NAME;
  if (
    !shaPattern.test(source || "") ||
    !/^[\w.-]+\/[\w.-]+$/.test(repository || "") ||
    !supportedBranches.includes(branch)
  )
    throw new Error("Verified merge requires an exact pushed SHA, repository and supported branch.");
  const api = repositoryApi(repository);
  const { pr, head } = mergedReleasePr(api, source, repository, branch);
  fetchReviewedHead(pr.number, head);
  provenance(source, head);
  const pages = (endpoint, key) => {
    const value = JSON.parse(
      run("gh", ["api", "--paginate", "--slurp", `/repos/${repository}${endpoint}`]),
    );
    if (!Array.isArray(value) || !value.every((page) => Array.isArray(page?.[key])))
      throw new Error(`Ambiguous paginated ${key} response.`);
    return value.flatMap((page) => page[key]);
  };
  const runs = pages(
    `/actions/workflows/${storyboardWorkflow}/runs?head_sha=${head}&event=pull_request&status=completed&per_page=100`,
    "workflow_runs",
  ).filter(
    (candidate) =>
      Number.isSafeInteger(candidate?.id) &&
      candidate.id > 0 &&
      candidate.head_sha === head &&
      candidate.event === "pull_request" &&
      candidate.status === "completed" &&
      candidate.conclusion === "success",
  );
  for (const candidate of runs) {
    const jobs = pages(`/actions/runs/${candidate.id}/jobs?filter=latest&per_page=100`, "jobs");
    if (storyboardJobsPassed(jobs)) {
      console.log(
        `Release merge ${source} is release PR #${pr.number} head ${head} with matching provenance; storyboard run ${candidate.id} passed on that exact head.`,
      );
      return;
    }
  }
  throw new Error(
    `No completed pull_request ${storyboardWorkflow} run with every storyboard job successful exists for release PR head ${head}.`,
  );
}

const [mode, argument] = process.argv.slice(2);
try {
  if (mode === "current") current();
  else if (mode === "publication-current") publicationCurrent([argument]);
  else if (mode === "committed") committed(argument);
  else if (mode === "published") {
    publicationCurrent([argument]);
    published(argument, process.env.RELEASE_SHA);
  } else if (mode === "pending") {
    current();
    const version = JSON.parse(fs.readFileSync("package.json")).version;
    const surfaces = [
      `dist/schemas/${version}`,
      `dist/compliance/${version}`,
      ...["", ".sha256", ".sig", ".crt"].map(
        (suffix) => `dist/protocol/${version}.tgz${suffix}`,
      ),
    ];
    if (
      surfaces.some((surface) => fs.existsSync(surface)) &&
      !reviewedSupersession(version)
    )
      published(version, undefined, current);
  } else if (mode === "recovery") recovery(argument);
  else if (mode === "approval") approval();
  else if (mode === "provenance") {
    publicationCurrent();
    provenance(process.env.RELEASE_SHA, argument);
  } else if (mode === "verified-merge") verifiedMerge();
  else
    throw new Error(
      "Expected current, publication-current, committed, published, pending, recovery, approval, provenance, or verified-merge.",
    );
} catch (error) {
  if (mode === "verified-merge") {
    console.error(
      `::notice::Release merge is not provenance-verified (${error.message}); running full storyboard verification.`,
    );
  } else {
    console.error(
      `::error::${error.message}\nPublication stopped. Recovery requires current tested main and original release authority; provenance mismatches remain quarantined pending a separately reviewed plan. See RELEASING.md. Do not rerun an obsolete workflow.`,
    );
  }
  process.exitCode = 1;
}
