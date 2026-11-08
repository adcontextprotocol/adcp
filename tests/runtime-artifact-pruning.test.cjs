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
  protocolOffloadCandidates,
  verifyProtocolOffloads,
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
  for (const version of ["3.0.0", "3.1.1"]) {
    writeFileSync(join(root, "dist", "protocol", `${version}.tgz`), `${version} archive\n`);
    for (const suffix of ["sha256", "sig", "crt"]) {
      writeFileSync(join(root, "dist", "protocol", `${version}.tgz.${suffix}`), `${version} ${suffix}\n`);
    }
  }
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

function cdnServing(root, listed) {
  return async (url, options) => {
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    if (url === "https://adcontextprotocol.org/protocol/") {
      return Response.json({ versions: listed.map((name) => ({ tarball: `/protocol/${name}` })) });
    }
    const name = url.replace("https://adcontextprotocol.org/protocol/", "");
    assert.ok(listed.includes(name), `fetched unlisted archive ${name}`);
    return new Response(readFileSync(join(root, "dist", "protocol", name)), {
      headers: { etag: '"0123456789abcdef0123456789abcdef-2"' },
    });
  };
}

test("image-only protocol offload covers required archives and preserves discovery inventory, latest and every sidecar", async () => {
  const root = fixture();
  try {
    const sidecars = ["3.0.0", "3.1.1"].flatMap((version) => ["sha256", "sig", "crt"].map((suffix) =>
      [`${version}.tgz.${suffix}`, readFileSync(join(root, "dist", "protocol", `${version}.tgz.${suffix}`))]));
    // 3.1.1 is a published hosted release; its archive body is still only a download.
    assert.deepEqual(protocolOffloadCandidates(root), ["3.0.0.tgz", "3.1.1.tgz"]);
    const verified = await verifyProtocolOffloads(root, cdnServing(root, ["3.0.0.tgz", "3.1.1.tgz"]));
    assert.deepEqual(verified, ["3.0.0.tgz", "3.1.1.tgz"]);
    const result = pruneRuntimeArtifacts(root, verified);
    assert.deepEqual(result.protocolFilesOffloaded, ["3.0.0.tgz", "3.1.1.tgz"]);
    assert.equal(existsSync(join(root, "dist", "protocol", "3.0.0.tgz")), false);
    assert.equal(existsSync(join(root, "dist", "protocol", "3.1.1.tgz")), false);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "dist", "protocol", ".runtime-offloaded-tarballs.json"))),
      { schema_version: 1, files: ["3.0.0.tgz", "3.1.1.tgz"] });
    assert.equal(readFileSync(join(root, "dist", "protocol", "latest.tgz"), "utf8"), "latest protocol\n");
    for (const [name, before] of sidecars) {
      assert.deepEqual(readFileSync(join(root, "dist", "protocol", name)), before);
    }
    pruneRuntimeArtifacts(root); // Repeated image preparation preserves the offloaded entries.
    assert.deepEqual(JSON.parse(readFileSync(join(root, "dist", "protocol", ".runtime-offloaded-tarballs.json"))).files,
      ["3.0.0.tgz", "3.1.1.tgz"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a required archive R2 does not list yet stays local while listed archives offload", async () => {
  const root = fixture();
  try {
    // A Version Packages build carries the new release's archive before its tag reaches R2.
    const verified = await verifyProtocolOffloads(root, cdnServing(root, ["3.0.0.tgz"]));
    assert.deepEqual(verified, ["3.0.0.tgz"]);
    pruneRuntimeArtifacts(root, verified);
    assert.equal(existsSync(join(root, "dist", "protocol", "3.0.0.tgz")), false);
    assert.equal(readFileSync(join(root, "dist", "protocol", "3.1.1.tgz"), "utf8"), "3.1.1 archive\n");
    assert.deepEqual(JSON.parse(readFileSync(join(root, "dist", "protocol", ".runtime-offloaded-tarballs.json"))),
      { schema_version: 1, files: ["3.0.0.tgz"] });

    // A listed required archive must still match byte for byte.
    const differentRequired = fixture();
    try {
      await assert.rejects(() => verifyProtocolOffloads(differentRequired, (url, options) =>
        url === "https://adcontextprotocol.org/protocol/3.1.1.tgz"
          ? Promise.resolve(new Response("different bytes", { headers: { etag: '"0123456789abcdef0123456789abcdef"' } }))
          : cdnServing(differentRequired, ["3.0.0.tgz", "3.1.1.tgz"])(url, options)),
      /differs from committed bytes/);
    } finally { rmSync(differentRequired, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CDN archive verification rejects unavailable, different and interrupted bodies before pruning", async () => {
  const root = fixture();
  try {
    for (const fetchArtifact of [
      async () => new Response("missing", { status: 404 }),
      async () => new Response("different bytes", { headers: { etag: '"0123456789abcdef0123456789abcdef"' } }),
      async () => new Response(readFileSync(join(root, "dist", "protocol", "3.0.0.tgz")),
        { headers: { etag: 'W/"old-fly-stat"', "fly-request-id": "origin-fallback" } }),
      async () => new Response(readFileSync(join(root, "dist", "protocol", "3.0.0.tgz")),
        { headers: { etag: '"0123456789abcdef0123456789abcdef"', "fly-request-id": "origin-fallback" } }),
      async () => { throw new Error("network interrupted"); },
    ]) {
      await assert.rejects(() => verifyProtocolOffloads(root, (url, options) =>
        url === "https://adcontextprotocol.org/protocol/"
          ? Promise.resolve(Response.json({ versions: [{ tarball: "/protocol/3.0.0.tgz" }] }))
          : fetchArtifact(url, options)));
      assert.ok(existsSync(join(root, "dist", "protocol", "3.0.0.tgz")));
      assert.ok(existsSync(join(root, "dist", "schemas", "3.1.0-beta.2")));
      assert.equal(existsSync(join(root, "dist", "protocol", ".runtime-offloaded-tarballs.json")), false);
    }
    assert.throws(() => pruneRuntimeArtifacts(root, ["3.9.9.tgz"]), /unknown protocol archive/);
    assert.throws(() => pruneRuntimeArtifacts(root, ["latest.tgz"]), /unknown protocol archive/);
    assert.ok(existsSync(join(root, "dist", "schemas", "3.1.0-beta.2")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("R2 discovery must list every archive outside the required closure and cannot be a Fly fallback", async () => {
  const root = fixture();
  try {
    await assert.rejects(() => verifyProtocolOffloads(root, async () => Response.json({ versions: [] })),
      /absent from R2 discovery/);
    await assert.rejects(() => verifyProtocolOffloads(root, async () => Response.json({
      versions: [{ tarball: "/protocol/3.0.0.tgz" }],
    }, { headers: { "fly-request-id": "origin" } })), /R2 protocol discovery unavailable/);
    assert.ok(existsSync(join(root, "dist", "protocol", "3.0.0.tgz")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("malformed offload inventory and missing sidecars fail before any pruning", () => {
  const root = fixture();
  try {
    writeJson(join(root, "dist", "protocol", ".runtime-offloaded-tarballs.json"),
      { schema_version: 1, files: ["../3.0.0.tgz"] });
    assert.throws(() => pruneRuntimeArtifacts(root), /Invalid runtime protocol offload inventory/);
    rmSync(join(root, "dist", "protocol", ".runtime-offloaded-tarballs.json"));
    rmSync(join(root, "dist", "protocol", "3.0.0.tgz.sha256"));
    assert.throws(() => pruneRuntimeArtifacts(root, ["3.0.0.tgz"]), /Required protocol checksum is missing/);
    assert.ok(existsSync(join(root, "dist", "schemas", "3.1.0-beta.2")));
    assert.ok(existsSync(join(root, "dist", "protocol", "3.0.0.tgz")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
