const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const ROOT = path.join(__dirname, "..");
const SCHEMA_ROOT = path.join(ROOT, "static", "schemas", "source");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

async function loadSchema(uri) {
  if (!uri.startsWith("/schemas/")) {
    throw new Error(`Unexpected schema URI: ${uri}`);
  }
  return JSON.parse(
    fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice("/schemas/".length)), "utf8")
  );
}

async function compile(uri) {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema });
  addFormats(ajv);
  return ajv.compileAsync(await loadSchema(uri));
}

function validationErrors(validate) {
  return JSON.stringify(validate.errors || []);
}

test("experimental TMP Offer cleanly publishes creative_data instead of macros", async () => {
  const offerSchema = JSON.parse(
    read("static/schemas/source/trusted-match/offer.json")
  );
  assert.ok(offerSchema.properties.creative_data);
  assert.equal(offerSchema.properties.macros, undefined);
  assert.match(
    offerSchema.properties.creative_data.description,
    /MUST ignore unknown keys/
  );
  assert.match(
    offerSchema.properties.creative_data.description,
    /missing key MUST NOT make an otherwise renderable offer fail/
  );

  const validate = await compile("/schemas/trusted-match/offer.json");
  assert.equal(
    validate({
      package_id: "pkg_123",
      creative_data: { sponsor_label: "Presented by Acme" },
    }),
    true,
    validationErrors(validate)
  );
  assert.equal(
    validate({ package_id: "pkg_123", creative_data: { discount: 20 } }),
    false
  );
  assert.equal(
    validate({ package_id: "pkg_123", macros: { sponsor_label: "Acme" } }),
    false,
    "the experimental clean rename must reject the removed macros property"
  );

  const tmpDocs = [
    "docs/trusted-match/specification.mdx",
    "docs/trusted-match/context-and-identity.mdx",
    "docs/trusted-match/surfaces/web.mdx",
    "docs/trusted-match/surfaces/mobile.mdx",
    "docs/trusted-match/surfaces/retail-media.mdx",
    "docs/trusted-match/surfaces/ai-assistants.mdx",
  ];
  for (const file of tmpDocs) {
    assert.doesNotMatch(
      read(file),
      /Offer(?:'s)?\s+`macros`|offer\.macros|"macros"\s*:/i,
      file
    );
  }
});

test("ContextSignals keeps single-user derived data behind the publisher privacy boundary", () => {
  const requestSchema = JSON.parse(
    read("static/schemas/source/trusted-match/context-match-request.json")
  );
  const contextSignals = requestSchema.properties.context_signals;

  assert.match(contextSignals.description, /classifier and privacy boundary/);
  assert.match(
    contextSignals.description,
    /Ephemeral content that many users encounter.*is shared content; one user's turn or query is not/
  );
  assert.match(
    contextSignals.properties.topics.description,
    /MUST use standardized taxonomy identifiers or bounded custom category labels/
  );
  assert.match(
    contextSignals.properties.embedding.description,
    /MUST NOT be computed directly or indirectly from non-public content/
  );
  assert.match(
    contextSignals.properties.keywords.description,
    /MUST be policy-filtered/
  );
  assert.match(
    contextSignals.properties.summary.description,
    /MUST NOT reproduce raw user-authored text/
  );

  const specification = read("docs/trusted-match/specification.mdx");
  assert.match(
    specification,
    /Router isolation prevents identity-path data from entering the context path; it does not make user-derived context anonymous\./
  );

  const aiAssistantSurface = read("docs/trusted-match/surfaces/ai-assistants.mdx");
  assert.match(aiAssistantSurface, /omits `artifact_refs`/);
  assert.doesNotMatch(aiAssistantSurface, /"value": "turn:/);
  assert.match(aiAssistantSurface, /MUST NOT send an embedding derived from the turn/);
  assert.match(
    read("docs/trusted-match/ai-mediation.mdx"),
    /MUST NOT carry an embedding derived from the turn/
  );
});

test("Context Match caching partitions request and provider evaluation contexts", () => {
  const specification = read("docs/trusted-match/specification.mdx");
  const routerArchitecture = read("docs/trusted-match/router-architecture.mdx");
  const dataProtection = read("docs/trusted-match/data-protection-roles.mdx");

  assert.match(
    specification,
    /\{provider_id, cache_namespace, context_hash\}/
  );
  assert.doesNotMatch(
    specification,
    /recommended cache key is `\{property_rid, placement_id, provider_id\}`/
  );
  assert.match(specification, /Remove `\$schema`/);
  assert.match(specification, /and `request_id`/);
  assert.match(specification, /RFC 8785 JCS/);
  assert.match(specification, /Array order is preserved/);
  assert.match(
    specification,
    /Equality of `provider_id` and the forwarded request body alone is insufficient/
  );
  assert.match(
    specification,
    /`provider_id` is the stable provider registration identity and MUST NOT be overloaded/
  );
  assert.match(
    specification,
    /MUST differ across provider-side authenticated principals or tenants whenever their authorization, entitlements, or tenant data can affect the response/
  );
  assert.match(
    specification,
    /MUST also change whenever an authorization or entitlement revision, active-package data generation, provider endpoint replacement, provider configuration, deployed model, or targeting\/rules generation can affect the response/
  );
  assert.match(
    specification,
    /MUST select `cache_namespace` only from trusted authentication, authorization, deployment, and provider-configuration state/
  );
  assert.match(
    specification,
    /MUST NOT accept the namespace or any of its inputs from the caller or request body/
  );
  assert.match(
    specification,
    /MUST NOT include or be derived from viewer identity, user tokens, or Identity Match state/
  );
  assert.match(
    specification,
    /MUST authenticate the current request and authorize the current publisher principal for the requested property under current policy/
  );
  assert.match(
    specification,
    /authorization or entitlement revision, active-package data generation, provider endpoint replacement/
  );
  assert.match(
    specification,
    /MUST NOT contain raw or directly encoded principal or tenant identifiers and MUST NOT be derived from credentials/
  );
  assert.match(
    specification,
    /namespace and its derivation metadata are non-secret but sensitive/
  );
  assert.match(
    specification,
    /native tuple or encoded with unambiguous length framing or canonical structured encoding/
  );
  assert.match(
    specification,
    /bind cache lookup, in-flight request coalescing, outbound endpoint and authentication selection, provider evaluation, and cache insertion to that same context/
  );
  assert.match(
    specification,
    /MUST discard it for caching if the captured context is no longer current/
  );
  assert.match(
    specification,
    /Namespace generation values MUST NOT be reused while an entry or in-flight request from the prior use can survive/
  );
  assert.match(
    specification,
    /A changed context MUST NOT be able to reach entries under its prior namespace; an unchanged, concurrently supported context MAY continue/
  );
  assert.match(
    specification,
    /cannot coordinate generation change or invalidation with the provider, it MUST bypass cache lookup, coalescing, and insertion/
  );
  assert.match(
    specification,
    /A future response with `cache_ttl: 0` cannot invalidate an already-served warm hit/
  );
  assert.match(
    specification,
    /MUST set the returned response's `request_id` to the current request's `request_id`/
  );
  assert.match(
    specification,
    /`context_hash` and any retained hash preimage MUST NOT appear in logs, metric labels, or traces/
  );
  assert.match(routerArchitecture, /A placement-only key is unsafe/);
  assert.match(routerArchitecture, /a body-only key is still unsafe/);
  assert.match(
    specification,
    /MAY prefix `context_hash` with `property_rid` for cache-store sharding/
  );
  assert.match(
    specification,
    /`cache_ttl: 0` is appropriate for those placements/
  );
  assert.match(
    dataProtection,
    /one session's artifact, signals, geo, package selection, or provider evaluation context can determine the response served to another/
  );
  assert.match(dataProtection, /Warm hits still require current authentication/);
});
