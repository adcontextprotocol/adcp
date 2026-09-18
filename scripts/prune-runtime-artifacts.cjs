#!/usr/bin/env node

const {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { join, resolve } = require("node:path");
const semver = require("semver");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function assertAdcpRepoRoot(repoRoot) {
  const packagePath = join(repoRoot, "package.json");
  if (!existsSync(packagePath) || readJson(packagePath)?.name !== "adcontextprotocol") {
    throw new Error(`Refusing to prune outside an adcontextprotocol checkout: ${repoRoot}`);
  }
}

function assertVersion(version, source) {
  if (typeof version !== "string" || semver.valid(version) === null) {
    throw new Error(`${source} contains invalid release version ${JSON.stringify(version)}`);
  }
  return version;
}

function docsSnapshotVersions(repoRoot) {
  const configPath = join(repoRoot, "docs.json");
  const versions = readJson(configPath)?.navigation?.versions;
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new Error(`${configPath} must declare navigation.versions`);
  }

  return new Set(versions.map((entry) => {
    const snapshots = new Set();
    const visit = (value) => {
      if (typeof value === "string") {
        const match = value.match(/^dist\/docs\/([^/]+)\//);
        if (match) snapshots.add(assertVersion(match[1], configPath));
      } else if (Array.isArray(value)) {
        value.forEach(visit);
      } else if (value && typeof value === "object") {
        Object.values(value).forEach(visit);
      }
    };
    visit(entry?.groups);
    if (snapshots.size !== 1) {
      throw new Error(
        `${configPath} version ${JSON.stringify(entry?.version)} must reference exactly one dist/docs snapshot`,
      );
    }
    return [...snapshots][0];
  }));
}

function retainedTrainingSchemaVersion(repoRoot) {
  const sourcePath = join(repoRoot, "server", "src", "training-agent", "types.ts");
  const source = readFileSync(sourcePath, "utf8");
  const matches = [...source.matchAll(
    /export const SELLER_GOVERNANCE_DISCOVERY_ADCP_VERSION\s*=\s*'([^']+)'\s+as const;/g,
  )];
  if (matches.length !== 1) {
    throw new Error(
      `${sourcePath} must contain exactly one literal SELLER_GOVERNANCE_DISCOVERY_ADCP_VERSION declaration`,
    );
  }
  const wireVersion = matches[0][1];
  const match = wireVersion.match(/^(\d+)\.(\d+)(?:\.(\d+))?((?:-(?:beta|rc)\.\d+)?)$/);
  if (!match) {
    throw new Error(`Unsupported retained training-agent schema version ${wireVersion}`);
  }
  return assertVersion(
    `${match[1]}.${match[2]}.${match[3] ?? "0"}${match[4]}`,
    sourcePath,
  );
}

function publishedComplianceVersions(repoRoot) {
  const manifestPath = join(
    repoRoot,
    "static",
    "compliance",
    "published-versions.json",
  );
  const manifest = readJson(manifestPath);
  if (
    manifest?.schema_version !== 1 ||
    !Array.isArray(manifest.published_versions) ||
    manifest.published_versions.length === 0
  ) {
    throw new Error(`${manifestPath} must declare schema_version 1 published_versions`);
  }
  const versions = manifest.published_versions.map((version) =>
    assertVersion(version, manifestPath));
  if (new Set(versions).size !== versions.length) {
    throw new Error(`${manifestPath} published_versions must be unique`);
  }
  return new Set(versions);
}

function schemaDiscoveryAliasTargets(repoRoot) {
  const indexPath = join(repoRoot, "dist", "schemas", "index.json");
  const index = readJson(indexPath);
  if (!index?.aliases || typeof index.aliases !== "object") {
    throw new Error(`${indexPath} must declare schema aliases`);
  }
  const targets = new Set(
    Object.values(index.aliases).map((version) => assertVersion(version, indexPath)),
  );
  for (const field of ["latest", "latest_stable"]) {
    targets.add(assertVersion(index[field], indexPath));
  }
  for (const value of Object.values(index.latest_by_major ?? {})) {
    targets.add(assertVersion(value, indexPath));
  }
  for (const value of Object.values(index.latest_by_minor ?? {})) {
    targets.add(assertVersion(value, indexPath));
  }
  return targets;
}

function runtimeArtifactManifest(repoRoot = resolve(__dirname, "..")) {
  const published = publishedComplianceVersions(repoRoot);
  const docs = docsSnapshotVersions(repoRoot);
  const schemaAliases = schemaDiscoveryAliasTargets(repoRoot);
  const trainingSchema = retainedTrainingSchemaVersion(repoRoot);

  return {
    published,
    docs,
    schemaAliases,
    trainingSchema,
    schemaVersions: new Set([
      ...published,
      ...docs,
      ...schemaAliases,
      trainingSchema,
    ]),
  };
}

function requireArtifact(rootPath, version, marker) {
  const artifactPath = join(rootPath, version, marker);
  if (!existsSync(artifactPath)) {
    throw new Error(`Required runtime artifact is missing: ${artifactPath}`);
  }
}

function verifyRequiredArtifacts(repoRoot, manifest = runtimeArtifactManifest(repoRoot)) {
  const schemaRoot = join(repoRoot, "dist", "schemas");
  const complianceRoot = join(repoRoot, "dist", "compliance");
  const docsRoot = join(repoRoot, "dist", "docs");
  for (const version of manifest.schemaVersions) {
    requireArtifact(schemaRoot, version, "index.json");
  }
  for (const version of manifest.published) {
    requireArtifact(complianceRoot, version, "index.json");
    // hostedComplianceOptions() requires the same-version schema bundle.
    requireArtifact(schemaRoot, version, "index.json");
  }
  for (const version of manifest.docs) {
    if (!existsSync(join(docsRoot, version))) {
      throw new Error(`Required runtime docs snapshot is missing: ${join(docsRoot, version)}`);
    }
  }
  requireArtifact(schemaRoot, "latest", "index.json");
  requireArtifact(complianceRoot, "latest", "index.json");
  for (const file of ["latest.tgz", "latest.tgz.sha256"]) {
    const protocolPath = join(repoRoot, "dist", "protocol", file);
    if (!existsSync(protocolPath)) {
      throw new Error(`Required runtime protocol artifact is missing: ${protocolPath}`);
    }
  }
  return manifest;
}

function pruneVersionDirectories(rootPath, keep) {
  const removed = [];
  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      semver.valid(entry.name) !== null &&
      !keep.has(entry.name)
    ) {
      rmSync(join(rootPath, entry.name), { recursive: true });
      removed.push(entry.name);
    }
  }
  return removed;
}

function rewriteSchemaDiscovery(repoRoot, keep) {
  const indexPath = join(repoRoot, "dist", "schemas", "index.json");
  const index = readJson(indexPath);
  if (!Array.isArray(index.versions)) {
    throw new Error(`${indexPath} must declare versions before runtime pruning`);
  }
  index.versions = index.versions.filter((entry) => keep.has(entry?.version));
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
}

function verifyPrunedTree(repoRoot, manifest) {
  verifyRequiredArtifacts(repoRoot, manifest);
  const actual = new Set(
    readdirSync(join(repoRoot, "dist", "schemas"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && semver.valid(entry.name) !== null)
      .map((entry) => entry.name),
  );
  const unexpected = [...actual].filter((version) => !manifest.schemaVersions.has(version));
  const missing = [...manifest.schemaVersions].filter((version) => !actual.has(version));
  if (unexpected.length || missing.length) {
    throw new Error(
      `Runtime schema closure mismatch; missing=${missing.join(",") || "none"} unexpected=${unexpected.join(",") || "none"}`,
    );
  }

  const schemaIndex = readJson(join(repoRoot, "dist", "schemas", "index.json"));
  const indexed = new Set(schemaIndex.versions.map((entry) => entry.version));
  const stale = [...indexed].filter((version) => !manifest.schemaVersions.has(version));
  const unindexed = [...manifest.schemaVersions].filter((version) => !indexed.has(version));
  if (stale.length || unindexed.length) {
    throw new Error(
      `Runtime schema discovery mismatch; stale=${stale.join(",") || "none"} unindexed=${unindexed.join(",") || "none"}`,
    );
  }
}

function pruneRuntimeArtifacts(repoRoot = resolve(__dirname, "..")) {
  assertAdcpRepoRoot(repoRoot);
  const manifest = verifyRequiredArtifacts(repoRoot);
  const schemasRemoved = pruneVersionDirectories(
    join(repoRoot, "dist", "schemas"),
    manifest.schemaVersions,
  );
  rewriteSchemaDiscovery(repoRoot, manifest.schemaVersions);
  verifyPrunedTree(repoRoot, manifest);
  return { manifest, schemasRemoved };
}

function run() {
  const repoRoot = resolve(process.argv[2] ?? join(__dirname, ".."));
  const result = pruneRuntimeArtifacts(repoRoot);
  console.log(
    `Runtime artifact closure retained ${result.manifest.schemaVersions.size} schema releases; ` +
      `pruned ${result.schemasRemoved.length}. Compliance, docs, and protocol artifacts were left intact.`,
  );
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
  docsSnapshotVersions,
  pruneRuntimeArtifacts,
  retainedTrainingSchemaVersion,
  runtimeArtifactManifest,
  verifyPrunedTree,
  verifyRequiredArtifacts,
};
