#!/usr/bin/env node
// Release/deploy fences. Remote failures are errors, never evidence of absence.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

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
    run("gh", ["release", "view", tag, "--json", "tagName,isDraft,assets"]),
  );
  const names = release.assets.map((asset) => asset.name);
  if (
    release.tagName !== tag ||
    release.isDraft ||
    !["", ".sha256", ".sig", ".crt"].every((suffix) =>
      names.includes(`${version}.tgz${suffix}`),
    )
  ) {
    throw new Error(
      `Release ${tag} is not published with the complete signed tuple.`,
    );
  }
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

try {
  const [mode, argument] = process.argv.slice(2);
  if (mode === "current") current();
  else if (mode === "published") {
    current();
    published(argument, process.env.RELEASE_SHA);
  } else if (mode === "pending") {
    current();
    const version = JSON.parse(fs.readFileSync("package.json")).version;
    if (fs.existsSync(`dist/protocol/${version}.tgz`)) published(version);
  } else if (mode === "recovery") recovery(argument);
  else throw new Error("Expected current, published, pending, or recovery.");
} catch (error) {
  console.error(
    `::error::${error.message}\nPublication stopped. A missing/incomplete release must be recovered explicitly from its original approved merge on current tested main; see RELEASING.md. Do not rerun an obsolete workflow.`,
  );
  process.exitCode = 1;
}
