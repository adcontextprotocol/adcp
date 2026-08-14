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
    fs.readFileSync(
      path.join(SCHEMA_ROOT, uri.slice("/schemas/".length)),
      "utf8"
    )
  );
}

async function compile(uri) {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    discriminator: true,
    loadSchema: async (ref) => readSchema(ref),
  });
  addFormats(ajv);
  return ajv.compileAsync(readSchema(uri));
}

describe("compact performance feedback and measurement-agent discovery", () => {
  let validateRequest;
  let validateResponse;
  let validateCapabilities;
  let validateStoredRecord;

  before(async () => {
    [validateRequest, validateResponse, validateCapabilities, validateStoredRecord] =
      await Promise.all([
        compile("/schemas/media-buy/provide-performance-feedback-request.json"),
        compile(
          "/schemas/media-buy/provide-performance-feedback-response.json"
        ),
        compile("/schemas/protocol/get-adcp-capabilities-response.json"),
        compile("/schemas/core/performance-feedback.json"),
      ]);
  });

  it("preserves the legacy single-assertion request", () => {
    assert.equal(
      validateRequest({
        idempotency_key: "legacy-feedback-request-001",
        media_buy_id: "mb_legacy",
        measurement_period: {
          start: "2026-07-01T00:00:00Z",
          end: "2026-07-31T23:59:59Z",
        },
        performance_index: 1.1,
        metric_type: "conversion_rate",
        feedback_source: "buyer_attribution",
      }),
      true,
      JSON.stringify(validateRequest.errors)
    );
  });

  it("preserves the published stored record and separates compact assertions", () => {
    const storedRecord = readSchema("/schemas/core/performance-feedback.json");
    const assertion = readSchema(
      "/schemas/core/performance-feedback-assertion.json"
    );

    for (const field of [
      "feedback_id",
      "media_buy_id",
      "measurement_period",
      "performance_index",
      "feedback_source",
      "status",
      "submitted_at",
    ]) {
      assert.equal(storedRecord.required.includes(field), true, field);
    }

    assert.deepEqual(assertion.required, [
      "media_buy_id",
      "measurement_period",
      "performance_index",
    ]);
    for (const receiverOwnedField of [
      "feedback_id",
      "status",
      "submitted_at",
      "applied_at",
    ]) {
      assert.equal(
        Object.hasOwn(assertion.properties, receiverOwnedField),
        false,
        receiverOwnedField
      );
    }

    assert.equal(
      validateStoredRecord({
        feedback_id: "",
        media_buy_id: "",
        package_id: "",
        creative_id: "",
        measurement_period: {
          start: "2026-07-01T00:00:00Z",
          end: "2026-07-31T23:59:59Z",
        },
        performance_index: 1,
        feedback_source: "buyer_attribution",
        status: "accepted",
        submitted_at: "2026-08-01T00:00:00Z",
      }),
      true,
      JSON.stringify(validateStoredRecord.errors)
    );
  });

  it("accepts compact measurement-provider feedback with evidence and provenance", () => {
    assert.equal(
      validateRequest({
        idempotency_key: "measurement-study-42-july-final",
        media_buy_id: "mb_123",
        package_id: "pkg_video",
        measurement_period: {
          start: "2026-07-01T00:00:00Z",
          end: "2026-07-31T23:59:59Z",
        },
        metric: {
          scope: "vendor",
          vendor: { domain: "measurement.example" },
          metric_id: "incremental_revenue_index",
        },
        performance_index: 1.35,
        baseline: "control_group",
        producer: { domain: "measurement.example" },
        methodology: "geo_incrementality",
        methodology_version: "2026-08",
        study_ref: "study_42",
        evidence: {
          sample_size: 14820,
          confidence_interval: { lower: 1.18, upper: 1.49, level: 0.95 },
        },
        evidence_ref: "https://measurement.example/results/study_42",
        as_of: "2026-08-04T12:00:00Z",
        final: true,
      }),
      true,
      JSON.stringify(validateRequest.errors)
    );
  });

  it("rejects malformed metric identity and unknown baseline values", () => {
    const base = {
      idempotency_key: "measurement-study-42-invalid",
      media_buy_id: "mb_123",
      measurement_period: {
        start: "2026-07-01T00:00:00Z",
        end: "2026-07-31T23:59:59Z",
      },
      performance_index: 1.35,
    };

    assert.equal(
      validateRequest({
        ...base,
        baseline: "seller_randomized_secret_scale",
      }),
      false
    );

    assert.equal(
      validateRequest({
        ...base,
        baseline: "control_group",
        metric: { scope: "vendor", metric_id: "incremental_revenue_index" },
      }),
      false
    );
  });

  it("accepts seller receipts with honest application disposition", () => {
    assert.equal(
      validateResponse({
        status: "completed",
        success: true,
        feedback_id: "fb_01J5Y5KQ2T8B2M8P0A4E6R3C9D",
        application_status: "not_applied",
        status_reason: "The package ended before the next optimization cycle.",
        received_at: "2026-08-04T12:00:02Z",
      }),
      true,
      JSON.stringify(validateResponse.errors)
    );

    for (const invalidReceipt of [
      {
        status: "completed",
        success: true,
        application_status: "applied",
      },
      {
        status: "completed",
        success: true,
        application_status: "accepted",
        applied_at: "2026-08-04T12:00:02Z",
      },
      {
        status: "completed",
        success: true,
        application_status: "not_applied",
      },
    ]) {
      assert.equal(validateResponse(invalidReceipt), false);
    }
  });

  it("defines performance index direction for lower-is-better metrics", () => {
    assert.equal(
      validateRequest({
        idempotency_key: "lower-cost-feedback-001",
        media_buy_id: "mb_123",
        measurement_period: {
          start: "2026-07-01T00:00:00Z",
          end: "2026-07-31T23:59:59Z",
        },
        metric: { scope: "standard", metric_id: "cost_per_acquisition" },
        baseline: "campaign_target",
        performance_index: 1.25,
      }),
      true,
      JSON.stringify(validateRequest.errors)
    );
  });

  it("advertises the provider, orchestrator gateway, and seller roles separately", () => {
    const base = {
      status: "completed",
      adcp: {
        major_versions: [3],
        supported_versions: ["3.2"],
        idempotency: { supported: true, replay_ttl_seconds: 86400 },
      },
      account: {
        supported_billing: ["operator"],
        supported_account_currency_modes: ["fixed", "per_media_buy"],
      },
    };

    for (const capabilities of [
      {
        ...base,
        supported_protocols: ["measurement"],
        experimental_features: ["measurement.core"],
        measurement: {
          produces_performance_feedback: true,
          metrics: [{ metric_id: "incremental_revenue_index", unit: "index" }],
        },
      },
      {
        ...base,
        supported_protocols: ["measurement"],
        experimental_features: ["measurement.gateway"],
        measurement_gateway: {
          delivery_task: "get_media_buy_delivery",
          feedback_task: "provide_performance_feedback",
        },
      },
      {
        ...base,
        supported_protocols: ["media_buy"],
        experimental_features: ["measurement.core"],
        media_buy: {
          performance_feedback: {
            reports_application_status: true,
          },
        },
      },
    ]) {
      assert.equal(
        validateCapabilities(capabilities),
        true,
        JSON.stringify(validateCapabilities.errors)
      );
    }

    for (const invalidCapabilities of [
      {
        ...base,
        supported_protocols: ["measurement"],
        measurement: {
          produces_performance_feedback: true,
          metrics: [{ metric_id: "incremental_revenue_index", unit: "index" }],
        },
      },
      {
        ...base,
        supported_protocols: ["measurement"],
        experimental_features: ["measurement.gateway"],
        measurement_gateway: {
          delivery_task: "get_media_buy_delivery",
          feedback_task: "custom_feedback_webhook",
        },
      },
      {
        ...base,
        supported_protocols: ["measurement"],
        experimental_features: ["measurement.core"],
        measurement_gateway: {
          delivery_task: "get_media_buy_delivery",
          feedback_task: "provide_performance_feedback",
        },
      },
      {
        ...base,
        supported_protocols: ["media_buy"],
        media_buy: {
          performance_feedback: {
            reports_application_status: true,
          },
        },
      },
    ]) {
      assert.equal(validateCapabilities(invalidCapabilities), false);
    }
  });
});
