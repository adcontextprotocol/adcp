// Recovery of a released version's immutable schema and compliance trees on
// the artifact CDN (#8347). The gap these cover: a missing version directory
// does not 404, the worker silently serves a neighbouring release, so a
// recovery that publishes the wrong bytes, overwrites an object, or merely
// uploads without checking what the CDN then serves is indistinguishable from
// the bug it is meant to fix.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const YAML = require("yaml");

const root = path.resolve(__dirname, "..");
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const workflowPath = path.join(
  root,
  ".github/workflows/recover-protocol-cdn.yml",
);
const workflow = YAML.parse(fs.readFileSync(workflowPath, "utf8"));
const recoverySteps = workflow.jobs.recover.steps;
const stepNamed = (name) => recoverySteps.find((s) => s.name === name);

const VERSION = "3.0.27";
const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "public, no-cache, must-revalidate";

// One representative file per published content type, plus a nested path.
const RELEASED_TREE = {
  "schemas/index.json": '{\n  "adcp_version": "3.0.27"\n}\n',
  "schemas/manifest.json":
    '{\n  "published_version": "3.0.27",\n  "file_count": 3,\n  "generated_at": "2026-09-30T14:37:10.432Z"\n}\n',
  "schemas/core/product.json": '{\n  "title": "Product"\n}\n',
  "compliance/index.json":
    '{\n  "adcp_version": "3.0.27",\n  "generated_at": "2026-09-30T14:37:12.795Z"\n}\n',
  "compliance/universal/pagination.yaml": "id: pagination\n",
  "compliance/README.md": "# Compliance\n",
  "compliance/test-kits/rows.jsonl": '{"row":1}\n',
  "compliance/notes.txt": "notes\n",
};

function fixture(t, options = {}) {
  const {
    version = VERSION,
    tree = RELEASED_TREE,
    // Divergence injected into the staged bundle only, so the committed trees
    // stop matching the signed tarball.
    bundleOverrides = {},
    packageVersion = version,
  } = options;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recover-cdn-trees-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (file, value) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), value);
  };
  const git = (...args) =>
    execFileSync(realGit, args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  write("package.json", JSON.stringify({ version: packageVersion }));
  for (const [relative, body] of Object.entries(tree)) {
    const [surface, ...rest] = relative.split("/");
    write(`dist/${surface}/${version}/${rest.join("/")}`, body);
  }

  // Stage and build the signed tarball exactly the way build-protocol-tarball
  // does: the bundle's schemas/ and compliance/ are copies of the released
  // trees, with only the build timestamps re-pinned.
  const bundleRoot = `adcp-${version}`;
  for (const [relative, body] of Object.entries(tree)) {
    write(`stage/${bundleRoot}/${relative}`, body);
  }
  // Mirror build-protocol-tarball.cjs: the staged copies carry a later build
  // timestamp than the committed trees.
  for (const [relative, from] of [
    ["schemas/manifest.json", "2026-09-30T14:37:10.432Z"],
    ["compliance/index.json", "2026-09-30T14:37:12.795Z"],
  ])
    if (tree[relative])
      write(
        `stage/${bundleRoot}/${relative}`,
        tree[relative].replace(from, "2026-09-30T14:37:20.000Z"),
      );
  write(`stage/${bundleRoot}/README.md`, "# AdCP Protocol Bundle\n");
  for (const [relative, body] of Object.entries(bundleOverrides)) {
    if (body === null) fs.rmSync(path.join(dir, "stage", bundleRoot, relative));
    else write(`stage/${bundleRoot}/${relative}`, body);
  }

  fs.mkdirSync(path.join(dir, "dist/protocol"), { recursive: true });
  const tarball = path.join(dir, `dist/protocol/${version}.tgz`);
  execFileSync("tar", ["-czf", tarball, "-C", path.join(dir, "stage"), bundleRoot]);
  const digest = crypto
    .createHash("sha256")
    .update(fs.readFileSync(tarball))
    .digest("hex");
  write(`dist/protocol/${version}.tgz.sha256`, `${digest}  ${version}.tgz\n`);
  write(`dist/protocol/${version}.tgz.sig`, "signature\n");
  write(`dist/protocol/${version}.tgz.crt`, "certificate\n");
  fs.rmSync(path.join(dir, "stage"), { recursive: true, force: true });

  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("add", ".");
  git("commit", "-qm", "Release");
  const head = git("rev-parse", "HEAD");
  write("remote", head);
  write("calls", "");
  fs.mkdirSync(path.join(dir, "bucket"), { recursive: true });

  // Recovery runs the preserved copies from the current branch, never the
  // tag's. Mirror that: the scripts live outside the checkout.
  for (const script of [
    "check-release-state.cjs",
    "check-protocol-bundle-parity.cjs",
    "recover-cdn-version-trees.sh",
  ])
    write(`temp/${script}`, fs.readFileSync(path.join(root, "scripts", script)));

  const executable = (name, code) => {
    write(`bin/${name}`, `#!/usr/bin/env node\n${code}`);
    fs.chmodSync(path.join(dir, "bin", name), 0o755);
  };
  const common = `const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);const read=f=>fs.readFileSync(f,'utf8');const log=s=>fs.appendFileSync('calls',s+'\\n');`;
  executable(
    "git",
    common +
      `
    if(args[0]==='ls-remote') {
      if(process.env.REMOTE_ERROR) process.exit(1);
      const advance=Number(process.env.ADVANCE_AFTER||'0');
      const count=(fs.existsSync('fence-count')?Number(read('fence-count')):0)+1;
      fs.writeFileSync('fence-count',String(count));
      // Move the branch under the run, before this very fence answers.
      if(advance&&count===advance) fs.writeFileSync('remote','f'.repeat(40));
      const ref=args.find(a=>a.startsWith('refs/heads/'));
      console.log(read('remote')+'\\t'+ref); process.exit(0);
    }
    const r=require('node:child_process').spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(r.status??1);
  `,
  );
  executable(
    "aws",
    common +
      `
    const value=k=>args[args.indexOf(k)+1];
    const key=args.includes('--key')?value('--key'):'';const object=path.join('bucket',key);
    const metaPath=object+'.meta';
    if(args[1]==='head-object') {
      if(process.env.HEAD_ERROR) { console.error(process.env.HEAD_ERROR);process.exit(1); }
      if(!fs.existsSync(object)) {console.error('An error occurred (404) when calling the HeadObject operation: Not Found');process.exit(1);}
      const meta=fs.existsSync(metaPath)?JSON.parse(read(metaPath)):{ContentType:process.env.EXISTING_CONTENT_TYPE||'application/json; charset=utf-8'};
      if(args.includes('--query')&&value('--query')==='ContentType') console.log(meta.ContentType);
      process.exit(0);
    }
    if(args[1]==='put-object') {
      if(value('--if-none-match')!=='*') throw Error('unconditional write');
      if(fs.existsSync(object)) {console.error('PreconditionFailed');process.exit(1);}
      fs.mkdirSync(path.dirname(object),{recursive:true});fs.copyFileSync(value('--body'),object);
      fs.writeFileSync(metaPath,JSON.stringify({ContentType:value('--content-type'),CacheControl:value('--cache-control')}));
      log('put '+key+' | '+value('--content-type')+' | '+value('--cache-control'));
      process.exit(0);
    }
    if(args[0]==='s3'&&args[1]==='cp'&&args[2].startsWith('s3://')) {
      fs.copyFileSync(path.join('bucket',args[2].split('/').slice(3).join('/')),args[3]);
      process.exit(0);
    }
    throw Error('unexpected aws '+args.join(' '));
  `,
  );

  const env = {
    PATH: `${dir}/bin:${process.env.PATH}`,
    HOME: dir,
    TESTED_SHA: head,
    GITHUB_SHA: head,
    PUBLICATION_BRANCH: "main",
    GITHUB_REF_NAME: "main",
    VERSION: version,
    FENCE_SCRIPT: path.join(dir, "temp/check-release-state.cjs"),
    PARITY_SCRIPT: path.join(dir, "temp/check-protocol-bundle-parity.cjs"),
    BUCKET: "test",
    R2_ENDPOINT: "https://r2.invalid",
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
    CDN_VERIFY_ATTEMPTS: "1",
  };

  const argv = (mode) => [
    "--noprofile",
    "--norc",
    path.join(dir, "temp/recover-cdn-version-trees.sh"),
    mode,
  ];
  const run = (mode, extra = {}) =>
    spawnSync("bash", argv(mode), {
      cwd: dir,
      env: { ...env, ...extra },
      encoding: "utf8",
    });
  // The verification tests answer the script's own HTTP requests from this
  // process, so they cannot block its event loop on spawnSync.
  const runAsync = (mode, extra = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn("bash", argv(mode), {
        cwd: dir,
        env: { ...env, ...extra },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });

  return {
    dir,
    head,
    version,
    write,
    git,
    run,
    runAsync,
    bucketKeys: () =>
      fs.existsSync(path.join(dir, "bucket"))
        ? listFiles(path.join(dir, "bucket"))
            .filter((key) => !key.endsWith(".meta"))
            .sort()
        : [],
    calls: () =>
      fs
        .readFileSync(path.join(dir, "calls"), "utf8")
        .split("\n")
        .filter(Boolean),
  };
}

function listFiles(base, prefix = "") {
  const out = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      out.push(...listFiles(path.join(base, entry.name), relative));
    else out.push(relative);
  }
  return out;
}

const expectedKeys = Object.keys(RELEASED_TREE)
  .map((relative) => {
    const [surface, ...rest] = relative.split("/");
    return `${surface}/${VERSION}/${rest.join("/")}`;
  })
  .sort();

// --- upload -----------------------------------------------------------------

test("recovery publishes every missing version object conditionally and immutably", (t) => {
  const f = fixture(t);
  const result = f.run("upload");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.bucketKeys(), expectedKeys);
  assert.match(result.stdout, /created 8 missing object\(s\), verified 0/);

  const published = new Map(
    f.calls().map((line) => {
      const [key, contentType, cacheControl] = line
        .replace(/^put /, "")
        .split(" | ");
      return [key, { contentType, cacheControl }];
    }),
  );
  assert.deepEqual([...published.keys()].sort(), expectedKeys);
  for (const entry of published.values())
    assert.equal(entry.cacheControl, IMMUTABLE);
  assert.equal(
    published.get(`schemas/${VERSION}/index.json`).contentType,
    "application/json; charset=utf-8",
  );
  assert.equal(
    published.get(`compliance/${VERSION}/universal/pagination.yaml`).contentType,
    "application/yaml; charset=utf-8",
  );
  assert.equal(
    published.get(`compliance/${VERSION}/README.md`).contentType,
    "text/markdown; charset=utf-8",
  );
  assert.equal(
    published.get(`compliance/${VERSION}/test-kits/rows.jsonl`).contentType,
    "application/x-ndjson; charset=utf-8",
  );
  assert.equal(
    published.get(`compliance/${VERSION}/notes.txt`).contentType,
    "text/plain; charset=utf-8",
  );
});

test("an already published object is verified, never rewritten", (t) => {
  const f = fixture(t);
  f.write(
    `bucket/schemas/${VERSION}/index.json`,
    RELEASED_TREE["schemas/index.json"],
  );
  const result = f.run("upload");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /created 7 missing object\(s\), verified 1/);
  assert.ok(
    !f.calls().some((line) => line.includes(`schemas/${VERSION}/index.json`)),
  );
});

test("a published object with different bytes stops recovery instead of overwriting", (t) => {
  const f = fixture(t);
  f.write(`bucket/compliance/${VERSION}/index.json`, '{"adcp_version":"3.0.26"}');
  const result = f.run("upload");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exists with different bytes; refusing overwrite/);
  assert.ok(
    !f.calls().some((line) => line.includes(`compliance/${VERSION}/index.json`)),
  );
});

test("an inconclusive existence check never reads as absent", (t) => {
  const f = fixture(t);
  const result = f.run("upload", {
    HEAD_ERROR: "An error occurred (403) when calling the HeadObject operation: Forbidden",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not safely determine whether R2 object/);
  assert.deepEqual(f.calls(), []);
});

for (const [label, overrides] of [
  ["a changed file", { "schemas/core/product.json": '{"title":"Tampered"}\n' }],
  ["an extra file", { "schemas/core/extra.json": "{}\n" }],
  ["a missing file", { "compliance/notes.txt": null }],
]) {
  test(`released trees with ${label} relative to the signed bundle are never published`, (t) => {
    const f = fixture(t, { bundleOverrides: overrides });
    const run = f.run("upload");
    assert.notEqual(run.status, 0);
    assert.match(
      run.stderr,
      /signed protocol bundle|does not match the released tree/,
    );
    assert.deepEqual(f.bucketKeys(), []);
    assert.deepEqual(f.calls(), []);
  });
}

test("only the bundle build's own timestamp pin may differ, and only in its own file", (t) => {
  // A rewritten timestamp in a file the bundle build never pins is a content
  // difference, not an exemption.
  const f = fixture(t, {
    bundleOverrides: {
      "compliance/universal/pagination.yaml": "id: pagination\ngenerated_at: x\n",
    },
  });
  const result = f.run("upload");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /differs from the signed protocol bundle/);
  assert.deepEqual(f.bucketKeys(), []);
});

test("recovery refuses a prerelease, a mismatched checkout, and a stale branch", (t) => {
  const prerelease = fixture(t);
  const rc = prerelease.run("upload", { VERSION: "3.2.0-rc.3" });
  assert.notEqual(rc.status, 0);
  assert.match(rc.stderr, /exact stable semver/);
  assert.deepEqual(prerelease.calls(), []);

  const mismatched = fixture(t, { packageVersion: "3.0.26" });
  const wrongCheckout = mismatched.run("upload");
  assert.notEqual(wrongCheckout.status, 0);
  assert.match(wrongCheckout.stderr, /checkout holds package version 3\.0\.26/);
  assert.deepEqual(mismatched.calls(), []);

  const stale = fixture(t);
  stale.write("remote", "f".repeat(40));
  const moved = stale.run("upload");
  assert.notEqual(moved.status, 0);
  assert.match(moved.stderr, /Refusing stale tested SHA/);
  assert.deepEqual(stale.calls(), []);
});

test("the branch fence is rechecked between objects, so a mid-run branch move stops publication", (t) => {
  const f = fixture(t);
  // Fence calls: one preflight, then three per published object. Moving the
  // branch on the fifth lands inside the second object, after the first was
  // already written.
  const result = f.run("upload", { ADVANCE_AFTER: "5" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing stale tested SHA/);
  assert.equal(f.calls().length, 1);
  assert.equal(f.bucketKeys().length, 1);
});

test("a file whose extension has no published content type stops recovery before any write", (t) => {
  const f = fixture(t, {
    tree: { ...RELEASED_TREE, "schemas/bundle.tar": "binary\n" },
    bundleOverrides: {},
  });
  const result = f.run("upload");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no published content type/);
  assert.deepEqual(f.bucketKeys(), []);
  assert.deepEqual(f.calls(), []);
});

test("a symlinked entry in the released tree is refused", (t) => {
  const f = fixture(t);
  f.git("rm", "-q", "--cached", `dist/schemas/${VERSION}/core/product.json`);
  fs.rmSync(path.join(f.dir, `dist/schemas/${VERSION}/core/product.json`));
  fs.symlinkSync(
    "../../../../package.json",
    path.join(f.dir, `dist/schemas/${VERSION}/core/product.json`),
  );
  f.git("add", "-A");
  f.git("commit", "-qm", "Symlinked schema");
  f.write("remote", f.git("rev-parse", "HEAD"));
  const result = f.run("upload", { TESTED_SHA: f.git("rev-parse", "HEAD") });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported Git entry in the released trees/);
  assert.deepEqual(f.calls(), []);
});

test("published bytes are the committed blobs, not a .gitattributes rewrite", (t) => {
  // `git archive` applies the tag's own export-subst filter, which splices the
  // commit subject into the bytes it emits. Recovery must read blobs instead.
  const f = fixture(t, {
    tree: { ...RELEASED_TREE, "schemas/core/product.json": '{"s":"$Format:%s$"}\n' },
  });
  f.write(".gitattributes", `dist/schemas/${VERSION}/core/product.json export-subst\n`);
  f.git("add", "-A");
  f.git("commit", "-qm", "SUBSTITUTED-COMMIT-SUBJECT");
  f.write("remote", f.git("rev-parse", "HEAD"));
  const result = f.run("upload", { TESTED_SHA: f.git("rev-parse", "HEAD") });
  assert.equal(result.status, 0, result.stderr);
  const published = fs.readFileSync(
    path.join(f.dir, `bucket/schemas/${VERSION}/core/product.json`),
    "utf8",
  );
  assert.equal(published, '{"s":"$Format:%s$"}\n');
  assert.doesNotMatch(published, /SUBSTITUTED-COMMIT-SUBJECT/);
});

test("a tarball that fails its committed checksum stops recovery", (t) => {
  const f = fixture(t);
  f.write(`dist/protocol/${VERSION}.tgz.sha256`, `${"0".repeat(64)}  ${VERSION}.tgz\n`);
  f.git("add", "-A");
  f.git("commit", "-qm", "Broken checksum");
  f.write("remote", f.git("rev-parse", "HEAD"));
  const result = f.run("upload", { TESTED_SHA: f.git("rev-parse", "HEAD") });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fails its committed checksum/);
  assert.deepEqual(f.bucketKeys(), []);
});

test("a bundle for another version cannot stand in for this one", (t) => {
  // cosign binds the signing workflow, not the version, so the bundle's root
  // directory name is the only thing tying the signature to this release.
  const f = fixture(t);
  const stage = path.join(f.dir, "restage");
  fs.mkdirSync(path.join(stage, "adcp-3.0.26"), { recursive: true });
  fs.writeFileSync(path.join(stage, "adcp-3.0.26", "README.md"), "other\n");
  execFileSync("tar", [
    "-czf", path.join(f.dir, `dist/protocol/${VERSION}.tgz`),
    "-C", stage, "adcp-3.0.26",
  ]);
  const digest = crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(f.dir, `dist/protocol/${VERSION}.tgz`)))
    .digest("hex");
  f.write(`dist/protocol/${VERSION}.tgz.sha256`, `${digest}  ${VERSION}.tgz\n`);
  f.git("add", "-A");
  f.git("commit", "-qm", "Swapped bundle");
  f.write("remote", f.git("rev-parse", "HEAD"));
  const result = f.run("upload", { TESTED_SHA: f.git("rev-parse", "HEAD") });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`no adcp-${VERSION} root directory`));
  assert.deepEqual(f.bucketKeys(), []);
});

test("a released tree without its index.json is refused", (t) => {
  const tree = { ...RELEASED_TREE };
  delete tree["compliance/index.json"];
  const f = fixture(t, { tree });
  const result = f.run("upload");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /without an index\.json/);
  assert.deepEqual(f.bucketKeys(), []);
});

test("an existing object with the right bytes but the wrong content type is refused", (t) => {
  // No-overwrite means a mistyped object cannot be repaired here, and the CDN
  // serves the stored type, so this must stop rather than report "verified".
  const f = fixture(t);
  f.write(
    `bucket/schemas/${VERSION}/index.json`,
    RELEASED_TREE["schemas/index.json"],
  );
  f.write(
    `bucket/schemas/${VERSION}/index.json.meta`,
    JSON.stringify({ ContentType: "text/plain; charset=utf-8" }),
  );
  const result = f.run("upload");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exists with content type text\/plain/);
});

test("upload refuses an unusable destination or missing credentials", (t) => {
  const f = fixture(t);
  for (const [extra, pattern] of [
    [{ BUCKET: "s3://adcp-artifacts" }, /must be a bucket name, not a URL/],
    [{ BUCKET: "" }, /Missing destination bucket/],
    [{ R2_ENDPOINT: "", R2_ACCOUNT_ID: "" }, /Missing R2 endpoint/],
    [{ AWS_SECRET_ACCESS_KEY: "" }, /Missing R2 publication credentials/],
  ]) {
    const result = f.run("upload", extra);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, pattern);
  }
  assert.deepEqual(f.bucketKeys(), []);
  assert.deepEqual(f.calls(), []);
});

test("the script refuses an unknown mode and an unusable retry budget", (t) => {
  const f = fixture(t);
  const mode = f.run("publish");
  assert.equal(mode.status, 2);
  assert.match(mode.stderr, /Usage: recover-cdn-version-trees\.sh/);
  const budget = f.run("verify", { CDN_VERIFY_ATTEMPTS: "0" });
  assert.notEqual(budget.status, 0);
  assert.match(budget.stderr, /CDN_VERIFY_ATTEMPTS must be a positive integer/);
});

// --- verify -----------------------------------------------------------------

function serveCdn(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  // curl keeps its parallel connections alive, so close() alone would leave
  // the test process waiting on them after the assertions are done.
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return new Promise((resolve) =>
    server.once("listening", () =>
      resolve(`http://127.0.0.1:${server.address().port}`),
    ),
  );
}

// An R2 hit through the worker: the released bytes, the immutable policy, and
// R2's single-part ETag, which is the body's hex MD5.
function exactServer(f, options = {}) {
  const {
    cacheControl = IMMUTABLE,
    corrupt = null,
    // Models the worker proxying an R2 miss to the Fly origin, which serves
    // the same committed tree under the same immutable policy but cannot
    // produce R2's ETag.
    etagFor = (body) => `"${crypto.createHash("md5").update(body).digest("hex")}"`,
  } = options;
  return (request, response) => {
    const key = decodeURIComponent(request.url.split("?")[0]).slice(1);
    const file = path.join(f.dir, "dist", key);
    if (!fs.existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    const body =
      key === corrupt ? Buffer.from("tampered\n") : fs.readFileSync(file);
    const headers = { "cache-control": cacheControl };
    const etag = etagFor(body, key);
    if (etag) headers.etag = etag;
    response.writeHead(200, headers);
    response.end(request.method === "HEAD" ? undefined : body);
  };
}

test("verification passes only when the CDN serves the released bytes", async (t) => {
  const f = fixture(t);
  const base = await serveCdn(t, exactServer(f));
  const result = await f.runAsync("verify", { CDN_BASE_URL: base });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /serves all 8 3\.0\.27 schema and compliance objects byte-exact/);
});

test("verification fails when any served object differs", async (t) => {
  const f = fixture(t);
  const corrupt = `schemas/${VERSION}/core/product.json`;
  const base = await serveCdn(
    t,
    // Serve tampered bytes under the ETag the real object would have, so the
    // header checks pass and the byte comparison is the thing that must catch
    // it.
    exactServer(f, {
      corrupt,
      etagFor: (body, key) =>
        `"${crypto
          .createHash("md5")
          .update(
            key === corrupt
              ? fs.readFileSync(path.join(f.dir, "dist", key))
              : body,
          )
          .digest("hex")}"`,
    }),
  );
  const result = await f.runAsync("verify", { CDN_BASE_URL: base });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /differs from the released bytes/);
});

test("verification fails when the version is still served under a fallback policy", async (t) => {
  // Before recovery the worker resolves the pin to a neighbouring release and
  // stamps the revalidate policy. Byte comparison alone can pass when the two
  // releases happen to agree, so the policy must be checked too.
  const f = fixture(t);
  const base = await serveCdn(t, exactServer(f, { cacheControl: REVALIDATE }));
  const result = await f.runAsync("verify", { CDN_BASE_URL: base });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /do not match the recovered 3\.0\.27 objects/);
});

test("verification fails when the bytes come from the origin rather than the bucket", async (t) => {
  // The case the policy check alone cannot catch: on an R2 miss the worker
  // proxies to Fly, which serves the same committed tree AND stamps the same
  // immutable policy for an exact pinned hit. Only R2 produces the body's MD5
  // as the ETag, so that is what proves the object is really in the bucket.
  const f = fixture(t);
  const base = await serveCdn(
    t,
    exactServer(f, { etagFor: () => 'W/"1a2-18f3c4d5e6f"' }),
  );
  const result = await f.runAsync("verify", { CDN_BASE_URL: base });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /did not come from the bucket/);
});

test("verification fails when a served ETag is absent", async (t) => {
  const f = fixture(t);
  const base = await serveCdn(t, exactServer(f, { etagFor: () => null }));
  const result = await f.runAsync("verify", { CDN_BASE_URL: base });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /do not match the recovered 3\.0\.27 objects/);
});

test("verification retries while the CDN catches up, then passes", async (t) => {
  // The worker caches its published-version list for 60s, so a freshly created
  // prefix can need a retry before it wins an exact pinned hit.
  const f = fixture(t);
  // Each attempt uses a distinct cache-bust token, which is the only
  // order-independent way to tell the rounds apart under parallel requests.
  const busts = new Set();
  const base = await serveCdn(t, (request, response) => {
    const bust = new URL(request.url, "http://cdn.invalid").searchParams.get(
      "cache_bust",
    );
    busts.add(bust);
    const isFirstRound = [...busts][0] === bust;
    exactServer(f, isFirstRound ? { cacheControl: REVALIDATE } : {})(
      request,
      response,
    );
  });
  const result = await f.runAsync("verify", {
    CDN_BASE_URL: base,
    CDN_VERIFY_ATTEMPTS: "2",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /failed on attempt 1; retrying/);
  assert.match(result.stdout, /byte-exact \(attempt 2\)/);
});

test("verification fails when an object is missing from the CDN", async (t) => {
  const f = fixture(t);
  const base = await serveCdn(t, (request, response) => {
    if (request.url.includes("notes.txt")) {
      response.writeHead(404).end();
      return;
    }
    exactServer(f)(request, response);
  });
  const result = await f.runAsync("verify", { CDN_BASE_URL: base });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /byte-exact/);
});

// --- workflow wiring --------------------------------------------------------

test("the dispatch keeps its existing protocol-only default", () => {
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.equal(inputs.surfaces.type, "choice");
  assert.equal(inputs.surfaces.default, "protocol");
  assert.deepEqual(inputs.surfaces.options, ["protocol", "all"]);
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.env.PUBLICATION_BRANCH, "main");
  // One recovery per version, whatever the surfaces, so two dispatches cannot
  // interleave reads and conditional writes on the same objects.
  assert.ok(!workflow.concurrency.group.includes("surfaces"));
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
});

test("tree recovery runs the current branch's scripts, not the recovered tag's", () => {
  const preserve = stepNamed("Preserve current workflow publication fence");
  const checkout = recoverySteps.findIndex(
    (s) => s.name === "Validate release input and checkout tag",
  );
  assert.ok(
    recoverySteps.indexOf(preserve) < checkout,
    "scripts must be preserved before the tag checkout replaces them",
  );
  for (const script of [
    "check-release-state.cjs",
    "check-protocol-bundle-parity.cjs",
    "recover-cdn-version-trees.sh",
  ]) {
    assert.ok(
      preserve.run.includes(`cp scripts/${script} "$RUNNER_TEMP/${script}"`),
      `${script} must be preserved from the current branch`,
    );
    assert.ok(
      fs.existsSync(path.join(root, "scripts", script)),
      `${script} must exist on the current branch`,
    );
  }

  for (const [name, mode] of [
    ["Upload only missing immutable schema and compliance objects", "upload"],
    ["Verify recovered public CDN trees", "verify"],
  ]) {
    const step = stepNamed(name);
    assert.ok(step, `${name} must exist`);
    assert.equal(step.if, "inputs.surfaces == 'all'");
    assert.equal(
      step.run.trim(),
      `bash "$RUNNER_TEMP/recover-cdn-version-trees.sh" ${mode}`,
    );
    assert.equal(step.env.VERSION, "${{ inputs.version }}");
    assert.equal(step.env.FENCE_SCRIPT, "${{ runner.temp }}/check-release-state.cjs");
    assert.equal(
      step.env.PARITY_SCRIPT,
      "${{ runner.temp }}/check-protocol-bundle-parity.cjs",
    );
    // Retry budget and CDN origin stay at the script defaults.
    assert.ok(!("CDN_VERIFY_ATTEMPTS" in step.env));
    assert.ok(!("CDN_BASE_URL" in step.env));
  }

  const verify = stepNamed("Verify recovered public CDN trees");
  for (const secret of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "BUCKET"])
    assert.ok(
      !(secret in verify.env),
      `${secret} must not be exposed to the read-only verification step`,
    );
});

test("every recovery step still fails closed on the current-branch fence", () => {
  const protocolUpload = stepNamed("Upload only missing immutable R2 objects");
  assert.match(protocolUpload.run, /check-release-state\.cjs" current/);
  const script = fs.readFileSync(
    path.join(root, "scripts/recover-cdn-version-trees.sh"),
    "utf8",
  );
  assert.match(script, /node "\$FENCE_SCRIPT" current/);
  assert.match(script, /--if-none-match '\*'/);
  assert.doesNotMatch(script, /s3 rm|--delete|rb /);
});
