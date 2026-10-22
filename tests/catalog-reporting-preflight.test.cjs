"use strict";

// Copyable into tests/: actual source + production adapter + public MCP transport.
// No private SDK seams, source projections, feature seeds, or network writes.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const {
  loadStoryboardFile,
  runStoryboard: runNative,
  runStoryboardStep: runNativeStep,
} = require("@adcp/sdk/testing");
const {
  runCatalogReportingStoryboard: runAdapted,
  runCatalogReportingStoryboardStep: runAdaptedStep,
} = require(
  path.join(ROOT, "server/src/compliance/catalog-reporting-runner.ts"),
);
const ENDPOINT = "https://reporting-preflight-regression.example/mcp";
const ALL_TOOLS = [
  "get_adcp_capabilities",
  "get_products",
  "create_media_buy",
  "get_media_buy_delivery",
  "comply_test_controller",
];
const FILES = [
  "advanced_delivery_reporting.yaml",
  "time_based_delivery_reporting.yaml",
];

function io({
  modes = ["brief", "wholesale"],
  controller = true,
  withProfile = true,
  fault,
} = {}) {
  const tools = controller
    ? ALL_TOOLS
    : ALL_TOOLS.filter((t) => t !== "comply_test_controller");
  const caps = {
    status: "completed",
    adcp: {
      major_versions: [3],
      supported_versions: ["3.2"],
      idempotency: { supported: false },
    },
    supported_protocols: ["media_buy"],
    media_buy: { buying_modes: modes },
    ...(controller
      ? {
          compliance_testing: {
            scenarios: ["seed_account", "simulate_delivery"],
          },
        }
      : {}),
  };
  const calls = [],
    wire = [],
    http = [];
  const trustedFetchFn = async (_url, init = {}) => {
    http.push({ method: init.method ?? "GET", body: init.body });
    if (!init.body)
      return new Response(null, {
        status: init.method === "DELETE" ? 202 : 405,
      });
    const msg = JSON.parse(init.body);
    wire.push(msg.method);
    let result;
    if (msg.method === "server/discover")
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: "Not supported" },
        }),
        { headers: { "content-type": "application/json" } },
      );
    if (msg.method === "initialize")
      result = {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "reporting-preflight-regression", version: "1" },
      };
    else if (msg.method.startsWith("notifications/"))
      return new Response(null, { status: 202 });
    else if (msg.method === "tools/list" && fault === "tools-transport")
      return new Response("Deliberate tools transport outage", { status: 503 });
    else if (msg.method === "tools/list")
      result = {
        tools: tools.map((name) => ({
          name,
          description: name,
          inputSchema: { type: "object", additionalProperties: true },
        })),
      };
    else if (msg.method === "tools/call") {
      const { name, arguments: request } = msg.params;
      calls.push({ name, request });
      let data;
      if (name === "get_adcp_capabilities") {
        if (fault === "cap-transport")
          return new Response("Deliberate capability transport outage", {
            status: 503,
          });
        if (fault === "cap-protocol")
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: "Deliberate capability protocol rejection",
                  },
                ],
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        data =
          fault === "version-unsupported"
            ? {
                status: "error",
                errors: [
                  {
                    code: "VERSION_UNSUPPORTED",
                    message: "Deliberate unsupported version",
                  },
                ],
              }
            : fault === "cap-schema"
              ? { ...caps, media_buy: { buying_modes: 42 } }
              : caps;
      } else if (name === "comply_test_controller")
        data =
          request.scenario === "list_scenarios"
            ? { scenarios: ["seed_account", "simulate_delivery"] }
            : { success: true };
      else if (name === "get_products")
        data = {
          status: "completed",
          products: [],
          cache_scope: "account",
          wholesale_feed_version: "v1",
        };
      else throw new Error(`Unexpected excluded-scope dispatch: ${name}`);
      result = { content: [{ type: "text", text: JSON.stringify(data) }] };
    } else throw new Error(`Unexpected MCP method: ${msg.method}`);
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }),
      { headers: { "content-type": "application/json" } },
    );
  };
  return {
    calls,
    wire,
    http,
    options: {
      adcpVersion: "3.2.5",
      timeout_ms: 3000,
      ...(withProfile
        ? {
            profile: {
              tools,
              raw_capabilities: caps,
              supported_protocols: ["media_buy"],
            },
          }
        : {}),
      transport: { trustedFetchFn },
    },
  };
}

function source(file) {
  return loadStoryboardFile(
    path.join(
      ROOT,
      "static/compliance/source/protocols/media-buy/scenarios",
      file,
    ),
  );
}
function noSetupOrCatalog(probe) {
  assert.deepEqual(
    probe.calls.filter((c) => c.name !== "get_adcp_capabilities"),
    [],
    "excluded source must not enumerate controller scenarios, seed accounts, read catalog or purchase",
  );
}

for (const file of FILES)
  for (const standalone of [false, true]) {
    test(`${file}: ${standalone ? "standalone" : "full"} brief-only profile preserves native gate without setup`, async () => {
      const doc = source(file),
        adapted = io({ modes: ["brief"] }),
        native = io({ modes: ["brief"] });
      const actual = standalone
        ? await runAdaptedStep(ENDPOINT, doc, "create_buy", adapted.options)
        : await runAdapted(ENDPOINT, doc, adapted.options);
      const expected = standalone
        ? await runNativeStep(ENDPOINT, doc, "create_buy", native.options)
        : await runNative(ENDPOINT, doc, native.options);
      noSetupOrCatalog(adapted);
      noSetupOrCatalog(native);
      if (standalone) assert.equal(actual.skip_reason, expected.skip_reason);
      else
        assert.deepEqual(
          actual.phases.map((p) => p.steps.map((s) => s.skip_reason)),
          expected.phases.map((p) => p.steps.map((s) => s.skip_reason)),
        );
    });

    test(`${file}: ${standalone ? "standalone" : "full"} absent controller preserves native outcome without setup`, async () => {
      const doc = source(file),
        adapted = io({ controller: false }),
        native = io({ controller: false });
      const actual = standalone
        ? await runAdaptedStep(ENDPOINT, doc, "create_buy", adapted.options)
        : await runAdapted(ENDPOINT, doc, adapted.options);
      const expected = standalone
        ? await runNativeStep(ENDPOINT, doc, "create_buy", native.options)
        : await runNative(ENDPOINT, doc, native.options);
      noSetupOrCatalog(adapted);
      noSetupOrCatalog(native);
      if (standalone)
        assert.deepEqual(
          { passed: actual.passed, skip_reason: actual.skip_reason },
          { passed: expected.passed, skip_reason: expected.skip_reason },
        );
      else assert.equal(actual.overall_passed, expected.overall_passed);
    });
  }

for (const file of FILES) {
  test(`${file}: discovered brief-only profile never reaches fixture setup`, async () => {
    const probe = io({ modes: ["brief"], withProfile: false });
    await runAdapted(ENDPOINT, source(file), probe.options);
    assert.ok(
      probe.calls.some((c) => c.name === "get_adcp_capabilities"),
      "real public capability discovery must occur",
    );
    noSetupOrCatalog(probe);
  });

  test(`${file}: unknown standalone step is rejected before all seller contact`, async () => {
    const adapted = io(),
      native = io(),
      doc = source(file);
    await assert.rejects(
      () =>
        runAdaptedStep(
          ENDPOINT,
          doc,
          "unknown_reporting_step",
          adapted.options,
        ),
      /not found in storyboard/,
    );
    await assert.rejects(
      () =>
        runNativeStep(ENDPOINT, doc, "unknown_reporting_step", native.options),
      /not found in storyboard/,
    );
    assert.deepEqual(adapted.calls, []);
    assert.deepEqual(adapted.wire, []);
    assert.deepEqual(native.calls, []);
    assert.deepEqual(native.wire, []);
    assert.deepEqual(adapted.http, []);
    assert.deepEqual(native.http, []);
  });
}

for (const file of FILES)
  for (const standalone of [false, true]) {
    for (const map of [
      "context",
      "context_provenance",
      "response_derived_not_applicable_context_keys",
    ]) {
      test(`${file}: ${standalone ? "standalone" : "full"} refuses reserved ${map} before unprofiled discovery`, async () => {
        const adapted = io({ withProfile: false }),
          native = io({ withProfile: false }),
          doc = source(file);
        const overrides = { [map]: { __adcp_fixture_injected: {} } };
        const refused = (error) => error.name === "PreparedFixturesDeniedError";
        await assert.rejects(
          () =>
            standalone
              ? runAdaptedStep(ENDPOINT, doc, "create_buy", {
                  ...adapted.options,
                  ...overrides,
                })
              : runAdapted(ENDPOINT, doc, { ...adapted.options, ...overrides }),
          refused,
        );
        await assert.rejects(
          () =>
            standalone
              ? runNativeStep(ENDPOINT, doc, "create_buy", {
                  ...native.options,
                  ...overrides,
                })
              : runNative(ENDPOINT, doc, { ...native.options, ...overrides }),
          refused,
        );
        assert.deepEqual(
          native.wire,
          [],
          "native metadata screen precedes all seller HTTP",
        );
        assert.deepEqual(
          adapted.wire,
          [],
          "adapter must preserve the native precontact authority screen",
        );
        assert.deepEqual(native.http, []);
        assert.deepEqual(adapted.http, []);
      });
    }
  }

test("unbundled candidate preflight honors the caller schema root", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const schemaRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "reporting-schema-root-"),
  );
  try {
    fs.cpSync(path.join(ROOT, "dist/schemas/3.2.5"), schemaRoot, {
      recursive: true,
    });
    const rewriteIds = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) rewriteIds(file);
        else if (entry.name.endsWith(".json"))
          fs.writeFileSync(
            file,
            fs
              .readFileSync(file, "utf8")
              .replaceAll("/schemas/3.2.5/", "/schemas/latest/"),
          );
      }
    };
    rewriteIds(schemaRoot);
    const indexPath = path.join(schemaRoot, "index.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    // A controlled candidate artifact; no published/released files are edited.
    index.adcp_version = "3.3.0-beta.0";
    fs.writeFileSync(indexPath, JSON.stringify(index));
    const probe = io({ modes: ["brief"], withProfile: false });
    await runAdapted(ENDPOINT, source(FILES[0]), {
      ...probe.options,
      adcpVersion: "3.3.0-beta.0",
      wireAdcpVersion: "3.2.5",
      schemaRoot,
    });
    assert.ok(probe.calls.some((c) => c.name === "get_adcp_capabilities"));
    noSetupOrCatalog(probe);
  } finally {
    fs.rmSync(schemaRoot, { recursive: true, force: true });
  }
});

for (const file of FILES)
  for (const standalone of [false, true]) {
    for (const fault of [
      "tools-transport",
      "cap-transport",
      "cap-protocol",
      "version-unsupported",
      "cap-schema",
    ]) {
      test(`${file}: ${standalone ? "standalone" : "full"} ${fault} preflight stays an execution failure with original evidence`, async () => {
        const probe = io({ withProfile: false, fault }),
          doc = source(file);
        await assert.rejects(
          () =>
            standalone
              ? runAdaptedStep(ENDPOINT, doc, "create_buy", probe.options)
              : runAdapted(ENDPOINT, doc, probe.options),
          (error) => {
            assert.match(
              error.message,
              /Catalog reporting capability discovery failed/,
            );
            assert.equal(
              error.message,
              "Catalog reporting capability discovery failed before preparation",
            );
            assert.equal(
              Object.prototype.propertyIsEnumerable.call(error, "cause"),
              false,
            );
            assert.equal(JSON.stringify(error).includes("Deliberate"), false);
            assert.ok(
              error.cause?.steps?.length,
              "retain the ORIGINAL public probe result",
            );
            assert.ok(
              error.cause.steps.some((step) => !step.passed) ||
                error.cause.profile?.capabilities_schema_issues?.length,
            );
            return true;
          },
        );
        noSetupOrCatalog(probe); // Never retry discovery into fixture applicability.
      });
    }
    for (const metadata of [
      "probe-error",
      "schema-issues",
      "malformed-modes",
    ]) {
      test(`${file}: ${standalone ? "standalone" : "full"} supplied ${metadata} profile cannot bypass discovery failure`, async () => {
        const probe = io(),
          doc = source(file);
        const profile = probe.options.profile;
        if (metadata === "probe-error")
          profile.capabilities_probe_error =
            "Deliberate prior discovery failure";
        if (metadata === "schema-issues")
          profile.capabilities_schema_issues = [
            { message: "Deliberate prior schema failure" },
          ];
        if (metadata === "malformed-modes")
          profile.raw_capabilities.media_buy.buying_modes = 42;
        await assert.rejects(
          () =>
            standalone
              ? runAdaptedStep(ENDPOINT, doc, "create_buy", probe.options)
              : runAdapted(ENDPOINT, doc, probe.options),
          (error) => {
            assert.match(
              error.message,
              /Catalog reporting capability discovery failed/,
            );
            assert.equal(error.cause.profile, profile);
            assert.equal(error.message.includes("Deliberate"), false);
            assert.equal(
              Object.prototype.propertyIsEnumerable.call(error, "cause"),
              false,
            );
            return true;
          },
        );
        assert.deepEqual(
          probe.http,
          [],
          "failed supplied profile stops before every seller interaction",
        );
      });
    }
  }
