const assert = require("node:assert/strict");
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const test = require("node:test");
const {
  COMMAND_MAX_BUFFER_BYTES,
  missingPublishedVersions,
  packagedComplianceVersions,
  validateManifest,
} = require("../scripts/check-published-compliance-versions.cjs");
const {
  registerPublishedComplianceVersion,
  registerPublishedVersion,
} = require("../scripts/register-published-compliance-version.cjs");

function publicationManifest(overrides = {}) {
  return {
    schema_version: 1,
    npm_tags: ["latest", "beta"],
    package_only_versions: ["3.2.0"],
    published_versions: ["3.1.18", "3.2.0-beta.9"],
    ...overrides,
  };
}

test("allows large SDK package and tar listings", () => {
  assert.ok(COMMAND_MAX_BUFFER_BYTES >= 64 * 1024 * 1024);
});

test("extracts compliance cache versions from an SDK package listing", () => {
  const versions = packagedComplianceVersions(
    [
      "package/compliance/cache/3.1.11/index.json",
      "package/compliance/cache/3.1.11.previous/index.json",
      "package/compliance/cache/3.1.0-beta.7/index.json",
      "package/compliance/cache/latest/index.json",
    ].join("\n"),
  );

  assert.deepEqual([...versions], ["3.1.11", "3.1.0-beta.7"]);
});

test("reports a newly published cache missing from the manifest", () => {
  assert.deepEqual(
    missingPublishedVersions(["3.1.11"], new Set(["3.1.11", "3.1.12"])),
    ["3.1.12"],
  );
});

test("accepts an explicitly package-only SDK bundle", () => {
  assert.deepEqual(
    missingPublishedVersions(["3.1.13"], new Set(["3.1.13", "3.2.0"]), [
      "3.2.0",
    ]),
    [],
  );
});

test("rejects duplicate or malformed publication metadata", () => {
  assert.throws(
    () =>
      validateManifest({
        schema_version: 1,
        npm_tags: ["rc", "rc"],
        published_versions: ["3.1.11"],
      }),
    /npm_tags entries must be unique/,
  );

  assert.throws(
    () =>
      validateManifest({
        schema_version: 1,
        npm_tags: ["rc"],
        published_versions: ["latest"],
      }),
    /Invalid compliance versions/,
  );

  assert.throws(
    () =>
      validateManifest({
        schema_version: 1,
        npm_tags: ["rc"],
        published_versions: ["3.1.13"],
        package_only_versions: ["3.1.13"],
      }),
    /both published and package-only/,
  );
});

test("registers release versions in semantic order and idempotently", () => {
  const registered = registerPublishedVersion(
    publicationManifest(),
    "3.2.0-beta.10",
  );

  assert.deepEqual(registered.published_versions, [
    "3.1.18",
    "3.2.0-beta.9",
    "3.2.0-beta.10",
  ]);
  assert.deepEqual(
    registerPublishedVersion(registered, "3.2.0-beta.10"),
    registered,
  );
});

test("promotes a package-only compliance bundle when it is released", () => {
  const registered = registerPublishedVersion(publicationManifest(), "3.2.0");

  assert.deepEqual(registered.package_only_versions, []);
  assert.deepEqual(registered.published_versions, [
    "3.1.18",
    "3.2.0-beta.9",
    "3.2.0",
  ]);
});

test("requires the built bundle before updating the publication manifest", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "adcp-register-compliance-"));
  const manifestPath = join(
    repoRoot,
    "static",
    "compliance",
    "published-versions.json",
  );
  const originalManifest = publicationManifest();

  try {
    mkdirSync(join(repoRoot, "static", "compliance"), { recursive: true });
    writeFileSync(
      join(repoRoot, "package.json"),
      JSON.stringify({ version: "3.2.0-beta.10" }),
    );
    writeFileSync(manifestPath, JSON.stringify(originalManifest));

    assert.throws(
      () => registerPublishedComplianceVersion(repoRoot),
      /does not exist/,
    );
    assert.deepEqual(JSON.parse(readFileSync(manifestPath)), originalManifest);

    mkdirSync(join(repoRoot, "dist", "compliance", "3.2.0-beta.10"), {
      recursive: true,
    });
    writeFileSync(
      join(repoRoot, "dist", "compliance", "3.2.0-beta.10", "index.json"),
      "{}",
    );

    registerPublishedComplianceVersion(repoRoot);
    assert.deepEqual(
      JSON.parse(readFileSync(manifestPath)).published_versions,
      ["3.1.18", "3.2.0-beta.9", "3.2.0-beta.10"],
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("release versioning registers compliance after building it", () => {
  const scripts = require(
    join(resolve(__dirname, ".."), "package.json"),
  ).scripts;
  const buildIndex = scripts.version.indexOf(
    "npm run build:compliance -- --release",
  );
  const registerIndex = scripts.version.indexOf(
    "node scripts/register-published-compliance-version.cjs",
  );
  const tarballIndex = scripts.version.indexOf(
    "npm run build:protocol-tarball -- --release",
  );

  assert.ok(
    buildIndex !== -1 &&
      buildIndex < registerIndex &&
      registerIndex < tarballIndex,
    "Release versioning must register a built compliance bundle before packaging artifacts.",
  );
  assert.match(
    scripts["test:release-workflow"],
    /node tests\/published-compliance-versions[.]test[.]cjs/,
  );
});
