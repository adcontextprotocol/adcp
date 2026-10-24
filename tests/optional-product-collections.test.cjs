"use strict";

// Executes the actual authored storyboards through the production caller and
// public SDK MCP transport. All seller data/credentials are controlled fixtures.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  loadStoryboardFile,
  prepareStoryboardFixtures,
} = require("@adcp/sdk/testing");
const {
  runCatalogReportingStoryboard: runStoryboard,
  runCatalogReportingStoryboardStep: runStoryboardStep,
  withHostedReportingBudget,
} = require("../server/src/compliance/catalog-reporting-runner.ts");
const {
  classifyComplianceStep,
} = require("../server/src/compliance/step-disposition.ts");
const SOURCE = path.join(
  __dirname,
  "../static/compliance/source/protocols/media-buy/scenarios",
);
const CORE = [
  "collection_selection",
  "collection_default_materialization",
  "fixed_bundle_enforcement",
  "fixed_bundle_restatement",
  "owner_sold_channel_carriage",
  "owner_sold_channel_subset",
];
const READ = [
  "collection_selection_readback",
  "collection_default_materialization_readback",
];
const ALL = [...CORE, ...READ];
const URL = "https://collection-regression.example/mcp";
const load = (name) => loadStoryboardFile(path.join(SOURCE, `${name}.yaml`));

function product(
  id = "native-product",
  { flag = true, cross = false, pairs = 2, collections, minimum, prices } = {},
) {
  return {
    product_id: id,
    name: "StreamHaus collection offer",
    description: "Native sandbox product",
    delivery_type: "non_guaranteed",
    channels: ["olv"],
    publisher_properties: [
      {
        publisher_domain: cross ? "host.example" : "studio.example",
        selection_type: "all",
      },
    ],
    format_options: [
      {
        format_option_id: "native-image",
        format_kind: "image",
        params: { width: 300, height: 250 },
      },
    ],
    reporting_capabilities: {
      available_reporting_frequencies: ["daily"],
      expected_delay_minutes: 0,
      timezone: "UTC",
      supports_webhooks: false,
      available_metrics: ["impressions", "clicks", "spend"],
      date_range_support: "date_range",
    },
    collections: collections ?? [
      {
        publisher_domain: "studio.example",
        collection_ids: ["episode-a", "episode-b"].slice(0, pairs),
      },
    ],
    ...(flag === "omitted" ? {} : { collection_targeting_allowed: flag }),
    pricing_options: prices ?? [
      {
        pricing_option_id: `${id}-fixed`,
        pricing_model: "cpm",
        currency: "EUR",
        fixed_price: 17,
        ...(minimum === undefined ? {} : { min_spend_per_package: minimum }),
      },
    ],
  };
}
function qualifying(name, options = {}) {
  const fixed = name.startsWith("fixed_bundle");
  const cross = name.startsWith("owner_sold");
  return product("native-product", { flag: !fixed, cross, ...options });
}
function pairs(selectors) {
  return new Set(
    selectors.flatMap((s) =>
      (s.collection_ids ?? []).map((id) =>
        JSON.stringify([s.publisher_domain, id]),
      ),
    ),
  );
}
function concrete(selectors) {
  const domains = new Map();
  for (const selector of selectors)
    for (const id of selector.collection_ids ?? []) {
      if (!domains.has(selector.publisher_domain))
        domains.set(selector.publisher_domain, new Set());
      domains.get(selector.publisher_domain).add(id);
    }
  return [...domains].reverse().map(([publisher_domain, ids]) => ({
    publisher_domain,
    collection_ids: [...ids].reverse(),
  }));
}

async function execute(
  name,
  {
    catalog = [qualifying(name)],
    pages,
    fault,
    broken,
    reader = true,
    standalone = false,
    stepId = "create_selection",
    context,
    overrides = {},
    noProfile = false,
    hosted = false,
    responsePadding = 0,
    prepareOnly = false,
    buyingModes = ["wholesale"],
    doc = load(name),
    mutateAfterCreate,
    omitCreateLifecycle = false,
    skipPriorCreate = false,
    expectLocalError = false,
    continueFailedCreate = false,
    priorContextTransform,
    readProfileMode,
    readAgentUrl = URL,
    priorRunTransform,
    scenarioOnly = false,
  } = {},
) {
  const calls = [],
    wire = [],
    http = [],
    buys = new Map();
  const tools = [
    "get_adcp_capabilities",
    "get_products",
    "create_media_buy",
    "comply_test_controller",
    ...(reader ? ["get_media_buys"] : []),
  ];
  const caps = {
    status: "completed",
    adcp: {
      major_versions: [3],
      supported_versions: ["3.2"],
      idempotency: { supported: false },
    },
    supported_protocols: ["media_buy"],
    media_buy: { buying_modes: buyingModes },
    compliance_testing: { scenarios: ["seed_account"] },
  };
  let buyIndex = 0;
  let failReadCapabilities = false;
  const trustedFetchFn = async (_url, init = {}) => {
    http.push({ method: init.method ?? "GET", body: init.body });
    if (!init.body)
      return new Response(null, {
        status: init.method === "DELETE" ? 202 : 405,
      });
    const msg = JSON.parse(init.body);
    wire.push(msg.method);
    const reply = (result) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), {
        headers: { "content-type": "application/json" },
      });
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
      return reply({
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "collection-regression", version: "1" },
      });
    if (msg.method.startsWith("notifications/"))
      return new Response(null, { status: 202 });
    if (msg.method === "tools/list")
      return reply({
        tools: tools.map((name) => ({
          name,
          description: name,
          inputSchema: { type: "object", additionalProperties: true },
        })),
      });
    assert.equal(msg.method, "tools/call");
    const { name: task, arguments: request } = msg.params;
    calls.push({ task, request: structuredClone(request) });
    let data;
    if (task === "get_adcp_capabilities") {
      if (failReadCapabilities) {
        failReadCapabilities = false;
        return new Response("Controlled first read capability failure", {
          status: 503,
        });
      }
      data = caps;
    } else if (task === "comply_test_controller") {
      assert.equal(request.account.sandbox, true);
      assert.ok(
        ["list_scenarios", "seed_account"].includes(request.scenario),
        "feature support cannot be manufactured by seeding",
      );
      data =
        request.scenario === "list_scenarios"
          ? { success: true, scenarios: ["seed_account"] }
          : { success: true };
    } else if (task === "get_products") {
      assert.equal(request.buying_mode, "wholesale");
      assert.deepEqual(request.account, doc.context.sandbox_account);
      if (fault === "transport")
        throw new Error("Controlled catalog transport failure");
      if (fault === "protocol")
        data = {
          status: "error",
          errors: [
            {
              code: "INVALID_REQUEST",
              message: "Controlled wholesale refusal",
            },
          ],
        };
      else {
        const index = request.pagination?.cursor
          ? Number(request.pagination.cursor)
          : 0;
        data = {
          status: "completed",
          products:
            fault === "schema"
              ? [{ product_id: "malformed" }]
              : pages
                ? pages[index]
                : catalog,
          cache_scope: "account",
          wholesale_feed_version: "catalog-v1",
          ...(fault === "invalid_version" && { adcp_version: "not-a-release" }),
          ...(pages && {
            pagination: {
              has_more: index < pages.length - 1,
              ...(index < pages.length - 1 && { cursor: String(index + 1) }),
            },
          }),
          ...(fault === "pagination" && { pagination: { has_more: true } }),
          ...(fault === "loop" && {
            pagination: { has_more: true, cursor: "0" },
          }),
        };
      }
    } else if (task === "create_media_buy") {
      assert.deepEqual(request.account, doc.context.sandbox_account);
      assert.deepEqual(request.brand, doc.context.sandbox_brand);
      assert.equal(Object.hasOwn(request, "currency"), false);
      const pkg = request.packages[0];
      const selected = (pages ? pages.flat() : catalog).find(
        (p) => p.product_id === pkg.product_id,
      );
      assert.ok(selected, "the request uses a real selected seller product");
      const price = selected.pricing_options.find(
        (p) => p.pricing_option_id === pkg.pricing_option_id,
      );
      assert.ok(
        price && price.fixed_price !== undefined,
        "the price belongs to that SAME selected parent",
      );
      assert.equal(pkg.bid_price, undefined);
      assert.equal(
        pkg.budget,
        Math.max(1000, price.min_spend_per_package ?? 0),
      );
      const selection = pkg.targeting_overlay.collection_selection;
      const full = pairs(selected.collections);
      const wanted =
        selection.mode === "default" ? full : pairs(selection.collections);
      let error;
      if (
        selection.mode === "selected" &&
        selection.collections.some((s) => !Array.isArray(s.collection_ids))
      )
        error = "INVALID_REQUEST";
      else if ([...wanted].some((p) => !full.has(p)))
        error = "REFERENCE_NOT_FOUND";
      else if (
        selected.collection_targeting_allowed !== true &&
        wanted.size !== full.size
      )
        error = "UNSUPPORTED_FEATURE";
      if (broken === "reject_all") error = "UNSUPPORTED_FEATURE";
      if (error && broken !== "accept_invalid") {
        data = {
          status: "error",
          errors: [
            {
              code: broken === "wrong_error" ? "INVALID_REQUEST" : error,
              message: "Controlled selector refusal",
            },
          ],
        };
      } else {
        const selectedSelectors =
          selection.mode === "default" || broken === "widen"
            ? concrete(selected.collections)
            : concrete(selection.collections);
        let echo = { mode: "selected", collections: selectedSelectors };
        if (broken === "domain")
          echo.collections[0].publisher_domain = "wrong-namespace.example";
        if (broken === "drop") echo.collections = [];
        if (broken === "duplicate_echo")
          echo.collections.push(structuredClone(echo.collections[0]));
        if (broken === "default_unmaterialized" && selection.mode === "default")
          echo = { mode: "default" };
        const media_buy_id = `seller-buy-${++buyIndex}`,
          package_id = `seller-package-${buyIndex}`;
        const pack = {
          package_id,
          product_id: selected.product_id,
          pricing_option_id: price.pricing_option_id,
          ...(broken === "missing_echo"
            ? {}
            : { targeting_overlay: { collection_selection: echo } }),
        };
        data = {
          status: "completed",
          ...(omitCreateLifecycle ? {} : { media_buy_status: "active" }),
          media_buy_id,
          confirmed_at: "2026-10-23T00:00:00Z",
          revision: 1,
          packages: [pack],
        };
        if (broken === "wrong_product")
          data.packages[0].product_id = "foreign-product";
        if (broken === "missing_product") delete data.packages[0].product_id;
        if (broken === "extra_package")
          data.packages.push({ ...pack, package_id: "unrequested-package" });
        buys.set(media_buy_id, {
          media_buy_id,
          status: "active",
          currency: price.currency,
          total_budget: pkg.budget,
          confirmed_at: data.confirmed_at,
          revision: 1,
          packages: [structuredClone(pack)],
        });
        if (mutateAfterCreate) mutateAfterCreate(selected);
      }
    } else if (task === "get_media_buys") {
      assert.equal(reader, true, "an absent reader must never be dispatched");
      assert.deepEqual(request.account, doc.context.sandbox_account);
      data = {
        status: "completed",
        media_buys: request.media_buy_ids.map((id) =>
          structuredClone(buys.get(id)),
        ),
      };
      assert.ok(
        data.media_buys.every(Boolean),
        "readback uses actual earlier committed buys",
      );
      if (broken === "read_identity")
        data.media_buys[0].media_buy_id = "foreign-buy";
      if (broken === "read_product")
        data.media_buys[0].packages[0].product_id = "foreign-product";
      if (broken === "read_missing_product")
        delete data.media_buys[0].packages[0].product_id;
      if (broken === "read_package")
        data.media_buys[0].packages[0].package_id = "foreign-package";
      if (broken === "read_widen")
        data.media_buys[0].packages[0].targeting_overlay.collection_selection.collections =
          [
            {
              publisher_domain: "wrong.example",
              collection_ids: ["uncommitted"],
            },
          ];
      if (broken === "read_missing")
        delete data.media_buys[0].packages[0].targeting_overlay;
    } else assert.fail(`Unexpected tool ${task}`);
    return reply({
      content: [{ type: "text", text: JSON.stringify(data) }],
      ...(task === "get_products" &&
        responsePadding && { _meta: { padding: "x".repeat(responsePadding) } }),
    });
  };
  let options = {
    adcpVersion: "3.2.5",
    timeout_ms: 3000,
    ...(noProfile
      ? {}
      : {
          profile: {
            tools,
            raw_capabilities: caps,
            supported_protocols: ["media_buy"],
          },
        }),
    transport: { trustedFetchFn },
    ...(context && { context }),
    ...overrides,
  };
  if (scenarioOnly) return { options, calls, wire, http, doc, url: URL };
  if (hosted) options = withHostedReportingBudget(doc, options);
  if (prepareOnly)
    return {
      prepared: await prepareStoryboardFixtures(URL, doc, {
        ...options,
        brand: doc.context.sandbox_brand,
        sandbox: true,
      }),
      calls,
      wire,
      http,
    };
  let result;
  let created;
  if (
    !skipPriorCreate &&
    standalone &&
    stepId === "read_selection" &&
    reader &&
    buyingModes.includes("wholesale")
  ) {
    created = await runStoryboardStep(URL, doc, "create_selection", options);
    if (!continueFailedCreate)
      assert.equal(created.passed, true, JSON.stringify(created));
    options = { ...options, context: structuredClone(created.context) };
    if (priorContextTransform) priorContextTransform(options.context);
    if (priorRunTransform) priorRunTransform({ doc, options });
    if (readProfileMode === "probe_error")
      options.profile = {
        ...options.profile,
        capabilities_probe_error: "Controlled prior discovery error",
      };
    if (readProfileMode === "schema_error")
      options.profile = {
        ...options.profile,
        capabilities_schema_issues: ["Controlled schema issue"],
      };
    if (readProfileMode === "malformed_modes")
      options.profile = {
        ...options.profile,
        raw_capabilities: { ...caps, media_buy: { buying_modes: "wholesale" } },
      };
    if (readProfileMode === "fail_once") {
      delete options.profile;
      failReadCapabilities = true;
    }
  }
  try {
    result = standalone
      ? await runStoryboardStep(readAgentUrl, doc, stepId, options)
      : await runStoryboard(URL, doc, options);
  } catch (error) {
    if (
      !expectLocalError &&
      overrides.prepared_fixtures_authorizer === undefined &&
      overrides.prepared_fixtures === undefined &&
      !overrides.signal?.aborted
    )
      throw error;
    return { error, calls, wire, http, created };
  }
  const graded = (
    result.phases ?? [{ phase_id: result.phase_id, steps: [result] }]
  ).flatMap((p) =>
    p.steps.map((s) => ({
      ...s,
      disposition: classifyComplianceStep(s, `${doc.id}/${p.phase_id}`),
    })),
  );
  return { result, calls, wire, http, graded, created };
}

if (require.main === module) {
  for (const name of ALL) {
    test(`${name}: actual source full and standalone accepts native same-graph selectors and commercial terms`, async () => {
      for (const standalone of [false, true]) {
        const { result, calls } = await execute(name, { standalone });
        assert.equal(
          standalone ? result.passed : result.overall_passed,
          true,
          JSON.stringify(result),
        );
        assert.equal(
          result.fixture_resolutions.every(
            (r) => r.status === "resolved" && r.strategy === "discover",
          ),
          true,
        );
        assert.ok(calls.some((c) => c.task === "create_media_buy"));
      }
    });
    test(`${name}: nonsupporting catalog is an honest no-match, with no product seeds or purchase`, async () => {
      const plain = product();
      delete plain.collections;
      delete plain.collection_targeting_allowed;
      for (const standalone of [false, true]) {
        const { result, calls, graded } = await execute(name, {
          standalone,
          catalog: [plain],
        });
        assert.equal(
          calls.some((c) => c.task === "create_media_buy"),
          false,
        );
        assert.equal(
          standalone
            ? classifyComplianceStep(
                result,
                `${load(name).id}/${result.phase_id}`,
              )
            : classifyComplianceStep({
                skipped: true,
                skip_reason: result.coverage_gaps?.[0]?.reason,
              }),
          "not_applicable",
          JSON.stringify(result),
        );
        assert.equal(
          graded.some((s) => s.disposition === "failed"),
          false,
        );
      }
    });
  }
  for (const name of READ) {
    test(`${name}: missing reader has the actual native root gate in full and standalone`, async () => {
      for (const standalone of [false, true]) {
        const { result, calls, http, graded } = await execute(name, {
          reader: false,
          standalone,
          stepId: "read_selection",
        });
        assert.equal(calls.length, 0, JSON.stringify(calls));
        assert.equal(http.length, 0);
        assert.equal(graded.length, 1);
        assert.equal(
          graded[0].disposition,
          "not_applicable",
          JSON.stringify(result),
        );
        assert.equal(graded[0].step_id, "missing_tool");
        assert.equal(graded[0].phase_id, "missing_tool");
      }
    });
    test(`${name}: actual persisted read passes full and standalone with the committed selector capture`, async () => {
      for (const standalone of [false, true]) {
        const { result } = await execute(name, {
          standalone,
          stepId: "read_selection",
        });
        assert.equal(
          standalone ? result.passed : result.overall_passed,
          true,
          JSON.stringify(result),
        );
      }
    });
  }

  test("authority: supplied hooks stay fail-closed before every HTTP interaction, not falsely called", async () => {
    const util = require("node:util");
    for (const name of ALL)
      for (const standalone of [false, true]) {
        let invoked = 0;
        const audits = [];
        const { error, http, calls } = await execute(name, {
          standalone,
          overrides: {
            prepared_fixtures_authorizer: () => {
              invoked++;
              throw new Error("private-host-token");
            },
            prepared_fixtures_audit_sink: (r) => audits.push(r),
          },
        });
        assert.equal(error.name, "PreparedFixturesDeniedError");
        assert.equal(invoked, 0);
        assert.equal(http.length, 0);
        assert.equal(calls.length, 0);
        assert.equal(audits.length, 1);
        assert.equal(util.inspect(error).includes("private-host-token"), false);
      }
  });
  test("committed readback: later catalog mutation cannot replace the captured committed set", async () => {
    for (const standalone of [false, true]) {
      const { result } = await execute("collection_selection_readback", {
        standalone,
        stepId: "read_selection",
        mutateAfterCreate: (p) => {
          p.collections = [
            {
              publisher_domain: "studio.example",
              collection_ids: ["later-a", "later-b"],
            },
          ];
        },
      });
      assert.equal(
        standalone ? result.passed : result.overall_passed,
        true,
        JSON.stringify(result),
      );
    }
  });
}
module.exports = { execute, product, qualifying, CORE, READ, ALL, load, pairs };
