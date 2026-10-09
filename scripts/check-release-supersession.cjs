#!/usr/bin/env node

const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const markerPath = path.join(root, ".changeset", "release-supersession.json");
const shaPattern = /^[a-f0-9]{40}$/;
const rcPattern = /^\d+\.\d+\.\d+-rc\.\d+$/;

const run = (command, args) =>
  execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

function digest(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(root, file)))
    .digest("hex");
}

function releaseDoesNotExist(tag) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || "")) {
    throw new Error("Supersession verification requires GITHUB_REPOSITORY.");
  }
  const result = spawnSync(
    "gh",
    ["api", "-X", "GET", `repos/${repository}/releases/tags/${tag}`],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status === 0) {
    throw new Error(`Release ${tag} already exists and cannot be superseded.`);
  }
  if (result.status !== 1 || !result.stderr.includes("HTTP 404")) {
    throw new Error(
      `Could not prove that release ${tag} is absent: ${result.stderr.trim() || `gh exited ${result.status}`}`,
    );
  }
}

function verify() {
  if (!fs.existsSync(markerPath)) {
    throw new Error("Missing reviewed .changeset/release-supersession.json marker.");
  }
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  const expectedKeys = [
    "changesets",
    "protocol_sha256",
    "reason",
    "release_commit",
    "version",
  ];
  if (
    !marker ||
    typeof marker !== "object" ||
    Array.isArray(marker) ||
    JSON.stringify(Object.keys(marker).sort()) !== JSON.stringify(expectedKeys)
  ) {
    throw new Error("Release supersession marker has an unexpected shape.");
  }
  if (!rcPattern.test(marker.version || "")) {
    throw new Error("Only an unpublished release candidate may be superseded.");
  }
  if (!shaPattern.test(marker.release_commit || "")) {
    throw new Error("Supersession marker requires the exact release merge SHA.");
  }
  if (typeof marker.reason !== "string" || marker.reason.trim().length < 40) {
    throw new Error("Supersession marker requires a concrete reviewed reason.");
  }
  if (!/^[a-f0-9]{64}$/.test(marker.protocol_sha256 || "")) {
    throw new Error("Supersession marker requires the protocol tarball SHA-256.");
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const pre = JSON.parse(
    fs.readFileSync(path.join(root, ".changeset", "pre.json"), "utf8"),
  );
  if (pkg.version !== marker.version || pre.mode !== "pre" || pre.tag !== "rc") {
    throw new Error("Supersession requires the named RC in active rc pre mode.");
  }
  run("git", ["merge-base", "--is-ancestor", marker.release_commit, "HEAD"]);
  const committedVersion = JSON.parse(
    run("git", ["show", `${marker.release_commit}:package.json`]),
  ).version;
  if (committedVersion !== marker.version) {
    throw new Error("Named release merge does not commit the marker version.");
  }

  const surfaces = [
    `dist/schemas/${marker.version}`,
    `dist/compliance/${marker.version}`,
    ...["", ".sha256", ".sig", ".crt"].map(
      (suffix) => `dist/protocol/${marker.version}.tgz${suffix}`,
    ),
  ];
  for (const surface of surfaces) {
    run("git", ["cat-file", "-e", `${marker.release_commit}:${surface}`]);
    if (!fs.existsSync(path.join(root, surface))) {
      throw new Error(`Committed superseded surface is missing: ${surface}`);
    }
  }
  if (run("git", ["diff", "--name-only", marker.release_commit, "HEAD", "--", ...surfaces])) {
    throw new Error("Superseded release artifacts changed after their release merge.");
  }
  if (digest(`dist/protocol/${marker.version}.tgz`) !== marker.protocol_sha256) {
    throw new Error("Superseded protocol tarball does not match the reviewed digest.");
  }

  if (!Array.isArray(marker.changesets) || marker.changesets.length === 0) {
    throw new Error("Supersession must advance through at least one pending changeset.");
  }
  const pending = fs
    .readdirSync(path.join(root, ".changeset"))
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort()
    .map((file) => ({ file, sha256: digest(`.changeset/${file}`) }));
  const reviewed = [...marker.changesets].sort((a, b) =>
    `${a?.file}`.localeCompare(`${b?.file}`),
  );
  if (JSON.stringify(pending) !== JSON.stringify(reviewed)) {
    throw new Error("Pending changesets differ from the reviewed supersession set.");
  }

  const tag = `v${marker.version}`;
  const remoteTag = run("git", [
    "ls-remote",
    "origin",
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  ]);
  if (remoteTag) throw new Error(`Tag ${tag} already exists and cannot be superseded.`);
  releaseDoesNotExist(tag);
  console.log(
    `Verified reviewed supersession of unpublished ${marker.version}; next Version Packages cut may proceed.`,
  );
}

try {
  if (process.argv[2] !== "verify") {
    throw new Error("Expected: check-release-supersession.cjs verify");
  }
  verify();
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exitCode = 1;
}

