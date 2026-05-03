#!/usr/bin/env node

/**
 * Build script for AdCP compliance artifacts (specialisms, protocol baselines,
 * universal compliance, test-kits).
 *
 * Mirrors scripts/build-schemas.cjs pattern:
 *
 * 1. Development build (default): `npm run build:compliance`
 *    - Rebuilds only dist/compliance/latest/ with current source YAMLs
 *    - Preserves existing released version directories
 *
 * 2. Release build: `npm run build:compliance -- --release`
 *    - Creates a new versioned directory (e.g., dist/compliance/3.1.0/)
 *    - Also updates latest/ to match the release
 *
 * Source of truth for specialism → protocol mapping is the `protocol:` field in
 * each specialisms/{id}/index.yaml. This build fails loudly if any specialism
 * is missing `protocol:` or if the filesystem layout drifts from
 * static/schemas/source/enums/specialism.json.
 *
 * Published paths:
 * - /compliance/latest/                           - Current development snapshot
 * - /compliance/{version}/                        - Released version (pin for production)
 * - /compliance/{version}/universal/              - Mandatory for every agent
 * - /compliance/{version}/protocols/{protocol}/   - Required to claim protocols
 * - /compliance/{version}/specialisms/{id}/       - Optional specialization claims
 * - /compliance/{version}/test-kits/              - Brand fixtures for runs
 * - /compliance/{version}/index.json              - Enumerates protocols + specialism IDs
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { execSync } = require('child_process');

const SOURCE_DIR = path.join(__dirname, '../static/compliance/source');
const DIST_DIR = path.join(__dirname, '../dist/compliance');
const PACKAGE_JSON = path.join(__dirname, '../package.json');
const SPECIALISM_ENUM = path.join(__dirname, '../static/schemas/source/enums/specialism.json');
const PROTOCOL_ENUM = path.join(__dirname, '../static/schemas/source/enums/adcp-protocol.json');
const SCHEMAS_DIR = path.join(__dirname, '../static/schemas/source');

const args = process.argv.slice(2);
const isRelease = args.includes('--release');

function getVersion() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  return pkg.version;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function copyTree(srcDir, dstDir) {
  ensureDir(dstDir);
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copyTree(src, dst);
    } else {
      fs.copyFileSync(src, dst);
    }
  }
}

function readYamlFrontmatter(filePath) {
  const doc = yaml.load(fs.readFileSync(filePath, 'utf8'));
  if (doc == null || typeof doc !== 'object') return {};
  const out = {};
  for (const key of ['id', 'protocol', 'title', 'role', 'track', 'status']) {
    if (doc[key] != null) out[key] = String(doc[key]).trim();
  }
  if (doc.required_tools != null) {
    if (!Array.isArray(doc.required_tools)) {
      throw new Error(
        `required_tools in ${filePath} must be a YAML list, got ${typeof doc.required_tools}`
      );
    }
    out.required_tools = doc.required_tools.map(t => String(t).trim()).filter(Boolean);
  }
  return out;
}

const VALID_STATUSES = new Set(['stable', 'preview', 'deprecated']);

function discoverSpecialisms(sourceDir) {
  const specialismsDir = path.join(sourceDir, 'specialisms');
  if (!fs.existsSync(specialismsDir)) return [];

  const items = [];
  for (const entry of fs.readdirSync(specialismsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const indexPath = path.join(specialismsDir, entry.name, 'index.yaml');
    if (!fs.existsSync(indexPath)) {
      throw new Error(`Specialism "${entry.name}" is missing index.yaml at ${indexPath}`);
    }
    const fm = readYamlFrontmatter(indexPath);
    if (!fm.protocol) {
      throw new Error(
        `Specialism "${entry.name}" has no 'protocol:' field in index.yaml. ` +
        `Every specialism must declare its parent protocol (media-buy, creative, signals, governance, brand, sponsored-intelligence).`
      );
    }
    const status = fm.status || 'stable';
    if (!VALID_STATUSES.has(status)) {
      throw new Error(
        `Specialism "${entry.name}" has invalid status "${status}". Valid values: ${[...VALID_STATUSES].join(', ')}.`
      );
    }
    const required_tools = fm.required_tools || [];
    if (status === 'stable' && required_tools.length === 0) {
      throw new Error(
        `Specialism "${entry.name}" has status: stable but no required_tools declared. ` +
        `Stable specialisms must list the tool families they exercise so /compliance/{version}/index.json ` +
        `surfaces discoverability. Add a required_tools list to ${indexPath} or mark the specialism as preview.`
      );
    }
    items.push({
      id: entry.name,
      protocol: fm.protocol,
      title: fm.title || null,
      status,
      required_tools,
      path: `specialisms/${entry.name}/`
    });
  }
  return items.sort((a, b) => a.id.localeCompare(b.id));
}

function discoverProtocols(sourceDir, specialisms) {
  const protocolsDir = path.join(sourceDir, 'protocols');
  const ids = new Set();

  if (fs.existsSync(protocolsDir)) {
    for (const entry of fs.readdirSync(protocolsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) ids.add(entry.name);
    }
  }
  for (const s of specialisms) {
    if (s.protocol) ids.add(s.protocol);
  }

  const items = [];
  for (const id of ids) {
    const indexPath = path.join(protocolsDir, id, 'index.yaml');
    const fm = fs.existsSync(indexPath) ? readYamlFrontmatter(indexPath) : {};
    items.push({
      id,
      title: fm.title || null,
      has_baseline: fs.existsSync(indexPath),
      path: `protocols/${id}/`
    });
  }
  return items.sort((a, b) => a.id.localeCompare(b.id));
}

// ── Idempotency lint ────────────────────────────────────────────────
//
// Every mutating request in AdCP (any task whose request schema lists
// `idempotency_key` in its top-level `required` array) MUST carry an
// idempotency_key. Normative anchors:
//   - docs/reference/migration/v3-readiness.mdx §"idempotency_key required
//     on all mutating requests"
//   - docs/reference/release-notes.mdx 3.0 entry, idempotency rollout
//   - adcontextprotocol/adcp#2315 (the PR that made it required)
// Storyboard sample_requests are spec artifacts — when they omit it, the
// published example is non-conforming even if the runner auto-injects at
// runtime. This lint reads the request schemas (source of truth) rather
// than hardcoding a task list, so new mutating tasks are covered on
// arrival. The one documented exception (si-terminate-session: naturally
// idempotent by session_id) carries a `$comment` on its request schema
// and is correctly absent from the required-key set.
//
// Divergence with `x-mutates-state`: the contradiction lint's cousin at
// `scripts/lint-storyboard-contradictions.cjs:loadMutatingTasksFromSchemas`
// reads `x-mutates-state: true` instead — that's the mutation-semantics
// declaration ("this task changes observable state"), which is a different
// concern from the idempotency mechanism enforced here. The two sets
// overlap on ~95% of tasks but legitimately diverge on naturally-idempotent
// mutations (comply_test_controller, si_terminate_session). Do not
// unify — they answer different questions.

function loadMutatingSchemaRefs(schemasDir) {
  const refs = new Set();
  const tools = new Set();
  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!entry.name.endsWith('-request.json')) continue;
      let schema;
      try { schema = JSON.parse(fs.readFileSync(p, 'utf8')); }
      catch { continue; }
      const required = Array.isArray(schema.required) ? schema.required : [];
      if (required.includes('idempotency_key')) {
        refs.add(path.relative(schemasDir, p));
        // Task name ↔ filename: "create-media-buy-request.json" → "create_media_buy"
        tools.add(entry.name.replace(/-request\.json$/, '').replace(/-/g, '_'));
      }
    }
  }
  walk(schemasDir);
  return { refs, tools };
}

function lintStoryboardIdempotency(sourceDir, schemasDir) {
  const { refs: mutatingRefs, tools: mutatingTools } = loadMutatingSchemaRefs(schemasDir);
  const violations = [];
  const missingSchemaRefs = [];

  function lintFile(p) {
    const rel = path.relative(sourceDir, p);
    // Not storyboards: test-kit fixtures and the schema doc itself.
    if (rel.startsWith('test-kits/')) return;
    if (rel.endsWith('storyboard-schema.yaml')) return;

    let doc;
    try { doc = yaml.load(fs.readFileSync(p, 'utf8')); }
    catch { return; }
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.phases)) return;

    for (const phase of doc.phases) {
      if (!phase || !Array.isArray(phase.steps)) continue;
      for (const step of phase.steps) {
        if (!step || typeof step !== 'object' || !step.task) continue;
        // expect_error steps intentionally exercise invalid-request paths,
        // including the "missing idempotency_key" test in universal/idempotency.yaml.
        if (step.expect_error === true) continue;
        // Steps without schema_ref are HTTP probes, controller calls, or
        // synthetic invocations (e.g., comply_test_controller's
        // simulate_budget scenarios, universal/security.yaml's probe steps)
        // that don't send a task request schema. They're out of scope for
        // this lint — UNLESS the task name itself is a known mutating tool,
        // in which case the missing schema_ref is itself a storyboard bug
        // (the step would bypass the idempotency_key lint above). Positive
        // check per red-team I-9 / security.mdx storyboard hygiene.
        if (step.task && mutatingTools.has(step.task) && !step.schema_ref) {
          missingSchemaRefs.push({
            file: rel,
            step: step.id,
            msg: `Step uses mutating tool "${step.task}" but has no schema_ref`,
          });
        }
        const schemaRef = step.schema_ref;
        if (!schemaRef || !mutatingRefs.has(schemaRef)) continue;
        const hasKey =
          step.sample_request &&
          typeof step.sample_request === 'object' &&
          step.sample_request.idempotency_key !== undefined;
        if (hasKey) continue;
        violations.push({
          file: rel,
          phase: phase.id,
          step: step.id,
          task: step.task,
          schema: schemaRef,
        });
      }
    }
  }

  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (entry.name.endsWith('.yaml')) lintFile(p);
    }
  }
  walk(sourceDir);

  if (violations.length > 0) {
    const lines = violations.map(v =>
      `  ${v.file} phase=${v.phase} step=${v.step}: task "${v.task}" is mutating (schema ${v.schema} requires idempotency_key) but sample_request omits it.`
    );
    throw new Error(
      `Storyboard idempotency_key lint: ${violations.length} step(s) invoke a mutating task without declaring idempotency_key in sample_request.\n\n` +
      lines.join('\n') +
      `\n\nAdd \`idempotency_key: "$generate:uuid_v4#<storyboard>_<phase>_<step>"\` ` +
      `to each sample_request (lowercase, hyphens → underscores; the alias is ` +
      `resolved to a stable UUID per run by the storyboard runner). See ` +
      `static/compliance/source/universal/idempotency.yaml for the convention, ` +
      `and note the deliberate alias-reuse pattern there when two steps must ` +
      `share a key (replay tests).`
    );
  }

  if (missingSchemaRefs.length > 0) {
    const lines = missingSchemaRefs.map(v => `  ${v.file} step=${v.step}: ${v.msg}`);
    throw new Error(
      `Storyboard schema_ref lint: ${missingSchemaRefs.length} step(s) call a mutating tool without a schema_ref, which would silently skip the idempotency_key check.\n\n` +
      lines.join('\n') +
      `\n\nAdd the matching \`schema_ref:\` (e.g. "media-buy/create-media-buy-request.json") to each step.`
    );
  }
}

function verifyEnumParity(specialisms, protocols) {
  const fsSpecialisms = new Set(specialisms.map(s => s.id));
  const fsProtocols = new Set(protocols.map(d => d.id));

  const specialismEnum = JSON.parse(fs.readFileSync(SPECIALISM_ENUM, 'utf8'));
  const protocolEnum = JSON.parse(fs.readFileSync(PROTOCOL_ENUM, 'utf8'));

  const enumSpecialisms = new Set(specialismEnum.enum);
  const enumProtocols = new Set(protocolEnum.enum);

  // Enum values listed in `x-deprecated-enum-values` are retained for backward
  // compatibility but their storyboard has been relocated or removed. The
  // filesystem-backing requirement does not apply to them.
  const deprecatedSpecialisms = new Set(specialismEnum['x-deprecated-enum-values'] || []);

  const missingFromEnum = [...fsSpecialisms].filter(x => !enumSpecialisms.has(x));
  const missingFromFs = [...enumSpecialisms]
    .filter(x => !fsSpecialisms.has(x))
    .filter(x => !deprecatedSpecialisms.has(x));
  if (missingFromEnum.length || missingFromFs.length) {
    const msg = [
      `Specialism enum drift between filesystem and specialism.json:`,
      missingFromEnum.length ? `  In filesystem but missing from enum: ${missingFromEnum.join(', ')}` : '',
      missingFromFs.length ? `  In enum but missing from filesystem: ${missingFromFs.join(', ')}` : '',
      missingFromFs.length ? `  (Add to "x-deprecated-enum-values" in specialism.json if intentionally retained for back-compat after storyboard removal.)` : ''
    ].filter(Boolean).join('\n');
    throw new Error(msg);
  }

  const protocolDrift = [...fsProtocols].filter(x => !enumProtocols.has(x));
  if (protocolDrift.length) {
    throw new Error(
      `Protocol drift: compliance filesystem declares protocols not listed in adcp-protocol.json: ${protocolDrift.join(', ')}`
    );
  }

  const unknownProtocolRefs = specialisms
    .filter(s => !enumProtocols.has(s.protocol))
    .map(s => `${s.id} → ${s.protocol}`);
  if (unknownProtocolRefs.length) {
    throw new Error(
      `Specialisms reference protocols not in adcp-protocol.json enum: ${unknownProtocolRefs.join(', ')}`
    );
  }
}

const { lint: lintUniversalDocParity } = require('./lint-universal-storyboard-doc-parity.cjs');

function generateIndex(version, sourceDir) {
  const specialisms = discoverSpecialisms(sourceDir);
  const protocols = discoverProtocols(sourceDir, specialisms);
  verifyEnumParity(specialisms, protocols);
  const docParityErrors = lintUniversalDocParity({ sourceDir });
  if (docParityErrors.length) {
    throw new Error('Universal-storyboard doc parity drift:\n  - ' + docParityErrors.join('\n  - '));
  }
  lintStoryboardIdempotency(sourceDir, SCHEMAS_DIR);
  const universalDir = path.join(sourceDir, 'universal');
  const universal = fs.existsSync(universalDir)
    ? fs.readdirSync(universalDir)
        .filter(f => f.endsWith('.yaml'))
        .map(f => f.replace(/\.yaml$/, ''))
        .sort()
    : [];

  const protocolEntries = protocols.map(d => ({
    id: d.id,
    title: d.title,
    has_baseline: d.has_baseline,
    path: d.path,
  }));
  // Transitional alias for @adcp/client@5.x consumers that read `domains` and expect
  // `domains/{id}/` on-disk paths. Drop after v6 ships and all consumers upgrade.
  const domainAliasEntries = protocols.map(d => ({
    id: d.id,
    title: d.title,
    has_baseline: d.has_baseline,
    path: d.path.replace(/^protocols\//, 'domains/'),
  }));

  return {
    adcp_version: version,
    generated_at: new Date().toISOString(),
    universal,
    protocols: protocolEntries,
    domains: domainAliasEntries,
    specialisms: specialisms.map(s => ({
      id: s.id,
      protocol: s.protocol,
      domain: s.protocol,
      title: s.title,
      status: s.status,
      required_tools: s.required_tools,
      path: s.path
    }))
  };
}

function mirrorProtocolsToDomains(targetDir) {
  const protocolsDir = path.join(targetDir, 'protocols');
  const domainsDir = path.join(targetDir, 'domains');
  if (!fs.existsSync(protocolsDir)) return;
  copyTree(protocolsDir, domainsDir);
}

function buildTo(targetDir, version, sourceDir) {
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  ensureDir(targetDir);
  copyTree(sourceDir, targetDir);
  mirrorProtocolsToDomains(targetDir);
  const index = generateIndex(version, sourceDir);
  fs.writeFileSync(
    path.join(targetDir, 'index.json'),
    JSON.stringify(index, null, 2) + '\n'
  );
  return index;
}

function main() {
  const version = getVersion();

  if (!fs.existsSync(SOURCE_DIR)) {
    console.error(`❌ Source directory not found: ${SOURCE_DIR}`);
    process.exit(1);
  }

  // Scoping lint: every session-scoped step must carry brand/account identity.
  // Fails fast before we build dist/ so broken storyboards don't ship.
  try {
    execSync('node scripts/lint-storyboard-scoping.cjs', {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
    });
  } catch {
    process.exit(1);
  }

  // Branch-set lint: explicit `branch_set:` declarations must be well-formed
  // and grade-connected to an assert_contribution step.
  try {
    execSync('node scripts/lint-storyboard-branch-sets.cjs', {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
    });
  } catch {
    process.exit(1);
  }

  // provides_state_for lint: same-phase substitution declarations on stateful
  // steps must reference real, stateful, same-phase peers and the per-phase
  // peer-graph must be acyclic. See adcontextprotocol/adcp#3734.
  try {
    execSync('node scripts/lint-storyboard-provides-state-for.cjs', {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
    });
  } catch {
    process.exit(1);
  }

  // Contradiction lint: no two storyboards may encode contradictory outcomes
  // for the same (task, request, prior-state, env) — a conformant agent
  // cannot satisfy both.
  try {
    execSync('node scripts/lint-storyboard-contradictions.cjs', {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
    });
  } catch {
    process.exit(1);
  }

  // Context-entity lint: captured $context values must not flow from a field
  // of one entity type into a consume site of a different entity type
  // (issue #2660, rule 3; canonical case #2627).
  try {
    execSync('node scripts/lint-storyboard-context-entity.cjs', {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
    });
  } catch {
    process.exit(1);
  }

  // Auth-shape lint: storyboard steps must use principal-handle shapes
  // (from_test_kit, value_strategy, none) rather than literal credentials
  // that bind the storyboard to a specific value and leak identity into
  // source control. #2720.
  try {
    execSync('node scripts/lint-storyboard-auth-shape.cjs', {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
    });
  } catch {
    process.exit(1);
  }

  // Test-kits lint: every file under test-kits/ must declare either
  // auth.api_key (brand-kit flavor) or applies_to (runner-contract flavor).
  // Enforces the bimodal partition documented in storyboard-schema.yaml
  // under "Test kit flavors". #2721.
  try {
    execSync('node scripts/lint-storyboard-test-kits.cjs', {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
    });
  } catch {
    process.exit(1);
  }

  // Pagination invariant: schema examples and storyboard fixtures MUST NOT
  // teach the cursor↔has_more contradiction. has_more=true requires cursor;
  // has_more=false MUST omit cursor. See pagination-response.json.
  try {
    execSync('node scripts/lint-pagination-invariant.cjs', {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
    });
  } catch {
    process.exit(1);
  }

  // Error-code spec lint: `check: error_code` validations may only cite codes
  // defined in `static/schemas/source/enums/error-code.json`. The `value` and
  // `allowed_values` fields are not validated by check-enum (which only checks
  // the `check` keyword); this lint closes that gap.
  // adcontextprotocol/adcp#3918 item 7.
  try {
    execSync('node scripts/lint-storyboard-error-code-spec.cjs', {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
    });
  } catch {
    process.exit(1);
  }

  console.log(isRelease
    ? `🚀 RELEASE BUILD: Creating compliance artifacts for AdCP v${version}`
    : `📦 Development build: Updating latest/ compliance`);
  console.log(`   Source: ${SOURCE_DIR}`);
  console.log(`   Target: ${DIST_DIR}`);
  console.log('');

  ensureDir(DIST_DIR);

  if (isRelease) {
    const versionDir = path.join(DIST_DIR, version);
    console.log(`📋 Creating release: dist/compliance/${version}/`);
    const index = buildTo(versionDir, version, SOURCE_DIR);
    console.log(`   ✓ ${index.universal.length} universal, ${index.protocols.length} protocols, ${index.specialisms.length} specialisms`);

    console.log(`📋 Updating latest/ to match release`);
    buildTo(path.join(DIST_DIR, 'latest'), 'latest', SOURCE_DIR);

    console.log(`📝 Staging dist/compliance/${version}/ for git commit`);
    try {
      execSync(`git add dist/compliance/${version}/`, {
        cwd: path.join(__dirname, '..'),
        stdio: 'inherit'
      });
    } catch {
      console.log(`   (git add skipped — not in git context)`);
    }

    console.log('');
    console.log('✅ Release build complete!');
  } else {
    const latestDir = path.join(DIST_DIR, 'latest');
    console.log(`📋 Building compliance to dist/compliance/latest/`);
    const index = buildTo(latestDir, 'latest', SOURCE_DIR);
    console.log(`   ✓ ${index.universal.length} universal, ${index.protocols.length} protocols, ${index.specialisms.length} specialisms`);

    console.log('');
    console.log('✅ Development build complete!');
  }
}

main();
