const fs = require("fs");
const path = require("path");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

const SCHEMA_ROOT = path.join(__dirname, "..", "static", "schemas", "source");

function readSchema(uri) {
  assert.match(uri, /^\/schemas\//);
  return JSON.parse(
    fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice("/schemas/".length)), "utf8")
  );
}

async function compile(schema) {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    loadSchema: async (ref) => readSchema(ref),
  });
  addFormats(ajv);
  return ajv.compileAsync(schema);
}

const installment_ref = {
  collection_ref: { publisher_domain: "northstar.example.com", collection_id: "northstar_creators" },
  installment_id: "ep_2026_10_12",
};

const post = {
  asset_type: "published_post",
  post_url: "https://video.example.com/watch/abc123",
  platform: "example_video",
};

const publication = {
  published_at: "2026-10-12T15:00:00Z",
  posts: [post, { ...post, post_url: "https://shorts.example.com/p/xyz789", platform: "example_shorts" }],
};

describe("installment lifecycle and proof of publication", () => {
  let validateRow;
  let validatePublication;
  let validateCapabilities;
  let validateController;

  before(async () => {
    [validateRow, validatePublication, validateCapabilities, validateController] =
      await Promise.all([
        compile(readSchema("/schemas/core/installment-delivery-metrics.json")),
        compile(readSchema("/schemas/core/installment-publication.json")),
        compile(readSchema("/schemas/core/reporting-capabilities.json")),
        compile(readSchema("/schemas/compliance/comply-test-controller-request.json")),
      ]);
  });

  it("marks every new node experimental and 3.3.0", () => {
    const rowProps = readSchema("/schemas/core/installment-delivery-metrics.json").allOf[1].properties;
    const caps = readSchema("/schemas/core/reporting-capabilities.json").properties;
    const publicationSchema = readSchema("/schemas/core/installment-publication.json");
    const controller = readSchema("/schemas/compliance/comply-test-controller-request.json");
    const nodes = [
      publicationSchema,
      rowProps.installment_status,
      rowProps.publication,
      caps.available_installment_statuses,
      controller.properties.params.properties.installment_delivery,
    ];
    for (const node of nodes) {
      assert.equal(node["x-status"], "experimental");
      assert.equal(node["x-added-in"], "3.3.0");
    }
    assert.equal(rowProps.installment_status.$ref, "/schemas/enums/installment-status.json");
    assert.equal(rowProps.publication.$ref, "/schemas/core/installment-publication.json");
  });

  it("accepts a published row with a publication record", () => {
    assert.equal(
      validateRow({
        installment_ref,
        installment_status: "published",
        impressions: 0,
        views: 52000,
        spend: 8000,
        publication: { ...publication, verified_by: { domain: "verifier.example.com" } },
      }),
      true,
      JSON.stringify(validateRow.errors)
    );
  });

  it("keeps 3.2 rows without installment_status valid", () => {
    assert.equal(validateRow({ installment_ref, impressions: 100, spend: 10 }), true);
  });

  it("accepts a scheduled row without impressions", () => {
    assert.equal(
      validateRow({
        installment_ref,
        installment_status: "scheduled",
        scheduled_at: "2026-10-12T15:00:00Z",
        spend: 0,
      }),
      true,
      JSON.stringify(validateRow.errors)
    );
  });

  it("accepts a cancelled row without delivery metrics", () => {
    assert.equal(
      validateRow({ installment_ref, installment_status: "cancelled", spend: 0 }),
      true,
      JSON.stringify(validateRow.errors)
    );
  });

  it("rejects publication on rows that cannot have been published", () => {
    for (const installment_status of ["scheduled", "tentative", "postponed", "cancelled", "live"]) {
      assert.equal(
        validateRow({ installment_ref, installment_status, spend: 0, publication }),
        false,
        installment_status
      );
    }
  });

  it("rejects an unknown installment_status", () => {
    assert.equal(
      validateRow({ installment_ref, installment_status: "skipped", impressions: 0, spend: 0 }),
      false
    );
  });

  it("requires published_at and at least one post", () => {
    assert.equal(validatePublication({ posts: publication.posts }), false);
    assert.equal(validatePublication({ published_at: publication.published_at }), false);
    assert.equal(validatePublication({ published_at: publication.published_at, posts: [] }), false);
    assert.equal(validatePublication(publication), true);
  });

  it("rejects posts[] items that have neither post_url nor platform_post_id", () => {
    assert.equal(
      validatePublication({
        published_at: publication.published_at,
        posts: [{ asset_type: "published_post", platform: "example_video" }],
      }),
      false
    );
    assert.equal(
      validatePublication({
        published_at: publication.published_at,
        posts: [{ asset_type: "published_post", platform: "example_video", platform_post_id: "abc123" }],
      }),
      true
    );
  });

  it("accepts optional evidence and rejects evidence without a url", () => {
    assert.equal(
      validatePublication({ ...publication, evidence: { url: "https://archive.example.com/c/1" } }),
      true
    );
    assert.equal(validatePublication({ ...publication, evidence: { notes: "no url" } }), false);
  });

  it("declares reportable statuses on reporting_capabilities", () => {
    const base = {
      available_reporting_frequencies: ["daily"],
      expected_delay_minutes: 60,
      timezone: "UTC",
      supports_webhooks: false,
      available_metrics: ["impressions", "spend"],
      date_range_support: "date_range",
      supports_installment_breakdown: true,
    };
    assert.equal(
      validateCapabilities({ ...base, available_installment_statuses: ["scheduled", "cancelled"] }),
      true
    );
    assert.equal(
      validateCapabilities({ ...base, available_installment_statuses: ["scheduled", "scheduled"] }),
      false
    );
    assert.equal(
      validateCapabilities({ ...base, available_installment_statuses: ["skipped"] }),
      false
    );
  });

  it("adds publication to the available-metric enum but not to the scalar aggregate ids", () => {
    assert.ok(readSchema("/schemas/enums/available-metric.json").enum.includes("publication"));
    const aggregate = readSchema("/schemas/core/delivery-metric-aggregate.json");
    const excluded = JSON.stringify(aggregate).match(/"not":\{"enum":\[([^\]]*)\]/);
    assert.ok(excluded, "metric_id exclusion list not found");
    assert.ok(excluded[1].includes('"print_metrics"'));
    assert.ok(excluded[1].includes('"publication"'));
  });

  it("does not put publication on delivery-metrics or installment-property rows", () => {
    assert.equal(readSchema("/schemas/core/delivery-metrics.json").properties.publication, undefined);
    const propertyRow = readSchema("/schemas/core/installment-property-delivery-metrics.json");
    const propertyProps = propertyRow.allOf.find((s) => s.properties).properties;
    assert.equal(propertyProps.installment_status, undefined);
    assert.equal(propertyProps.publication, undefined);
  });

  it("accepts installment_delivery rows on simulate_delivery", () => {
    const request = {
      scenario: "simulate_delivery",
      account: { sandbox: true },
      params: {
        media_buy_id: "mb_creator_1",
        installment_delivery: [
          {
            installment_ref,
            installment_status: "published",
            impressions: 0,
            views: 52000,
            spend: 8000,
            publication,
          },
          { installment_ref: { ...installment_ref, installment_id: "ep_2026_10_19" }, installment_status: "scheduled", spend: 0 },
        ],
      },
    };
    assert.equal(validateController(request), true, JSON.stringify(validateController.errors));
    request.params.installment_delivery = [];
    assert.equal(validateController(request), false);
    request.params.installment_delivery = [{ installment_ref, impressions: 1 }];
    assert.equal(validateController(request), false);
  });
});
