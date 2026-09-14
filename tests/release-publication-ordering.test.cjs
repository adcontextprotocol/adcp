const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const YAML = require("yaml");
const root = path.resolve(__dirname, "..");
const release = YAML.parse(
  fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8"),
);
const deploy = YAML.parse(
  fs.readFileSync(path.join(root, ".github/workflows/deploy.yml"), "utf8"),
);
const steps = release.jobs.release.steps;
const step = (name) => steps.find((s) => s.name === name);
const version = "3.2.0-rc.3";
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

function fixture(t, fixtureVersion = version) {
  const version = fixtureVersion;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publication-order-"));
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
  write("package.json", JSON.stringify({ version }));
  for (const area of ["schemas", "compliance"]) {
    write(`dist/${area}/${version}/index.json`, '{"release":true}');
    write(`dist/${area}/latest/index.json`, '{"development":true}');
  }
  for (const suffix of ["", ".sha256", ".sig", ".crt"])
    write(`dist/protocol/${version}.tgz${suffix}`, `signed${suffix}`);
  write("dist/protocol/latest.tgz", "development");
  for (const script of ["check-release-state.cjs", "backfill-cdn-artifacts.sh"])
    write(
      `scripts/${script}`,
      fs.readFileSync(path.join(root, "scripts", script)),
    );
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("add", ".");
  git("commit", "-qm", "Approved release");
  const source = git("rev-parse", "HEAD");
  write(".changeset/next.md", "later changeset");
  git("add", ".");
  git("commit", "-qm", "Later changeset");
  const head = git("rev-parse", "HEAD");
  write("remote", head);
  write("tag", source);
  write("calls", "");
  write(
    "release.json",
    JSON.stringify({
      tagName: `v${version}`,
      targetCommitish: source,
      isDraft: false,
      isPrerelease: version.includes("-"),
      assets: ["", ".sha256", ".sig", ".crt"].map((s) => ({
        name: `${version}.tgz${s}`,
      })),
    }),
  );
  const executable = (name, code) => {
    write(`bin/${name}`, `#!/usr/bin/env node\n${code}`);
    fs.chmodSync(path.join(dir, "bin", name), 0o755);
  };
  const common = `const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);const read=f=>fs.readFileSync(f,'utf8');const log=s=>fs.appendFileSync('calls',s+'\\n');const change=()=>fs.writeFileSync('remote','f'.repeat(40));`;
  executable(
    "git",
    common +
      `
    if(args[0]==='push' && process.env.ADVANCE_PUSH) { log('branch push');change();process.exit(0); }
    if(args[0]==='ls-remote') {
      if(process.env.REMOTE_ERROR) process.exit(1);
      const ref=args.find(a=>a.startsWith('refs/heads/'));
      if(ref) { console.log(read('remote')+'\\t'+ref); process.exit(0); }
      const tag=read('tag'); if(!tag) process.exit(args.includes('--exit-code')?2:0);
      console.log(tag+'\\trefs/tags/v${version}'); process.exit(0);
    }
    const r=require('node:child_process').spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(r.status??1);
  `,
  );
  executable(
    "gh",
    common +
      `
    const release=()=>JSON.parse(read('release.json'));
    const save=r=>fs.writeFileSync('release.json',JSON.stringify(r));
    if(args[0]==='api') {
      const url=args.find(a=>a.startsWith('/repos/'));
      if(url.includes('/commits/')) console.log(JSON.stringify([{number:1,merged_at:'2026-09-14',base:{ref:'main'}}]));
      else if(url.endsWith('/reviews')) console.log(process.env.REVIEWS||'[]');
      else console.log(JSON.stringify({head:{sha:'a'.repeat(40)},merge_commit_sha:process.env.RELEASE_SHA,user:{login:'author'}}));
    } else if(args[1]==='view') {
      if(!fs.existsSync('release.json')) process.exit(1);
      const r=release();
      if(args.includes('--jq')) {
        const q=args[args.indexOf('--jq')+1];const name=q.match(/name == "([^"]+)"/)[1];console.log(r.assets.find(a=>a.name===name)?.name||'');
      } else console.log(JSON.stringify(r));
    } else if(args[1]==='create') {
      log('github draft'); save({tagName:args[2],targetCommitish:process.env.RELEASE_SHA,isDraft:true,isPrerelease:args.includes('--prerelease'),assets:[]});
    } else if(args[1]==='upload') {
      const r=release(); if(!r.isDraft) throw Error('upload was publicly visible before staging completed');
      const name=path.basename(args[3]);r.assets.push({name});save(r);log('github upload '+name);
      if(process.env.ADVANCE_GITHUB) change();
    } else if(args[1]==='download') {
      const name=args[args.indexOf('--pattern')+1],dir=args[args.indexOf('--dir')+1];
      fs.copyFileSync('dist/protocol/'+name,path.join(dir,name));
      if(process.env.DIFFERING_GITHUB_ASSET===name) fs.appendFileSync(path.join(dir,name),'different');
    } else if(args[1]==='edit') {
      const r=release();if(r.assets.length!==4) throw Error('incomplete release');r.isDraft=false;save(r);fs.writeFileSync('tag',process.env.RELEASE_SHA);log('github publish');
    } else throw Error('unexpected gh '+args);
  `,
  );
  executable(
    "aws",
    common +
      `
    const value=k=>args[args.indexOf(k)+1];
    const key=args.includes('--key')?value('--key'):'';const object=path.join('bucket',key);
    if(args[1]==='head-object') {
      if(process.env.HEAD_ERROR) { console.error('Forbidden (403)');process.exit(1); }
      if(!fs.existsSync(object)) {console.error('An error occurred (404) when calling HeadObject');process.exit(1);}
    } else if(args[1]==='put-object') {
      if(value('--if-none-match')!=='*') throw Error('unconditional write');
      if(fs.existsSync(object)||process.env.PUT_RACE) {console.error('PreconditionFailed');process.exit(1);}
      fs.mkdirSync(path.dirname(object),{recursive:true});fs.copyFileSync(value('--body'),object);log('r2 put '+key);
      if(process.env.ADVANCE_AWS) change();
    } else if(args[0]==='s3'&&args[1]==='cp'&&args[2].startsWith('s3://')) {
      fs.copyFileSync(path.join('bucket',args[2].split('/').slice(3).join('/')),args[3]);
    } else if(args[0]==='s3') {
      log('r2 mutable '+args[3]);if(process.env.ADVANCE_AWS) change();
    } else throw Error('unexpected aws '+args);
  `,
  );
  executable("npm", common + `if(process.env.ADVANCE_BUILD) change();`);
  const env = {
    PATH: `${dir}/bin:${process.env.PATH}`,
    TESTED_SHA: head,
    GITHUB_SHA: head,
    PUBLICATION_BRANCH: "main",
    GITHUB_REF_NAME: "main",
    GITHUB_REPOSITORY: "adcontextprotocol/adcp",
    RELEASE_SHA: source,
    R2_ENDPOINT: "https://r2.invalid",
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
    RUNNER_TEMP: path.join(dir, "temp"),
    GITHUB_PATH: path.join(dir, "github-path"),
  };
  const run = (command, args, extra = {}) =>
    spawnSync(
      command,
      command === "bash" ? ["--noprofile", "--norc", ...args] : args,
      { cwd: dir, env: { ...env, ...extra }, encoding: "utf8" },
    );
  const script = (mode, extra) =>
    run("node", ["scripts/check-release-state.cjs", mode], extra);
  const upload = (options, extra) =>
    run(
      "bash",
      ["scripts/backfill-cdn-artifacts.sh", "--bucket", "test", ...options],
      extra,
    );
  return {
    dir,
    source,
    head,
    write,
    git,
    run,
    script,
    upload,
    calls: () => fs.readFileSync(path.join(dir, "calls"), "utf8"),
  };
}
const immutable = ["--version", version, "--skip-latest"];
const approval = (extra) =>
  JSON.stringify([
    {
      user: { type: "User", login: "reviewer" },
      state: "APPROVED",
      commit_id: "a".repeat(40),
      submitted_at: "2026-09-14",
      ...extra,
    },
  ]);

test("app-only deploy publishes only development keys with no human release approval", (t) => {
  const f = fixture(t);
  const result = f.upload(["--latest-only"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(f.calls().includes("schemas/latest"));
  assert.ok(!f.calls().includes(version));
  assert.ok(
    f
      .calls()
      .trim()
      .split("\n")
      .every((line) => /\/latest(?:\/|\.|$)/.test(line)),
  );
});
for (const scenario of [
  "before upload",
  "during long build",
  "during upload",
  "remote lookup failure",
])
  test(`fails closed when main changes ${scenario}`, (t) => {
    const f = fixture(t);
    if (scenario === "before upload") f.write("remote", "f".repeat(40));
    const env =
      scenario === "during long build"
        ? { ADVANCE_BUILD: "1" }
        : scenario === "during upload"
          ? { ADVANCE_AWS: "1" }
          : scenario === "remote lookup failure"
            ? { REMOTE_ERROR: "1" }
            : {};
    const r = f.upload(["--latest-only", "--build-latest"], env);
    assert.notEqual(r.status, 0);
    assert.equal(
      f.calls().trim().split("\n").filter(Boolean).length,
      scenario === "during upload" ? 1 : 0,
    );
  });
test("main advances during a long app deploy after its successful pre-deploy gate", (t) => {
  const f = fixture(t);
  assert.equal(f.script("pending").status, 0);
  // Simulate a completed long app deployment: its tested SHA is now obsolete.
  f.write("remote", "f".repeat(40));
  assert.notEqual(f.upload(["--latest-only"]).status, 0);
  assert.equal(f.calls(), "");
});
test("old run cannot update Changesets after verification/versioning or enter publication", (t) => {
  const f = fixture(t);
  const install = f.run("bash", ["-c", step("Fence Changesets mutations").run]);
  assert.equal(install.status, 0, install.stderr);
  f.write("remote", "f".repeat(40));
  const hook = f.run("sh", [path.join(f.dir, "temp/release-hooks/pre-push")]);
  assert.notEqual(hook.status, 0);
  assert.notEqual(f.script("current").status, 0);
  assert.equal(f.calls(), "");
});
test("queued committed release survives later pushes; lost/manual cancellations require explicit recovery", (t) => {
  assert.deepEqual(release.concurrency, {
    group: "${{ github.workflow }}-${{ github.ref }}",
    "cancel-in-progress": false,
    queue: "max",
  });
  const f = fixture(t);
  f.write("tag", "");
  assert.notEqual(f.script("pending").status, 0);
  assert.notEqual(f.upload(immutable).status, 0);
  assert.equal(f.calls(), "");
  assert.equal(
    f.run("node", ["scripts/check-release-state.cjs", "recovery", f.source])
      .status,
    0,
  );
  f.write(`dist/schemas/${version}/index.json`, "changed");
  f.git("add", ".");
  f.git("commit", "-qm", "changed artifact");
  const head = f.git("rev-parse", "HEAD");
  f.write("remote", head);
  assert.notEqual(
    f.run("node", ["scripts/check-release-state.cjs", "recovery", f.source], {
      TESTED_SHA: head,
    }).status,
    0,
  );
});
for (const [name, reviews] of [
  ["none", "[]"],
  ["bot", approval({ user: { type: "Bot", login: "bot" } })],
  ["stale", approval({ commit_id: "b".repeat(40) })],
  ["dismissed", approval({ state: "DISMISSED" })],
])
  test(`no ${name} approval can publish`, (t) => {
    const f = fixture(t);
    const r = f.run(
      "bash",
      [
        "-c",
        step("Require human approval for committed release artifacts").run,
      ],
      { REVIEWS: reviews },
    );
    assert.notEqual(r.status, 0);
    assert.equal(f.calls(), "");
  });
test("approved publication stages complete GitHub tuple before release and scoped conditional R2 writes", (t) => {
  const f = fixture(t);
  f.write("tag", "");
  fs.unlinkSync(path.join(f.dir, "release.json"));
  const r = f.run(
    "bash",
    [
      "-c",
      step("Require human approval for committed release artifacts").run +
        "\n" +
        step("Upload protocol tarball to GitHub Release").run.replaceAll(
          "${{ steps.release-artifacts.outputs.version }}",
          version,
        ),
    ],
    { REVIEWS: approval() },
  );
  assert.equal(r.status, 0, r.stderr);
  const upload = f.upload(immutable);
  assert.equal(upload.status, 0, upload.stderr);
  const calls = f.calls().trim().split("\n");
  assert.equal(calls[0], "github draft");
  assert.equal(calls[5], "github publish");
  assert.equal(calls.filter((c) => c.startsWith("r2 put ")).length, 6);
  assert.ok(calls.slice(6).every((c) => c.includes(version)));
  assert.equal(f.upload(immutable).status, 0, "identical retries skip objects");
  assert.equal(f.calls(), calls.join("\n") + "\n");
});
for (const [name, env] of [
  ["drift during put", { ADVANCE_AWS: "1" }],
  ["conditional create race", { PUT_RACE: "1" }],
  ["head uncertainty", { HEAD_ERROR: "1" }],
])
  test(`immutable publication stops on ${name}`, (t) => {
    const f = fixture(t);
    assert.notEqual(f.upload(immutable, env).status, 0);
    assert.equal(
      f.calls().trim().split("\n").filter(Boolean).length,
      env.ADVANCE_AWS ? 1 : 0,
    );
  });
test("existing different bytes cannot be overwritten", (t) => {
  const f = fixture(t);
  f.write(`bucket/schemas/${version}/index.json`, "different");
  assert.notEqual(f.upload(immutable).status, 0);
  assert.equal(f.calls(), "");
});
test("main advancing during GitHub staging leaves a draft and publishes no R2 objects", (t) => {
  const f = fixture(t);
  f.write("tag", "");
  fs.unlinkSync(path.join(f.dir, "release.json"));
  const r = f.run(
    "bash",
    [
      "-c",
      step("Upload protocol tarball to GitHub Release").run.replaceAll(
        "${{ steps.release-artifacts.outputs.version }}",
        version,
      ),
    ],
    { ADVANCE_GITHUB: "1" },
  );
  assert.notEqual(r.status, 0);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.dir, "release.json"))).isDraft,
    true,
  );
  assert.ok(!f.calls().includes("github publish"));
});
test("workflow wiring binds tested SHA, approval, exact recovery, and publication order", () => {
  const ds = deploy.jobs.deploy.steps;
  assert.ok(
    ds.findIndex(
      (s) => s.name === "Require committed version to have a complete release",
    ) < ds.findIndex((s) => s.name === "Deploy"),
  );
  const upload = ds.find((s) => s.name === "Publish latest artifacts to R2");
  assert.match(upload.run, /--latest-only/);
  assert.equal(
    upload.env.TESTED_SHA,
    "${{ github.event.workflow_run.head_sha }}",
  );
  assert.ok(
    steps.indexOf(
      step("Require human approval for committed release artifacts"),
    ) < steps.indexOf(step("Upload protocol tarball to GitHub Release")),
  );
  assert.ok(
    steps.indexOf(step("Upload protocol tarball to GitHub Release")) <
      steps.indexOf(step("Publish release artifacts to R2")),
  );
  assert.equal(
    step("Create Release Pull Request or Tag Release").with["publish-script"],
    undefined,
  );
  assert.equal(
    step("Create Release Pull Request or Tag Release").with[
      "create-github-releases"
    ],
    false,
  );
  for (const name of [
    "Upload protocol tarball to GitHub Release",
    "Publish release artifacts to R2",
  ])
    assert.equal(
      step(name).if,
      "steps.release-artifacts.outputs.has_release_artifacts == 'true'",
    );
  assert.match(
    step("Publish release artifacts to R2").run,
    /--version .* --skip-latest/,
  );
  assert.match(
    step("Detect committed release artifacts").run,
    /check-release-state.cjs recovery/,
  );
});

test("#7508: stale sole-parent release omits a later changeset and rewrites rc.3", (t) => {
  // Incident: 102916bb28c156b1710f031aa28e4655bcf71cdc / tree
  // fd299f52f6bf1a4427ef85f890832d1e5713aade had sole parent eb3cbd,
  // two commits behind af1. This fixture reproduces that graph and delta.
  const f = fixture(t);
  const oldInput = f.source;
  f.write("app-only.txt", "new main behavior");
  f.git("add", "app-only.txt");
  f.git("commit", "-qm", "Second main advance");
  const current = f.git("rev-parse", "HEAD");
  f.write("remote", current);
  f.git("checkout", "-qb", "stale-release", oldInput);
  f.write(
    `dist/schemas/${version}/index.json`,
    "different generated rc.3 bytes",
  );
  f.git("add", `dist/schemas/${version}/index.json`);
  f.git("commit", "-qm", "Stale generated release");
  const stale = f.git("rev-parse", "HEAD");
  assert.equal(f.git("rev-parse", "HEAD^"), oldInput);
  assert.equal(f.git("merge-base", stale, current), oldInput);
  assert.equal(f.git("rev-list", "--count", `${oldInput}..${current}`), "2");
  const delta = f.git("diff", "--name-status", current, stale);
  assert.match(delta, /M\s+dist\/schemas\/3\.2\.0-rc\.3\/index.json/);
  assert.match(delta, /D\s+\.changeset\/next.md/);
  const staleEnvironment = { TESTED_SHA: oldInput, GITHUB_SHA: oldInput };
  assert.notEqual(f.script("current", staleEnvironment).status, 0);
  assert.notEqual(f.upload(immutable, staleEnvironment).status, 0);
  assert.notEqual(
    f.run("node", ["scripts/check-release-state.cjs", "recovery", stale], {
      TESTED_SHA: current,
    }).status,
    0,
  );
  assert.equal(f.calls(), "");
});

for (const surface of ["schemas", "compliance", "partial-protocol"]) {
  test(`the app gate rejects an unapproved ${surface}-only committed release`, (t) => {
    const f = fixture(t);
    for (const area of ["schemas", "compliance", "protocol"]) {
      fs.rmSync(path.join(f.dir, "dist", area), { recursive: true });
    }
    const remaining =
      surface === "partial-protocol"
        ? `dist/protocol/${version}.tgz.sig`
        : `dist/${surface}/${version}/index.json`;
    f.write(remaining, "partial candidate");
    f.write("tag", "");
    const result = f.script("pending");
    assert.notEqual(result.status, 0);
    assert.equal(f.calls(), "");
  });
}

for (const candidate of ["3.2.0-rc.3", "3.1.23"]) {
  for (const draft of [true, false]) {
    test(`rejects wrong prerelease metadata for ${candidate} (draft=${draft})`, (t) => {
      const f = fixture(t, candidate);
      const record = JSON.parse(
        fs.readFileSync(path.join(f.dir, "release.json")),
      );
      record.isPrerelease = !candidate.includes("-");
      record.isDraft = draft;
      f.write("release.json", JSON.stringify(record));
      const result = f.run("bash", [
        "-c",
        step("Upload protocol tarball to GitHub Release").run.replaceAll(
          "${{ steps.release-artifacts.outputs.version }}",
          candidate,
        ),
      ]);
      assert.notEqual(result.status, 0);
      assert.notEqual(
        f.upload(["--version", candidate, "--skip-latest"]).status,
        0,
      );
      assert.equal(f.calls(), "");
    });
  }
}

for (const suffix of ["", ".sha256", ".sig", ".crt"]) {
  test(`direct/stable R2 recovery rejects different GitHub ${suffix || "tarball"} bytes`, (t) => {
    const f = fixture(t, "3.1.23");
    const result = f.upload(["--version", "3.1.23", "--skip-latest"], {
      DIFFERING_GITHUB_ASSET: `3.1.23.tgz${suffix}`,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /differs from the tagged local tuple/);
    assert.equal(f.calls(), "");
  });
}

test("a successful long Changesets push followed by drift stops before the PR API call", (t) => {
  const f = fixture(t);
  const installed = f.run("bash", [
    "-c",
    step("Fence Changesets mutations").run,
  ]);
  assert.equal(installed.status, 0, installed.stderr);
  // GITHUB_PATH is applied to the next action exactly as Actions applies it.
  const wrapperDirectory = fs
    .readFileSync(path.join(f.dir, "github-path"), "utf8")
    .trim();
  const result = f.run(
    "bash",
    [
      "-c",
      'set -e\ngit push origin HEAD:changeset-release/main --force\nprintf "PR API write\\n" >> calls',
    ],
    {
      PATH: `${wrapperDirectory}:${path.join(f.dir, "bin")}:${process.env.PATH}`,
      ADVANCE_PUSH: "1",
    },
  );
  assert.notEqual(result.status, 0);
  assert.equal(f.calls(), "branch push\n");
});

for (const mismatch of [false, true]) {
  test(`stable recovery workflow validates GitHub bytes before R2 (mismatch=${mismatch})`, (t) => {
    const f = fixture(t, "3.1.23");
    const workflow = YAML.parse(
      fs.readFileSync(
        path.join(root, ".github/workflows/recover-protocol-cdn.yml"),
        "utf8",
      ),
    );
    f.write(
      "temp/check-release-state.cjs",
      fs.readFileSync(path.join(f.dir, "scripts/check-release-state.cjs")),
    );
    f.git("checkout", "--detach", f.source);
    const upload = workflow.jobs.recover.steps.find(
      (s) => s.name === "Upload only missing immutable R2 objects",
    );
    const result = f.run("bash", ["-c", upload.run], {
      VERSION: "3.1.23",
      BUCKET: "test",
      R2_ACCOUNT_ID: "test",
      ...(mismatch ? { DIFFERING_GITHUB_ASSET: "3.1.23.tgz.sig" } : {}),
    });
    if (mismatch) {
      assert.notEqual(result.status, 0);
      assert.equal(f.calls(), "");
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(f.calls().trim().split("\n").length, 4);
      assert.ok(
        f
          .calls()
          .trim()
          .split("\n")
          .every((line) => line.startsWith("r2 put protocol/3.1.23.tgz")),
      );
    }
  });
}
