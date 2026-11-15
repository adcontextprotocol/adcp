#!/usr/bin/env node

const {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { join, resolve } = require("node:path");
const { createHash } = require("node:crypto");
const semver = require("semver");

const PROTOCOL_OFFLOAD_INDEX = ".runtime-offloaded-tarballs.json";
const PROTOCOL_VERIFY_CONCURRENCY = 6;

function readOffloadedTarballs(repoRoot) {
  const file = join(repoRoot, "dist", "protocol", PROTOCOL_OFFLOAD_INDEX);
  if (!existsSync(file)) return [];
  const index = readJson(file);
  if (index?.schema_version !== 1 || !Array.isArray(index.files)
    || index.files.some((name) => typeof name !== "string" || !name.endsWith(".tgz")
      || semver.valid(name.slice(0, -4)) !== name.slice(0, -4))
    || new Set(index.files).size !== index.files.length) {
    throw new Error(`Invalid runtime protocol offload inventory: ${file}`);
  }
  return index.files;
}

// Every versioned archive is a candidate. latest.tgz is rebuilt in the image
// and never offloaded. Archive bodies are only served for download, and the
// CDN serves them from R2, so a required release's archive need not stay on Fly
// once R2 holds the same bytes.
function protocolOffloadCandidates(repoRoot) {
  return readdirSync(join(repoRoot, "dist", "protocol"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tgz")
      && semver.valid(entry.name.slice(0, -4)) === entry.name.slice(0, -4))
    .map((entry) => entry.name).sort();
}

// Only the image-build CLI opts in. Verify the actual CDN bodies, not merely
// discovery/checksum metadata, before removing any local archive. The Worker
// emits R2's strong object ETag; its optional Fly fallback preserves Fly's weak
// static-file ETag and request ID. Reject that fallback even if bytes match.
async function verifyProtocolOffloads(repoRoot, fetchArtifact = fetch) {
  const candidates = protocolOffloadCandidates(repoRoot);
  if (!candidates.length) return candidates;
  const { schemaVersions } = runtimeArtifactManifest(repoRoot);
  // Worker protocol discovery lists R2 objects directly and has no Fly miss
  // fallback. A matching origin body alone cannot establish off-app storage.
  const discovery = await fetchArtifact("https://adcontextprotocol.org/protocol/", {
    redirect: "error", signal: AbortSignal.timeout(60_000),
  });
  if (!discovery.ok || discovery.headers.has("fly-request-id")) {
    throw new Error("R2 protocol discovery unavailable");
  }
  const index = await discovery.json();
  if (!Array.isArray(index?.versions)) throw new Error("Invalid R2 protocol discovery");
  const published = new Set(index.versions.map((entry) => entry?.tarball));
  // A release cut in this tree reaches R2 only after its tag is published, so
  // a required archive that R2 does not list yet stays local. Any other archive
  // must already be in R2.
  if (candidates.some((name) => !published.has(`/protocol/${name}`)
    && !schemaVersions.has(name.slice(0, -4)))) {
    throw new Error("Protocol offload candidate is absent from R2 discovery");
  }
  const files = candidates.filter((name) => published.has(`/protocol/${name}`));
  const verifyArchive = async (name) => {
    const bytes = readFileSync(join(repoRoot, "dist", "protocol", name));
    const expected = createHash("sha256").update(bytes).digest("hex");
    const response = await fetchArtifact(`https://adcontextprotocol.org/protocol/${name}`, {
      redirect: "error", signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok || !response.body) throw new Error(`CDN protocol archive unavailable: ${name}`);
    if (!/^"[a-f0-9]{32}(?:-[1-9][0-9]*)?"$/.test(response.headers.get("etag") ?? "")
      || response.headers.has("fly-request-id")) {
      throw new Error(`CDN protocol archive lacks R2 object evidence: ${name}`);
    }
    const hash = createHash("sha256");
    let length = 0;
    for await (const chunk of response.body) { hash.update(chunk); length += chunk.length; }
    if (length !== bytes.length || hash.digest("hex") !== expected) {
      throw new Error(`CDN protocol archive differs from committed bytes: ${name}`);
    }
  };
  // Every image build downloads each offloaded body, so verify a few at a time.
  for (let start = 0; start < files.length; start += PROTOCOL_VERIFY_CONCURRENCY) {
    await Promise.all(files.slice(start, start + PROTOCOL_VERIFY_CONCURRENCY).map(verifyArchive));
  }
  return files;
}

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

function retainedTrainingSchemaVersions(repoRoot) {
  // Build tooling has tsx available. Import the same metadata the training
  // agent uses instead of maintaining a second literal/version parser.
  const { require: requireTypeScript } = require("tsx/cjs/api");
  const sourcePath = join(repoRoot, "server", "src", "training-agent", "schema-compat.ts");
  const { RETAINED_SCHEMA_BUNDLES: retained } = requireTypeScript(sourcePath, __filename);
  if (!retained || typeof retained !== "object" || Array.isArray(retained)
    || Object.keys(retained).length === 0) {
    throw new Error(`${sourcePath} must export a nonempty RETAINED_SCHEMA_BUNDLES map`);
  }
  const versions = new Set();
  for (const [wireVersion, version] of Object.entries(retained)) {
    const wire = wireVersion.match(/^(\d+)\.(\d+)(?:\.(\d+))?((?:-(?:beta|rc)\.\d+)?)$/);
    if (!wire || `${wire[1]}.${wire[2]}.${wire[3] ?? "0"}${wire[4]}` !== version) {
      throw new Error(`${sourcePath} has an invalid retained schema mapping: ${wireVersion}`);
    }
    versions.add(assertVersion(version, sourcePath));
  }
  return versions;
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
  const trainingSchemas = retainedTrainingSchemaVersions(repoRoot);

  return {
    published,
    docs,
    schemaAliases,
    trainingSchemas,
    schemaVersions: new Set([
      ...published,
      ...docs,
      ...schemaAliases,
      ...trainingSchemas,
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

function pruneRuntimeArtifacts(repoRoot = resolve(__dirname, ".."), verifiedProtocolFiles = []) {
  assertAdcpRepoRoot(repoRoot);
  const manifest = verifyRequiredArtifacts(repoRoot);
  const offloaded = readOffloadedTarballs(repoRoot);
  const candidates = new Set(protocolOffloadCandidates(repoRoot));
  if (verifiedProtocolFiles.some((name) => !candidates.has(name))) {
    throw new Error("Refusing to offload an unknown protocol archive");
  }
  const protocolFiles = [...new Set([...offloaded, ...verifiedProtocolFiles])].sort();
  for (const name of protocolFiles) {
    if (!existsSync(join(repoRoot, "dist", "protocol", `${name}.sha256`))) {
      throw new Error(`Required protocol checksum is missing: ${name}.sha256`);
    }
  }
  const schemasRemoved = pruneVersionDirectories(
    join(repoRoot, "dist", "schemas"),
    manifest.schemaVersions,
  );
  rewriteSchemaDiscovery(repoRoot, manifest.schemaVersions);
  verifyPrunedTree(repoRoot, manifest);
  if (protocolFiles.length) {
    writeFileSync(join(repoRoot, "dist", "protocol", PROTOCOL_OFFLOAD_INDEX),
      `${JSON.stringify({ schema_version: 1, files: protocolFiles }, null, 2)}\n`);
    for (const name of verifiedProtocolFiles) rmSync(join(repoRoot, "dist", "protocol", name));
  }
  return { manifest, schemasRemoved, protocolFilesOffloaded: verifiedProtocolFiles };
}

async function run() {
  const args = process.argv.slice(2);
  const offload = args.includes("--offload-protocol");
  const repoRoot = resolve(args.find((arg) => arg !== "--offload-protocol") ?? join(__dirname, ".."));
  assertAdcpRepoRoot(repoRoot);
  verifyRequiredArtifacts(repoRoot);
  const verified = offload ? await verifyProtocolOffloads(repoRoot) : [];
  const result = pruneRuntimeArtifacts(repoRoot, verified);
  console.log(
    `Runtime artifact closure retained ${result.manifest.schemaVersions.size} schema releases; ` +
      `pruned ${result.schemasRemoved.length}; offloaded ${verified.length} CDN-verified protocol archives. ` +
      "Compliance, docs, latest.tgz, archives not yet in R2 and all sidecars were left intact.",
  );
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

module.exports = {
  docsSnapshotVersions,
  pruneRuntimeArtifacts,
  retainedTrainingSchemaVersions,
  runtimeArtifactManifest,
  verifyPrunedTree,
  verifyRequiredArtifacts,
  protocolOffloadCandidates,
  verifyProtocolOffloads,
};
