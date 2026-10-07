// Real disposable Git histories; GitHub and signature verification are local mocks.
// No network or production authority is used. Helpers are copied from this branch.
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
const steps = release.jobs.release.steps;
const step = (name) => steps.find((s) => s.name === name);
const version = "3.0.28";
const rowsPath = "test-vectors/reporting-reconciliation/rows.jsonl";
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

function fixture(t, fixtureVersion = version, includeReleaseHistory = false) {
  const version = fixtureVersion;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maintenance-3-0-publication-"));
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
  write(`dist/protocol/${version}.tgz.sha256`, `${require("node:crypto").createHash("sha256").update("signed").digest("hex")}  ${version}.tgz\n`);
  if (includeReleaseHistory) {
    for (const historical of [
      "3.0.25",
      "3.0.26",
      ...[0, 1, 2, 3].map((rc) => `3.2.0-rc.${rc}`),
    ]) {
      write(`dist/schemas/${historical}/index.json`, '{"release":true}');
      write(
        `dist/compliance/${historical}/${rowsPath}`,
        '{"immutable":true}\n',
      );
      for (const suffix of ["", ".sha256", ".sig", ".crt"])
        write(`dist/protocol/${historical}.tgz${suffix}`, `signed${suffix}`);
    }
    write(`dist/compliance/latest/${rowsPath}`, '{"development":true}\n');
  }
  write("dist/protocol/latest.tgz", "development");
  for (const script of ["check-release-state.cjs", "check-release-supersession.cjs"])
    write(
      `scripts/${script}`,
      fs.readFileSync(path.join(root, "scripts", script)),
    );
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("commit", "--allow-empty", "-qm", "Prior maintained source");
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
  write("permission-calls", "");
  write(
    "release.json",
    JSON.stringify({
      id: 100,
      tag_name: `v${version}`,
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
  const common = `const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);const read=f=>fs.readFileSync(f,'utf8');const log=s=>fs.appendFileSync(path.join(__dirname,'..','calls'),s+'\\n');const change=()=>fs.writeFileSync('remote',process.env.ADVANCE_TO||'f'.repeat(40));`;
  executable(
    "git",
    common +
      `
    if(process.env.ORIGINAL_TREE_ENUMERATION_ERROR && (args[0]==='ls-files'||(args[0]==='ls-tree'&&args.includes('--name-only')))) process.exit(1);
    if(args[0]==='ls-remote') {
      if(process.env.REMOTE_ERROR) process.exit(1);
      if(process.env.REMOVE_SCHEMA_AFTER_PREFLIGHT && fs.readFileSync('/proc/'+process.ppid+'/cmdline','utf8').includes('committed')) {
        const counter='committed-remote-count',count=(fs.existsSync(counter)?Number(read(counter)):0)+1;fs.writeFileSync(counter,String(count));
        if(count===4) fs.rmSync('dist/schemas/${version}',{recursive:true});
      }
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
      const output=value=>console.log(JSON.stringify(args.includes('--slurp')?[value]:value));
      if(url.split('?')[0].endsWith('/releases')) {
        if(process.env.RELEASE_LOOKUP_ERROR) {console.error(process.env.RELEASE_LOOKUP_ERROR);process.exit(1);}
        if(process.env.RELEASE_LOOKUP_RESPONSE) console.log(process.env.RELEASE_LOOKUP_RESPONSE);
        else output(fs.existsSync('release.json')?[release()]:[]);
      }
      else if(url.includes('/commits/')) { if(process.env.PULLS_ERROR) process.exit(1); output(JSON.parse(process.env.ASSOCIATED_PRS||'[{"number":1,"merged_at":"2026-09-14","base":{"ref":"3.0.x"}}]')); }
      else if(url.endsWith('/reviews')) {
        const reviews=JSON.parse(process.env.REVIEWS||'[]');
        if(fs.existsSync('staging-revocation') && ['DISMISSED','CHANGES_REQUESTED'].includes(read('staging-revocation'))) {
          reviews.push({...reviews[0],id:2,state:read('staging-revocation'),submitted_at:'2026-09-15'});
        }
        output(reviews);
      }
      else if(url.includes('/collaborators/')) {
        fs.appendFileSync('permission-calls',url+'\\n');
        if(process.env.PERMISSION_ERROR && (!process.env.PERMISSION_ERROR_LOGIN || url.includes('/'+process.env.PERMISSION_ERROR_LOGIN+'/'))) {console.error(process.env.PERMISSION_ERROR);process.exit(1);}
        const permissionRevoked=fs.existsSync('staging-revocation')&&read('staging-revocation')==='permission';
        console.log(permissionRevoked ? JSON.stringify({permission:'read',role_name:'read',user:{id:123,login:'reviewer',type:'User'}}) : process.env.PERMISSION_RESPONSE||JSON.stringify({permission:'write',role_name:'write',user:{id:123,login:'reviewer',type:'User'}}));
        if(process.env.ADVANCE_PERMISSION) change();
      } else output(JSON.parse(process.env.MERGED_PR||JSON.stringify({number:1,head:{sha:process.env.RELEASE_SHA},merged:true,merge_commit_sha:process.env.RELEASE_SHA,base:{ref:'3.0.x',repo:{full_name:'adcontextprotocol/adcp'}},user:{id:456,login:'author',type:'User'}})));
    } else if(args[1]==='view') {
      if(process.env.RELEASE_LOOKUP_ERROR&&!args.includes('--json')) {console.error(process.env.RELEASE_LOOKUP_ERROR);process.exit(1);}
      if(!fs.existsSync('release.json')) process.exit(1);
      const r=release();
      if(args.includes('--jq')) {
        const q=args[args.indexOf('--jq')+1];if(q==='.assets[].name') console.log(r.assets.map(a=>a.name).join('\\n'));else {const name=q.match(/name == "([^"]+)"/)[1];console.log(r.assets.find(a=>a.name===name)?.name||'');}
      } else console.log(JSON.stringify(r));
    } else if(args[1]==='create') {
      log('github draft'); save({id:100,tag_name:args[2],tagName:args[2],targetCommitish:process.env.RELEASE_SHA,isDraft:true,isPrerelease:args.includes('--prerelease'),isLatest:!args.includes('--latest=false'),assets:[]});
    } else if(args[1]==='upload') {
      const r=release();
      const files=args.slice(3).filter(arg=>!arg.startsWith('--'));
      for(const file of files) {
        if(!fs.existsSync(file)) throw Error('uploaded source absent');
        const name=path.basename(file), prior=r.assets.findIndex(asset=>asset.name===name);
        if(prior>=0&&!args.includes('--clobber')) throw Error('immutable duplicate upload');
        if(prior>=0) r.assets.splice(prior,1);
        r.assets.push({name,corrupt:process.env.CORRUPT_NEW_UPLOAD===name});
        log('github upload '+name+(r.isDraft?'':' publicly-visible')+(args.includes('--clobber')?' clobber':''));
      }
      save(r);
      if(process.env.ADVANCE_GITHUB) change();
    } else if(args[1]==='download') {
      const name=args[args.indexOf('--pattern')+1],dir=args[args.indexOf('--dir')+1];
      fs.copyFileSync('dist/protocol/'+name,path.join(dir,name));
      if(process.env.DIFFERING_GITHUB_ASSET===name||release().assets.find(a=>a.name===name)?.corrupt) fs.appendFileSync(path.join(dir,name),'different');
      if(process.env.ADVANCE_DOWNLOAD) change();
      if(process.env.MUTATE_LOCAL_DURING_DOWNLOAD && name.endsWith('.crt')) fs.appendFileSync('dist/protocol/${version}.tgz.sig','modified-after-readback');
      if(process.env.REVOKE_DURING_STAGING && name.endsWith('.crt')) fs.writeFileSync('staging-revocation',process.env.REVOKE_DURING_STAGING);
    } else if(args[1]==='edit') {
      const r=release();if(r.assets.length!==4) throw Error('incomplete release');r.isDraft=false;r.isLatest=!args.includes('--latest=false');save(r);fs.writeFileSync('tag',process.env.RELEASE_SHA);log('github publish');
    } else throw Error('unexpected gh '+args);
  `,
  );
  executable("shasum", common + `
    if(args.join(' ').slice(0,9)!=='-a 256 -c') throw Error('unexpected checksum command');
    const manifest=read(args[3]).trim(),match=manifest.match(/^([a-f0-9]{64})  (.+)$/);
    if(!match||require('node:crypto').createHash('sha256').update(fs.readFileSync(match[2])).digest('hex')!==match[1]) process.exit(1);
  `);
  executable("cosign", common + `
    if(args[0]==='sign-blob') {
      fs.writeFileSync(args[args.indexOf('--output-signature')+1],'publisher-regenerated-signature');
      fs.writeFileSync(args[args.indexOf('--output-certificate')+1],'-----BEGIN CERTIFICATE-----\\nfixture\\n-----END CERTIFICATE-----\\n');
      log('signature sign');process.exit(0);
    }
    if(args[0]!=='verify-blob'||args.includes('--certificate-identity-regexp')) throw Error('unexpected verification policy');
    if(args[args.indexOf('--certificate-identity')+1]!=='https://github.com/adcontextprotocol/adcp/.github/workflows/release.yml@refs/heads/3.0.x') throw Error('wrong workflow identity');
    const producer=require('node:child_process').execFileSync(${JSON.stringify(realGit)},['rev-parse',process.env.RELEASE_SHA+'^1'],{encoding:'utf8'}).trim();
    const claims={sha:process.env.CERT_WORKFLOW_SHA||producer,ref:process.env.CERT_WORKFLOW_REF||'refs/heads/3.0.x',repository:process.env.CERT_WORKFLOW_REPOSITORY||'adcontextprotocol/adcp',trigger:process.env.CERT_WORKFLOW_TRIGGER||'push'};
    const requested={};
    for(const field of Object.keys(claims)) {
      const flag='--certificate-github-workflow-'+field,index=args.indexOf(flag);
      if(index>=0) {
        requested[field]=args[index+1];
        if(requested[field]!==claims[field]) {console.error('certificate workflow '+field+' mismatch');process.exit(1);}
      }
    }
    fs.writeFileSync(path.join(__dirname,'..','certificate-policy.json'),JSON.stringify({claims,requested}));
    if(process.env.COSIGN_ERROR) process.exit(1);
    log('signature verify');
  `);
  executable("npm", common + `if(process.env.ADVANCE_BUILD) change();`);
  for (const forbidden of ['aws', 'curl', 'wrangler']) executable(forbidden, common + `log('forbidden network '+args.join(' '));process.exit(91);`);
  write('private-temp/.keep', '');
  const env = {
    TMPDIR: path.join(dir,'private-temp'),
    PATH: `${dir}/bin:${process.env.PATH}`,
    TESTED_SHA: head,
    GITHUB_SHA: head,
    PUBLICATION_BRANCH: "3.0.x",
    GITHUB_REF_NAME: "3.0.x",
    GITHUB_REPOSITORY: "adcontextprotocol/adcp",
    CHANGESETS_PUBLISHED: 'true',
    RELEASE_SHA: source,
    RUNNER_TEMP: path.join(dir, "temp"),
    GITHUB_PATH: path.join(dir, "github-path"),
  };
  const run = (command, args, extra = {}) =>
    spawnSync(
      command,
      command === "bash" ? ["--noprofile", "--norc", ...args] : args,
      { cwd: dir, env: { ...env, ...extra }, encoding: "utf8", timeout: 20000 },
    );
  const script = (mode, extra) =>
    run("node", ["scripts/check-release-state.cjs", mode], extra);
  return {
    dir,
    source,
    head,
    write,
    git,
    run,
    script,
    calls: () => fs.readFileSync(path.join(dir, "calls"), "utf8"),
  };
}
const approval = (head, extra = {}) =>
  JSON.stringify([
    {
      id: 1,
      user: { id: 123, type: "User", login: "reviewer" },
      state: "APPROVED",
      commit_id: head,
      submitted_at: "2026-09-14",
      ...extra,
    },
  ]);


// A real two-parent release merge: first parent is the exact generation base,
// second parent is the final reviewed generated head; both trees are identical.
function mergedFixture(t) {
  const f = fixture(t, version, true);
  const merged = f.git('commit-tree', `${f.source}^{tree}`, '-p', `${f.source}^`, '-p', f.source, '-m', 'Merge reviewed 3.0 release');
  f.git('checkout', '--detach', merged);
  f.write('remote', merged);
  f.write('tag', merged);
  const release = JSON.parse(fs.readFileSync(path.join(f.dir, 'release.json')));
  release.targetCommitish = merged;
  f.write('release.json', JSON.stringify(release));
  const authority = {
    TESTED_SHA: merged,
    GITHUB_SHA: merged,
    RELEASE_SHA: merged,
    GITHUB_OUTPUT: path.join(f.dir, 'outputs'),
    REVIEWS: approval(f.source),
    MERGED_PR: JSON.stringify({
      number: 1, head: { sha: f.source }, merged: true, merge_commit_sha: merged,
      base: { ref: '3.0.x', repo: { full_name: 'adcontextprotocol/adcp' } },
      user: { id: 456, login: 'release-bot[bot]', type: 'Bot' },
    }),
  };
  const execute = (names, extra = {}) => {
    let stdout = '', stderr = '';
    for (const name of names) {
      const selected = step(name);
      assert.ok(selected?.run, `Missing executable step ${name}`);
      const result = f.run('bash', ['-c', 'set -euo pipefail\n' + selected.run.replaceAll('${{ steps.release-artifacts.outputs.version }}', version)], { ...authority, ...extra });
      stdout += result.stdout || '';
      stderr += result.stderr || '';
      if (result.status !== 0) return { ...result, stdout, stderr };
    }
    return { status: 0, stdout, stderr };
  };
  return {
    ...f, merged, authority, execute,
    // Execute the real workflow's available publication steps in order. The
    // separate structural contract requires all four guarded steps in the
    // final workflow. The original6006 workflow has only the shared upload
    // step: this lets identical byte/overwrite controls witness its behavior,
    // rather than failing merely because a newly named guard did not exist.
    publish: (extra = {}) => execute([
      'Require human approval for committed release artifacts',
      'Require committed signed protocol tarball',
      'Verify local protocol tarball before publication',
      'Upload protocol tarball to GitHub Release',
    ].filter(name => step(name)?.run), extra),
  };
}

function absentRelease(f) {
  f.write('tag', '');
  fs.unlinkSync(path.join(f.dir, 'release.json'));
}

function successful(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
}

function refused(result, expression) {
  assert.equal(result.error, undefined, 'test timed out or failed to spawn');
  assert.notEqual(result.status, 0, 'publication must refuse');
  if (expression) assert.match(result.stdout + result.stderr, expression);
}

for (const [claim,value] of [
  ['SHA','f'.repeat(40)],
  ['REF','refs/heads/main'],
  ['REPOSITORY','untrusted/example'],
  ['TRIGGER','workflow_dispatch'],
]) {
  test(`certificate with wrong producer ${claim} refuses before any GitHub release mutation`, t => {
    const f = mergedFixture(t);
    absentRelease(f);
    refused(f.publish({['CERT_WORKFLOW_'+claim]:value}), /certificate workflow .* mismatch/);
    assert.equal(f.calls(), '', 'valid tuple bytes cannot replace the expected producer certificate claims');
    assert.equal(fs.existsSync(path.join(f.dir,'release.json')), false);
  });
}

test('certificate producer binding uses the original release parent after a later helper-only commit', t => {
  const f = mergedFixture(t);
  const producer = f.git('rev-parse', `${f.merged}^1`);
  f.write('helper-only.md', 'Current tested helper change; release assets remain unchanged.');
  f.git('add', 'helper-only.md');
  f.git('commit', '-qm', 'Later tested helper');
  const tested = f.git('rev-parse', 'HEAD');
  f.write('remote', tested);
  absentRelease(f);
  successful(f.publish({TESTED_SHA:tested,GITHUB_SHA:tested}));
  assert.notEqual(f.git('rev-parse', `${tested}^1`), producer);
  const policy = JSON.parse(fs.readFileSync(path.join(f.dir,'certificate-policy.json'),'utf8'));
  assert.deepEqual(policy.requested, {sha:producer,ref:'refs/heads/3.0.x',repository:'adcontextprotocol/adcp',trigger:'push'});
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'release.json'))).targetCommitish, f.merged);
});

test('normal two-parent merge discovers the release using its first-parent diff', t => {
  const f = mergedFixture(t);
  // Git's combined diff hides all generated paths because the second parent's
  // tree is identical. Execute the workflow, not an approximation of its grep.
  assert.equal(f.git('show', '--format=', '--name-only', '--no-renames', f.merged), '');
  successful(f.execute(['Detect release-relevant push', 'Detect committed release artifacts']));
  const output = fs.readFileSync(path.join(f.dir, 'outputs'), 'utf8');
  assert.match(output, /relevant=true/);
  assert.match(output, /has_release_artifacts=true/);
  assert.equal(f.calls(), '');
});

test('approved exact merge stages four byte-identical assets before public GitHub release', t => {
  const f = mergedFixture(t);
  absentRelease(f);
  successful(f.publish());
  const calls = f.calls().trim().split('\n');
  assert.equal(calls[0], 'signature verify');
  assert.equal(calls[1], 'github draft');
  assert.equal(calls.filter(line => line.startsWith('github upload ')).length, 4);
  assert.equal(calls[6], 'github publish');
  assert.equal(calls.length, 7, 'publication is limited to this four-asset GitHub tuple');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'release.json'))).targetCommitish, f.merged);
});

for (const [name, extra] of [
  ['no review', { REVIEWS: '[]' }],
  ['stale head review', { REVIEWS: approval('b'.repeat(40)) }],
  ['bot review', { REVIEWS: approval('HEAD', { user: { id: 123, login: 'reviewer', type: 'Bot' } }) }],
  ['author review', { REVIEWS: approval('HEAD', { user: { id: 456, login: 'release-bot[bot]', type: 'User' } }) }],
  ['dismissed review', { REVIEWS: approval('HEAD', { state: 'DISMISSED' }) }],
  ['read-only reviewer', { PERMISSION_RESPONSE: JSON.stringify({permission:'read',role_name:'read',user:{id:123,login:'reviewer',type:'User'}}) }],
  ['permission API failure', { PERMISSION_ERROR: 'HTTP 403 Forbidden' }],
  ['current branch drift', { REMOTE_ERROR: '1' }],
  ['branch advances during permission lookup', { ADVANCE_PERMISSION: '1' }],
]) test(`${name} refuses before signature, tag or release mutation`, t => {
  const f = mergedFixture(t);
  absentRelease(f);
  const overridden = { ...extra };
  if (overridden.REVIEWS) overridden.REVIEWS = overridden.REVIEWS.replaceAll('HEAD', f.source);
  refused(f.publish(overridden));
  assert.equal(f.calls(), '');
});

for (const [permission, role_name] of [['write','write'], ['write','maintain'], ['admin','admin']]) {
  test(`current non-author ${role_name} permission qualifies exact final-head approval`, t => {
    const f = mergedFixture(t);
    successful(f.execute(['Require human approval for committed release artifacts'], {
      PERMISSION_RESPONSE: JSON.stringify({permission,role_name,user:{id:123,login:'reviewer',type:'User'}}),
    }));
    assert.equal(f.calls(), '');
  });
}

for (const kind of ['stale generation base', 'changed merge tree', 'multi-parent generated head']) {
  test(`${kind} remains quarantined despite genuine human final-head approval`, t => {
    const f = mergedFixture(t);
    let generated = f.source;
    let merged;
    if (kind === 'stale generation base') {
      merged = f.git('commit-tree', `${f.source}^{tree}`, '-p', f.head, '-p', f.source, '-m', 'Merge stale generated head');
    } else if (kind === 'changed merge tree') {
      merged = f.git('commit-tree', `${f.head}^{tree}`, '-p', `${f.source}^`, '-p', f.source, '-m', 'Change reviewed tree during merge');
    } else {
      generated = f.git('commit-tree', `${f.source}^{tree}`, '-p', `${f.source}^`, '-p', f.source, '-m', 'Update old generated head by merge');
      merged = f.git('commit-tree', `${f.source}^{tree}`, '-p', `${f.source}^`, '-p', generated, '-m', 'Merge non-fresh generated head');
    }
    f.git('checkout', '--detach', merged);
    f.write('remote', merged);
    absentRelease(f);
    const pr = JSON.parse(f.authority.MERGED_PR);
    pr.head.sha = generated;
    pr.merge_commit_sha = merged;
    refused(f.publish({TESTED_SHA:merged,GITHUB_SHA:merged,RELEASE_SHA:merged,MERGED_PR:JSON.stringify(pr),REVIEWS:approval(generated)}), /Quarantined release/);
    assert.equal(f.calls(), '');
  });
}

for (const suffix of ['', '.sha256', '.sig', '.crt']) {
  test(`missing committed ${suffix || 'tarball'} refuses without rebuilding or signing`, t => {
    const f = mergedFixture(t);
    absentRelease(f);
    fs.unlinkSync(path.join(f.dir, `dist/protocol/${version}.tgz${suffix}`));
    refused(f.publish());
    assert.equal(f.calls(), '');
  });
}

test('signature verification failure prevents all publication', t => {
  const f = mergedFixture(t);
  absentRelease(f);
  refused(f.publish({COSIGN_ERROR:'1'}));
  assert.equal(f.calls(), '');
});

test('GitHub staging drift leaves only an incomplete draft and never proceeds to R2', t => {
  const f = mergedFixture(t);
  absentRelease(f);
  refused(f.publish({ADVANCE_GITHUB:'1'}));
  const draft = JSON.parse(fs.readFileSync(path.join(f.dir, 'release.json')));
  assert.equal(draft.isDraft, true);
  assert.equal(draft.assets.length, 1);
  assert.doesNotMatch(f.calls(), /github publish/);
});

for (const kind of ['complete', 'missing tuple', 'different bytes', 'extra asset', 'wrong tag']) {
  test(`existing published release ${kind} cannot be modified`, t => {
    const f = mergedFixture(t);
    const release = JSON.parse(fs.readFileSync(path.join(f.dir, 'release.json')));
    if (kind === 'missing tuple') release.assets.pop();
    if (kind === 'extra asset') release.assets.push({name:'unreviewed.txt'});
    if (kind === 'wrong tag') f.write('tag', f.source);
    f.write('release.json', JSON.stringify(release));
    const result = f.execute(['Upload protocol tarball to GitHub Release'], kind === 'different bytes' ? {DIFFERING_GITHUB_ASSET:`${version}.tgz.sig`} : {});
    if (kind === 'complete') successful(result); else refused(result);
    assert.equal(f.calls(), '');
  });
}

test('existing draft conflicting asset bytes refuse overwrite and retain the draft', t => {
  const f = mergedFixture(t);
  const release = JSON.parse(fs.readFileSync(path.join(f.dir, 'release.json')));
  release.isDraft = true;
  f.write('release.json', JSON.stringify(release));
  refused(f.execute(['Upload protocol tarball to GitHub Release'], {DIFFERING_GITHUB_ASSET:`${version}.tgz.crt`}), /differs/);
  assert.equal(f.calls(), '');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'release.json'))).isDraft, true);
});

test('later unrelated push refuses an uncompleted committed version without repairing history', t => {
  const f = fixture(t, version, true);
  fs.unlinkSync(path.join(f.dir, 'release.json'));
  const result = f.run('bash', ['-c', 'set -euo pipefail\n' + step('Detect stranded committed release').run]);
  refused(result);
  assert.equal(f.calls(), '');
});

test('reviewed supersession marker executes its dependency and cannot bypass a stable pending release', t => {
  const f = fixture(t);
  f.write('.changeset/release-supersession.json', JSON.stringify({version}));
  refused(f.script('pending'), /release-supersession|candidate|RC|rc/i);
  assert.equal(f.calls(), '');
});

test('maintained 3.0 preserves Node22 and original action pins without adding CDN authority', () => {
  assert.equal(step('Setup Node.js').with['node-version'], '22');
  assert.equal(step('Checkout Repo').uses, 'actions/checkout@v6');
  assert.equal(step('Mint AAO Release Bot installation token').uses, 'actions/create-github-app-token@v3');
  assert.equal(release.env.TESTED_SHA, '${{ github.sha }}');
  assert.equal(release.env.RELEASE_SHA, '${{ github.sha }}');
  assert.equal(release.env.PUBLICATION_BRANCH, '${{ github.ref_name }}');
  assert.equal(release.concurrency, '${{ github.workflow }}-${{ github.ref }}');
  const generation = step('Create Release Pull Request');
  assert.equal(generation.uses, 'changesets/action@v1');
  assert.equal(generation.with.publish, undefined);
  assert.equal(generation.with.createGithubReleases, false);
  assert.ok(steps.indexOf(step('Require current branch before Changesets generation')) < steps.indexOf(generation));
  assert.ok(steps.indexOf(step('Recheck current branch after Changesets generation')) > steps.indexOf(generation));
  for (const name of ['Detect release-relevant push','Detect committed release artifacts','Detect stranded committed release']) {
    assert.match(step(name).run, /git show --first-parent/);
  }
  const publication = step('Upload protocol tarball to GitHub Release');
  for (const name of ['Require human approval for committed release artifacts','Require committed signed protocol tarball','Verify local protocol tarball before publication']) assert.ok(step(name)?.run, `Missing required guard ${name}`);
  assert.ok(steps.indexOf(step('Require human approval for committed release artifacts')) < steps.indexOf(publication));
  assert.ok(steps.indexOf(step('Verify local protocol tarball before publication')) < steps.indexOf(publication));
  assert.equal(publication.if, "steps.release-artifacts.outputs.has_release_artifacts == 'true'");
  assert.doesNotMatch(JSON.stringify(release), /sign:protocol-tarball|changeset tag|steps\.changesets\.outputs\.published|R2|AWS_ACCESS|backfill:cdn|--clobber/);
  assert.equal(step('Verify current storyboard coverage'), undefined, 'no unrelated newer storyboard runner is copied');
  assert.equal(step('Verify 3.0 storyboard compatibility'), undefined);
});

for (const suffix of ['', '.sha256', '.sig', '.crt']) {
  test(`corrupt newly uploaded ${suffix || 'tarball'} stays draft despite four correct asset names`, t => {
    const f = mergedFixture(t);
    absentRelease(f);
    refused(f.publish({CORRUPT_NEW_UPLOAD:`${version}.tgz${suffix}`}));
    const draft = JSON.parse(fs.readFileSync(path.join(f.dir, 'release.json')));
    assert.equal(draft.assets.length, 4, 'all names exist but cannot substitute for byte verification');
    assert.equal(draft.isDraft, true, 'corrupt newly uploaded bytes must never become public');
    assert.doesNotMatch(f.calls(), /github publish/);
  });
}

test('branch advancement during draft byte verification prevents public edit', t => {
  const f = mergedFixture(t);
  absentRelease(f);
  refused(f.publish({ADVANCE_DOWNLOAD:'1'}), /stale tested SHA/);
  const draft = JSON.parse(fs.readFileSync(path.join(f.dir, 'release.json')));
  assert.equal(draft.assets.length, 4);
  assert.equal(draft.isDraft, true);
  assert.doesNotMatch(f.calls(), /github publish/);
});

for (const state of ['DISMISSED','CHANGES_REQUESTED','permission']) {
  test(`approval ${state} during all-four staging refuses the public edit`, t => {
    const f = mergedFixture(t);
    absentRelease(f);
    refused(f.publish({REVOKE_DURING_STAGING:state}), /no current write\/maintain\/admin non-author approval/);
    assert.equal(fs.readFileSync(path.join(f.dir,'staging-revocation'),'utf8'), state, 'the control must revoke authority only after staging');
    const draft = JSON.parse(fs.readFileSync(path.join(f.dir,'release.json')));
    assert.equal(draft.assets.length, 4, 'all four approved assets must have been staged');
    assert.equal(draft.isDraft, true, 'revoked publication authority must leave the complete tuple draft');
    assert.doesNotMatch(f.calls(), /github publish|forbidden network/);
  });
}

for (const kind of ['signed tuple substitution','executable mode','untracked schema','ignored compliance','symlink file','symlink directory','missing compliance','local package version','wrong checkout']) {
  test(`committed preflight rejects ${kind} before any release mutation`, t => {
    const f = mergedFixture(t);
    absentRelease(f);
    const schema = `dist/schemas/${version}/index.json`;
    if (kind === 'signed tuple substitution') f.write(`dist/protocol/${version}.tgz.sig`, 'otherwise valid substituted signature');
    if (kind === 'executable mode') {
      f.git('config', 'core.fileMode', 'false');
      fs.chmodSync(path.join(f.dir, schema), 0o755);
    }
    if (kind === 'untracked schema') f.write(`dist/schemas/${version}/injected.json`, '{}');
    if (kind === 'ignored compliance') {
      f.write('.git/info/exclude', `dist/compliance/${version}/ignored.yaml\n`);
      f.write(`dist/compliance/${version}/ignored.yaml`, 'injected: true');
    }
    if (kind === 'symlink file') {
      f.write('outside.json', '{"release":true}');
      fs.unlinkSync(path.join(f.dir, schema));
      fs.symlinkSync(path.join(f.dir, 'outside.json'), path.join(f.dir, schema));
    }
    if (kind === 'symlink directory') {
      f.write('outside/index.json', '{"release":true}');
      fs.rmSync(path.join(f.dir, `dist/schemas/${version}`), {recursive:true});
      fs.symlinkSync(path.join(f.dir, 'outside'), path.join(f.dir, `dist/schemas/${version}`));
    }
    if (kind === 'missing compliance') fs.unlinkSync(path.join(f.dir, `dist/compliance/${version}/index.json`));
    if (kind === 'local package version') f.write('package.json', JSON.stringify({version:'3.0.29'}));
    if (kind === 'wrong checkout') f.git('checkout', '--detach', f.head);
    refused(f.publish());
    assert.equal(f.calls(), '', 'authority must be checked before signature or release mutation');
  });
}

test('a final-head approval remains valid after a COMMENTED review from the same maintainer', t => {
  const f = mergedFixture(t);
  const approved = JSON.parse(approval(f.source))[0];
  const comment = {...approved,id:2,state:'COMMENTED',submitted_at:'2026-09-15'};
  successful(f.execute(['Require human approval for committed release artifacts'], {REVIEWS:JSON.stringify([approved,comment])}));
  assert.match(fs.readFileSync(path.join(f.dir,'permission-calls'),'utf8'), /reviewer\/permission/);
  assert.equal(f.calls(), '');
});

for (const state of ['CHANGES_REQUESTED','DISMISSED','UNKNOWN']) {
  test(`a later ${state} review cannot preserve an earlier approval`, t => {
    const f = mergedFixture(t);
    const approved = JSON.parse(approval(f.source))[0];
    const revocation = {...approved,id:2,state,submitted_at:'2026-09-15'};
    refused(f.publish({REVIEWS:JSON.stringify([approved,revocation])}));
    assert.equal(f.calls(), '');
  });
}

test('maintained publication never advances the GitHub Latest alias', t => {
  const f = mergedFixture(t);
  absentRelease(f);
  successful(f.publish());
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'release.json'))).isLatest, false);
});

test('local tuple mutation during draft readback is rechecked against the original commit before public edit', t => {
  const f = mergedFixture(t);
  absentRelease(f);
  refused(f.publish({MUTATE_LOCAL_DURING_DOWNLOAD:'1'}), /original commit/);
  const draft = JSON.parse(fs.readFileSync(path.join(f.dir,'release.json')));
  assert.equal(draft.assets.length, 4);
  assert.equal(draft.isDraft, true);
  assert.doesNotMatch(f.calls(), /github publish/);
});

test('COMMENTED cannot upgrade a stale-head approval to the current generated head', t => {
  const f = mergedFixture(t);
  const approved = JSON.parse(approval('b'.repeat(40)))[0];
  const comment = {...approved,id:2,state:'COMMENTED',commit_id:f.source,submitted_at:'2026-09-15'};
  refused(f.publish({REVIEWS:JSON.stringify([approved,comment])}));
  assert.equal(f.calls(), '');
});

for (const state of ['CHANGES_REQUESTED','DISMISSED','UNKNOWN']) {
  test(`COMMENTED cannot undo a previous ${state} decision`, t => {
    const f = mergedFixture(t);
    const approved = JSON.parse(approval(f.source))[0];
    const negative = {...approved,id:2,state,submitted_at:'2026-09-15'};
    const comment = {...approved,id:3,state:'COMMENTED',submitted_at:'2026-09-16'};
    refused(f.publish({REVIEWS:JSON.stringify([approved,negative,comment])}));
    assert.equal(f.calls(), '');
  });
}

test('current tested committed version cannot be disguised by locally reverting package.json', t => {
  const f = mergedFixture(t);
  absentRelease(f);
  f.write('package.json', JSON.stringify({version:'3.0.29'}));
  f.git('add','package.json');
  f.git('commit','-qm','Next current version');
  const advanced = f.git('rev-parse','HEAD');
  f.write('remote', advanced);
  f.write('package.json', JSON.stringify({version}));
  refused(f.publish({TESTED_SHA:advanced,GITHUB_SHA:advanced}));
  assert.equal(f.calls(), '', 'local reversion cannot revive historical publication authority');
});

for (const ancestor of ['dist','dist/schemas','dist/compliance','dist/protocol']) {
  test(`symlinked ${ancestor} ancestor refuses even when every leaf byte matches`, t => {
    const f = mergedFixture(t);
    absentRelease(f);
    const external = path.join(f.dir,'external-tree');
    fs.renameSync(path.join(f.dir,ancestor), external);
    fs.symlinkSync(external,path.join(f.dir,ancestor));
    refused(f.publish());
    assert.equal(f.calls(), '', 'all publication ancestors must be real directories');
  });
}

for (const surface of [
  `dist/schemas/${version}/index.json`, `dist/compliance/${version}/index.json`,
  ...['','.sha256','.sig','.crt'].map(suffix=>`dist/protocol/${version}.tgz${suffix}`),
]) {
  test(`current tested artifact ${surface} cannot be disguised by restoring original local bytes`, t => {
    const f = mergedFixture(t);
    const original = fs.readFileSync(path.join(f.dir,surface));
    f.write(surface, Buffer.concat([original,Buffer.from('new-tested-content')]));
    f.git('add',surface);
    f.git('commit','-qm','Current tested artifact changes without a version bump');
    const advanced = f.git('rev-parse','HEAD');
    f.write('remote', advanced);
    f.write(surface, original);
    refused(f.execute(['Require human approval for committed release artifacts'],{TESTED_SHA:advanced,GITHUB_SHA:advanced}));
    assert.equal(f.calls(), '', 'all six original artifact surfaces must equal the current tested tree');
  });
}

for (const error of ['transport 500','permission 403','rate limit 429']) {
  test(`release inventory ${error} is not evidence of absence and cannot create a duplicate draft`, t => {
    const f = mergedFixture(t);
    refused(f.publish({RELEASE_LOOKUP_ERROR:error}));
    assert.doesNotMatch(f.calls(), /github/, 'failed inventory lookup cannot mutate release state');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'release.json'))).isDraft,false);
  });
}

for (const kind of ['invalid JSON','invalid page shape','invalid identity','ambiguous matching drafts']) {
  test(`release inventory ${kind} refuses before any release mutation`, t => {
    const f = mergedFixture(t);
    const record=JSON.parse(fs.readFileSync(path.join(f.dir,'release.json')));
    const response=kind==='invalid JSON'?'not-json':kind==='invalid page shape'?JSON.stringify({releases:[]}):kind==='invalid identity'?JSON.stringify([[{...record,id:'unknown'}]]):JSON.stringify([[record,{...record,id:101}]]);
    refused(f.publish({RELEASE_LOOKUP_RESPONSE:response}));
    assert.doesNotMatch(f.calls(), /github/);
  });
}

// Deterministic leaf races use a child-process preload, not timing or a real
// concurrent attacker. Git/GitHub tools and ancestor paths remain trusted.
function publicationReadRace(f, target, stage, replacement) {
  const bytes = fs.readFileSync(path.join(f.dir, target));
  const replacementBytes = target === 'package.json' ? JSON.stringify({version: '9.9.9', unapprovedReplacement: true}) : 'unapproved replacement bytes';
  f.write('race-outside.bin', stage === 'after-open' ? Buffer.from(replacementBytes) : bytes);
  f.write('race-preload.cjs', `
    const fs = require('node:fs'), path = require('node:path');
    const target = path.resolve(${JSON.stringify(target)});
    const stage = ${JSON.stringify(stage)}, replacement = ${JSON.stringify(replacement)};
    const lstat = fs.lstatSync, open = fs.openSync, fstat = fs.fstatSync;
    const read = fs.readFileSync, close = fs.closeSync;
    let replaced = false, descriptor;
    const matches = file => typeof file === 'string' && path.resolve(file) === target;
    const record = fields => {
      const prior = fs.existsSync('race-proof.json') ? JSON.parse(read('race-proof.json', 'utf8')) : {};
      fs.writeFileSync('race-proof.json', JSON.stringify({...prior, ...fields}));
    };
    const replace = phase => {
      if (replaced) return;
      replaced = true;
      fs.unlinkSync(target);
      if (replacement === 'mode') {
        fs.writeFileSync(target, read('race-outside.bin'));
        fs.chmodSync(target, 0o755);
      } else fs.symlinkSync(path.resolve('race-outside.bin'), target);
      record({replaced: true, phase});
    };
    fs.lstatSync = function(file, ...args) {
      const metadata = lstat.call(this, file, ...args);
      if (matches(file) && stage === 'before-open') replace('after-lstat');
      return metadata;
    };
    fs.openSync = function(file, ...args) {
      if (matches(file) && stage === 'before-open') replace('before-open');
      const result = open.call(this, file, ...args);
      if (matches(file)) { descriptor = result; record({descriptor: result, flags: args[0]}); }
      return result;
    };
    fs.fstatSync = function(file, ...args) {
      const metadata = fstat.call(this, file, ...args);
      if (file === descriptor && stage === 'after-open') replace('after-fstat');
      return metadata;
    };
    fs.readFileSync = function(file, ...args) {
      if (file === descriptor && typeof file === 'number') record({readDescriptor: true});
      return read.call(this, file, ...args);
    };
    fs.closeSync = function(file, ...args) {
      const result = close.call(this, file, ...args);
      if (file === descriptor) record({closedDescriptor: true});
      return result;
    };
  `);
  return {
    env: { ...f.authority, NODE_OPTIONS: `--require=${path.join(f.dir, 'race-preload.cjs')}` },
    proof: () => JSON.parse(fs.readFileSync(path.join(f.dir, 'race-proof.json'), 'utf8')),
  };
}

for (const target of ['package.json', `dist/schemas/${version}/index.json`]) {
  test(`publication refuses symlink replacement of ${target} before descriptor open`, t => {
    const f = mergedFixture(t);
    const race = publicationReadRace(f, target, 'before-open', 'symlink');
    const result = f.run('node', ['scripts/check-release-state.cjs', 'committed', version], race.env);
    assert.equal(race.proof().replaced, true, 'control must replace the formerly regular leaf');
    refused(result, /ELOOP|symbolic link/);
    assert.equal(f.calls(), '', 'replacement must not reach signature or publication mutations');
  });
}

test('publication checks executable mode on the replacement inode before reading bytes', t => {
  const f = mergedFixture(t);
  const target = `dist/schemas/${version}/index.json`;
  const race = publicationReadRace(f, target, 'before-open', 'mode');
  const result = f.run('node', ['scripts/check-release-state.cjs', 'committed', version], race.env);
  assert.equal(race.proof().replaced, true);
  assert.equal(fs.statSync(path.join(f.dir, target)).mode & 0o111, 0o111, 'replacement mode must differ');
  refused(result, /Uncommitted publication file or mode/);
  assert.equal(race.proof().closedDescriptor, true, 'validation failure must close the opened descriptor');
  assert.equal(f.calls(), '');
});

for (const target of ['package.json', `dist/schemas/${version}/index.json`]) {
  test(`publication reads the validated ${target} inode after pathname replacement`, t => {
    const f = mergedFixture(t);
    const race = publicationReadRace(f, target, 'after-open', 'symlink');
    successful(f.run('node', ['scripts/check-release-state.cjs', 'committed', version], race.env));
    const proof = race.proof();
    assert.equal(proof.replaced, true, 'pathname must really change after descriptor metadata validation');
    assert.equal(proof.phase, 'after-fstat');
    assert.equal(proof.flags & fs.constants.O_NOFOLLOW, fs.constants.O_NOFOLLOW);
    assert.equal(proof.readDescriptor, true);
    assert.equal(proof.closedDescriptor, true);
    const substituted = fs.readFileSync(path.join(f.dir, target), 'utf8');
    if (target === 'package.json') assert.deepEqual(JSON.parse(substituted), {version: '9.9.9', unapprovedReplacement: true});
    else assert.equal(substituted, 'unapproved replacement bytes');
    assert.equal(f.calls(), '', 'this read-only preflight control grants no publication authority');
  });
}

// These common-publisher controls also execute unchanged against the original
// 6006 workflow in a private baseline copy; no new guard name is necessary.
test('publisher refuses a missing signature instead of regenerating it for a public release', t => {
  const f = mergedFixture(t);
  fs.unlinkSync(path.join(f.dir, `dist/protocol/${version}.tgz.sig`));
  refused(f.publish());
  assert.equal(f.calls(), '', 'missing committed tuple must refuse before signing or release mutation');
});

test('verified complete public GitHub release retry never uploads or clobbers assets', t => {
  const f = mergedFixture(t);
  successful(f.publish());
  assert.equal(f.calls(), 'signature verify\n', 'a public retry verifies authority and bytes without mutations');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'release.json'))).isDraft, false);
});

test('failed common-publisher release lookup cannot report successful publication', t => {
  const f = mergedFixture(t);
  refused(f.publish({ RELEASE_LOOKUP_ERROR: 'HTTP 403 Forbidden' }));
  assert.doesNotMatch(f.calls(), /github (draft|upload|publish)|signature sign|forbidden network/);
});
