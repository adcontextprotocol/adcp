#!/usr/bin/env node

const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const semver = require("semver");
const {
  COMPLIANCE_VERSION_RE,
  validateManifest,
} = require("./check-published-compliance-versions.cjs");

function registerPublishedVersion(manifest, version) {
  validateManifest(manifest);

  if (typeof version !== "string" || !COMPLIANCE_VERSION_RE.test(version)) {
    throw new Error(`Cannot register invalid compliance version: ${version}`);
  }

  const nextManifest = {
    ...manifest,
    package_only_versions: (manifest.package_only_versions ?? []).filter(
      (candidate) => candidate !== version,
    ),
    published_versions: [
      ...new Set([...manifest.published_versions, version]),
    ].sort(semver.compare),
  };

  return validateManifest(nextManifest);
}

function registerPublishedComplianceVersion(
  repoRoot = resolve(__dirname, ".."),
) {
  const packagePath = join(repoRoot, "package.json");
  const manifestPath = join(
    repoRoot,
    "static",
    "compliance",
    "published-versions.json",
  );
  const { version } = JSON.parse(readFileSync(packagePath, "utf8"));
  const bundleIndexPath = join(
    repoRoot,
    "dist",
    "compliance",
    version,
    "index.json",
  );

  if (!existsSync(bundleIndexPath)) {
    throw new Error(
      `Refusing to register compliance version ${version}: ${bundleIndexPath} does not exist`,
    );
  }

  const manifest = validateManifest(
    JSON.parse(readFileSync(manifestPath, "utf8")),
  );
  const wasPublished = manifest.published_versions.includes(version);
  const wasPackageOnly = (manifest.package_only_versions ?? []).includes(
    version,
  );
  const nextManifest = registerPublishedVersion(manifest, version);

  writeFileSync(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);

  return { version, wasPackageOnly, wasPublished };
}

function run() {
  const result = registerPublishedComplianceVersion();
  if (result.wasPublished) {
    console.log(`Compliance version ${result.version} is already registered.`);
  } else if (result.wasPackageOnly) {
    console.log(
      `Promoted compliance version ${result.version} from package-only to published.`,
    );
  } else {
    console.log(`Registered published compliance version ${result.version}.`);
  }
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

module.exports = {
  registerPublishedComplianceVersion,
  registerPublishedVersion,
};
