#!/usr/bin/env node
// Release/deploy fences. Remote failures are errors, never evidence of absence.
const { execFileSync } = require("node:child_process");
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

function current() {
  const expected = process.env.TESTED_SHA || process.env.GITHUB_SHA;
  const branch = process.env.PUBLICATION_BRANCH || process.env.GITHUB_REF_NAME;
  if (
    !shaPattern.test(expected || "") ||
    !["main", "3.1.x", "3.0.x"].includes(branch)
  ) {
    throw new Error(
      "Publication requires an exact tested SHA and a supported release branch.",
    );
  }
  const remote = git(
    "ls-remote",
    "--exit-code",
    "origin",
    `refs/heads/${branch}`,
  );
  if (remote !== `${expected}\trefs/heads/${branch}`) {
    throw new Error(
      `Refusing stale tested SHA ${expected}; origin/${branch} is ${remote || "unavailable"}. Use the current branch and the explicit recovery procedure in RELEASING.md.`,
    );
  }
  return expected;
}

function published(
  version = JSON.parse(fs.readFileSync("package.json")).version,
  releaseSha,
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
  current();
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

function approval() {
  const tested = current();
  const source = process.env.RELEASE_SHA;
  const repository = process.env.GITHUB_REPOSITORY;
  const branch = process.env.PUBLICATION_BRANCH || process.env.GITHUB_REF_NAME;
  if (
    !shaPattern.test(source || "") ||
    !/^[\w.-]+\/[\w.-]+$/.test(repository || "")
  )
    throw new Error("Approval requires an exact release SHA and repository.");
  git("merge-base", "--is-ancestor", source, tested);
  const api = (endpoint, paginate = false) => {
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
  const identity = (user) =>
    Number.isSafeInteger(user?.id) &&
    user.id > 0 &&
    typeof user.login === "string" &&
    /^[a-z0-9][a-z0-9-]{0,38}(?:\[bot\])?$/i.test(user.login);
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

  const reviews = api(`/pulls/${pulls[0].number}/reviews`, true);
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
  for (const review of reviews) latest.set(review.user.id, review);
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
        "maintain:maintain",
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
  try {
    git("cat-file", "-e", `${head}^{commit}`);
  } catch {
    git("fetch", "--no-tags", "origin", `refs/pull/${pulls[0].number}/head`);
    if (git("rev-parse", "FETCH_HEAD") !== head)
      throw new Error(
        "Fetched release PR head differs from its approval record.",
      );
  }
  provenance(source, head);
  current();
  console.log(
    `Release PR #${pulls[0].number} has ${trusted} trusted maintainer approval(s) and matching merge provenance.`,
  );
}

try {
  const [mode, argument] = process.argv.slice(2);
  if (mode === "current") current();
  else if (mode === "published") {
    current();
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
    if (surfaces.some((surface) => fs.existsSync(surface))) published(version);
  } else if (mode === "recovery") recovery(argument);
  else if (mode === "approval") approval();
  else if (mode === "provenance") {
    current();
    provenance(process.env.RELEASE_SHA, argument);
  } else
    throw new Error(
      "Expected current, published, pending, recovery, approval, or provenance.",
    );
} catch (error) {
  console.error(
    `::error::${error.message}\nPublication stopped. Recovery requires current tested main and original release authority; provenance mismatches remain quarantined pending a separately reviewed plan. See RELEASING.md. Do not rerun an obsolete workflow.`,
  );
  process.exitCode = 1;
}
