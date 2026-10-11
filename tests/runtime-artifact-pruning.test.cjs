const assert = require("node:assert/strict");
const {
  existsSync,
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
  pruneRuntimeArtifacts,
  retainedTrainingSchemaVersions,
  runtimeArtifactManifest,
  verifyRequiredArtifacts,
} = require("../scripts/prune-runtime-artifacts.cjs");

const repoRoot = resolve(__dirname, "..");

function writeJson(path, value) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeArtifact(root, kind, version, marker = "index.json") {
  const dir = join(root, "dist", kind, version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, marker), `${kind}:${version}\n`);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "adcp-runtime-artifacts-"));
  writeJson(join(root, "package.json"), { name: "adcontextprotocol" });
  writeJson(join(root, "static", "compliance", "published-versions.json"), {
    schema_version: 1,
    published_versions: ["3.1.1"],
  });
  writeJson(join(root, "docs.json"), {
    navigation: {
      versions: [{ version: "3.1", default: true, groups: ["dist/docs/3.1.2/intro"] }],
    },
  });
  mkdirSync(join(root, "server", "src", "training-agent"), { recursive: true });
  writeFileSync(
    join(root, "server", "src", "training-agent", "schema-compat.ts"),
    "export const RETAINED_SCHEMA_BUNDLES = Object.freeze({ '3.1-beta.1': '3.1.0-beta.1' });\n",
  );

  for (const version of ["3.1.0-beta.1", "3.1.0-beta.2", "3.1.1", "3.1.2"]) {
    writeArtifact(root, "schemas", version);
  }
  for (const version of ["3.1.0-beta.2", "3.1.1", "3.1.2"]) {
    writeArtifact(root, "compliance", version);
  }
  writeArtifact(root, "schemas", "latest");
  writeArtifact(root, "compliance", "latest");
  mkdirSync(join(root, "dist", "docs", "3.1.2"), { recursive: true });
  writeFileSync(join(root, "dist", "docs", "3.1.2", "intro.mdx"), "docs sentinel\n");
  mkdirSync(join(root, "dist", "protocol"), { recursive: true });
  writeFileSync(join(root, "dist", "protocol", "latest.tgz"), "latest protocol\n");
  writeFileSync(join(root, "dist", "protocol", "latest.tgz.sha256"), "checksum\n");
  writeFileSync(join(root, "dist", "protocol", "3.0.0.tgz"), "release sentinel\n");
  writeJson(join(root, "dist", "schemas", "index.json"), {
    latest: "3.1.2",
    latest_stable: "3.1.2",
    aliases: { v3: "3.1.2", "v3.1": "3.1.2" },
    latest_by_major: { 3: "3.1.2" },
    latest_by_minor: { "3.1": "3.1.2" },
    versions: [
      { version: "3.1.2" },
      { version: "3.1.1" },
      { version: "3.1.0-beta.2" },
      { version: "3.1.0-beta.1" },
    ],
  });
  return root;
}

test("runtime closure includes every published hosted compliance bundle and paired schema", () => {
  const manifest = runtimeArtifactManifest(repoRoot);
  const published = JSON.parse(
    readFileSync(join(repoRoot, "static", "compliance", "published-versions.json")),
  ).published_versions;

  for (const version of published) {
    assert.ok(manifest.published.has(version), `missing compliance ${version}`);
    assert.ok(manifest.schemaVersions.has(version), `missing schema ${version}`);
    assert.ok(existsSync(join(repoRoot, "dist", "compliance", version, "index.json")));
    assert.ok(existsSync(join(repoRoot, "dist", "schemas", version, "index.json")));
  }
  for (const version of manifest.schemaVersions) {
    assert.ok(
      existsSync(join(repoRoot, "dist", "schemas", version, "index.json")),
      `missing required runtime schema ${version}`,
    );
  }
  for (const version of manifest.docs) {
    assert.ok(
      existsSync(join(repoRoot, "dist", "docs", version)),
      `missing required runtime docs ${version}`,
    );
  }
  for (const version of manifest.trainingSchemas) assert.ok(manifest.schemaVersions.has(version));
});

test("runtime pruning removes only unrequired build-stage versions", () => {
  const root = fixture();
  try {
    const docsBefore = readFileSync(join(root, "dist", "docs", "3.1.2", "intro.mdx"));
    const protocolBefore = readFileSync(join(root, "dist", "protocol", "3.0.0.tgz"));
    const complianceBefore = readFileSync(
      join(root, "dist", "compliance", "3.1.0-beta.2", "index.json"),
    );
    const result = pruneRuntimeArtifacts(root);

    assert.deepEqual(result.schemasRemoved, ["3.1.0-beta.2"]);
    assert.ok(existsSync(join(root, "dist", "schemas", "3.1.0-beta.1", "index.json")));
    assert.ok(existsSync(join(root, "dist", "schemas", "3.1.1", "index.json")));
    assert.ok(existsSync(join(root, "dist", "schemas", "3.1.2", "index.json")));
    assert.ok(existsSync(join(root, "dist", "compliance", "3.1.1", "index.json")));
    assert.ok(existsSync(join(root, "dist", "compliance", "3.1.2", "index.json")));
    assert.ok(existsSync(join(root, "dist", "compliance", "3.1.0-beta.2", "index.json")));
    assert.deepEqual(
      readFileSync(join(root, "dist", "compliance", "3.1.0-beta.2", "index.json")),
      complianceBefore,
    );
    assert.deepEqual(
      readFileSync(join(root, "dist", "docs", "3.1.2", "intro.mdx")),
      docsBefore,
    );
    assert.deepEqual(readFileSync(join(root, "dist", "protocol", "3.0.0.tgz")), protocolBefore);
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, "dist", "schemas", "index.json"))).versions
        .map((entry) => entry.version),
      ["3.1.2", "3.1.1", "3.1.0-beta.1"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime closure fails closed when a published hosted schema is absent", () => {
  const root = fixture();
  try {
    rmSync(join(root, "dist", "schemas", "3.1.1"), { recursive: true });
    assert.throws(
      () => verifyRequiredArtifacts(root),
      /Required runtime artifact is missing: .*dist\/schemas\/3\.1\.1\/index\.json/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("training schema discovery fails closed if its shared metadata contract changes", () => {
  const root = fixture();
  try {
    writeFileSync(
      join(root, "server", "src", "training-agent", "schema-compat.ts"),
      "export const RETAINED_SCHEMA_BUNDLES = {};\n",
    );
    assert.throws(
      () => retainedTrainingSchemaVersions(root),
      /must export a nonempty RETAINED_SCHEMA_BUNDLES map/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("retention follows every training checkpoint even without publication or alias anchors", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "server", "src", "training-agent", "schema-compat.ts"),
      "export const RETAINED_SCHEMA_BUNDLES = Object.freeze({ '3.2-beta.6': '3.2.0-beta.6', '3.2-rc.7': '3.2.0-rc.7' });\n");
    for (const version of ["3.2.0-beta.6", "3.2.0-rc.7"]) writeArtifact(root, "schemas", version);
    const indexPath = join(root, "dist", "schemas", "index.json");
    const index = JSON.parse(readFileSync(indexPath));
    index.versions.push({ version: "3.2.0-beta.6" }, { version: "3.2.0-rc.7" }); writeJson(indexPath,index);
    const result = pruneRuntimeArtifacts(root);
    assert.deepEqual([...result.manifest.trainingSchemas].sort(), ["3.2.0-beta.6", "3.2.0-rc.7"]);
    for (const version of result.manifest.trainingSchemas) assert.ok(existsSync(join(root, "dist", "schemas", version, "index.json")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("package-only releases are pruned unless another runtime anchor needs them", () => {
  const root = fixture();
  try {
    const manifestPath = join(root, "static", "compliance", "published-versions.json");
    writeJson(manifestPath, { schema_version: 1, published_versions: ["3.1.1"], package_only_versions: ["3.1.0-beta.2", "3.1.2"] });
    assert.deepEqual(pruneRuntimeArtifacts(root).schemasRemoved, ["3.1.0-beta.2"]);
    assert.ok(existsSync(join(root, "dist", "schemas", "3.1.2", "index.json")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("a missing training checkpoint fails before any disposable schemas are pruned", () => {
  const root = fixture();
  try {
    rmSync(join(root, "dist", "schemas", "3.1.0-beta.1"), { recursive: true });
    assert.throws(() => pruneRuntimeArtifacts(root), /Required runtime artifact is missing/);
    assert.ok(existsSync(join(root, "dist", "schemas", "3.1.0-beta.2", "index.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("noncanonical training checkpoint mappings fail closed", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "server", "src", "training-agent", "schema-compat.ts"),
      "export const RETAINED_SCHEMA_BUNDLES = { '3.2-beta.6': '3.2.0-rc.7' };\n");
    assert.throws(() => retainedTrainingSchemaVersions(root), /invalid retained schema mapping/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
