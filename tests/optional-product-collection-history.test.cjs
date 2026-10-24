"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { execute, READ } = require("./optional-product-collections.test.cjs");

for (const name of READ) {
  for (const mode of [
    "valid",
    "probe_error",
    "schema_error",
    "malformed_modes",
    "fail_once",
  ]) {
    test(`${name}: ${mode} cannot bypass any required committed comparand`, async () => {
      for (const key of [
        "collection_media_buy_id",
        "collection_package_id",
        "collection_committed_product_id",
        "collection_committed_selectors",
        "catalog_collection_commitment_proof",
      ]) {
        const { error, calls, created } = await execute(name, {
          standalone: true,
          stepId: "read_selection",
          readProfileMode: mode,
          expectLocalError: true,
          priorContextTransform: (context) => {
            delete context[key];
          },
        });
        assert.equal(
          created.passed,
          true,
          "real prior create is the positive control",
        );
        assert.match(
          error?.message ?? "",
          /requires (trusted prior|verified successful-create)/,
          key,
        );
        assert.equal(
          calls.some((c) => c.task === "get_media_buys"),
          false,
          key,
        );
      }
    });
    test(`${name}: ${mode} retains native execution with verified history`, async () => {
      const { result, calls, error } = await execute(name, {
        standalone: true,
        stepId: "read_selection",
        readProfileMode: mode,
        expectLocalError: true,
      });
      assert.equal(error, undefined);
      if (mode === "valid" || mode === "fail_once") {
        assert.equal(result.passed, true, JSON.stringify(result));
        assert.equal(
          calls.some((c) => c.task === "get_media_buys"),
          true,
        );
      } else {
        // Delegate malformed/failed supplied discovery unchanged. It may grade
        // discovery failure or recover; never fabricate a local seller grade.
        assert.ok(result && typeof result.passed === "boolean");
      }
    });
  }
  test(`${name}: actual failed-create captures cannot authorize a standalone read`, async () => {
    const { error, calls, created } = await execute(name, {
      standalone: true,
      stepId: "read_selection",
      broken: "domain",
      continueFailedCreate: true,
      expectLocalError: true,
    });
    assert.equal(created.passed, false);
    assert.ok(
      created.validations.some(
        (v) => v.check === "collection_set_equals_context" && !v.passed,
      ),
    );
    assert.ok(
      created.context.collection_media_buy_id,
      "retain raw captured evidence",
    );
    assert.ok(created.response, "retain ordinary failed response evidence");
    assert.equal(
      created.context.catalog_collection_commitment_proof,
      undefined,
    );
    assert.match(error?.message ?? "", /requires verified successful-create/);
    assert.equal(
      calls.some((c) => c.task === "get_media_buys"),
      false,
    );
  });
  test(`${name}: retargeting a valid prior commitment fails before read`, async () => {
    for (const key of [
      "collection_media_buy_id",
      "collection_package_id",
      "collection_committed_product_id",
      "collection_committed_selectors",
      "catalog_collection_commitment_proof",
    ]) {
      const { error, calls } = await execute(name, {
        standalone: true,
        stepId: "read_selection",
        expectLocalError: true,
        priorContextTransform: (context) => {
          context[key] = key.endsWith("selectors")
            ? [
                {
                  publisher_domain: "wrong.example",
                  collection_ids: ["foreign"],
                },
              ]
            : key.endsWith("proof")
              ? "0".repeat(64)
              : "foreign";
        },
      });
      assert.match(error?.message ?? "", /requires verified successful-create/);
      assert.equal(
        calls.some((c) => c.task === "get_media_buys"),
        false,
      );
    }
  });
  test(`${name}: ordinary caller booleans and complete unissued context are not provenance`, async () => {
    const { error, calls } = await execute(name, {
      standalone: true,
      stepId: "read_selection",
      skipPriorCreate: true,
      expectLocalError: true,
      context: {
        collection_media_buy_id: "buy",
        collection_package_id: "pkg",
        collection_committed_product_id: "native-product",
        collection_committed_selectors: [
          { publisher_domain: "studio.example", collection_ids: ["episode-a"] },
        ],
        create_passed: true,
        catalog_collection_commitment_proof: "0".repeat(64),
      },
    });
    assert.match(error?.message ?? "", /requires verified successful-create/);
    assert.equal(calls.length, 0);
  });
}

for (const name of READ) {
  for (const changed of ["seller", "storyboard", "account", "version"]) {
    test(`${name}: a commitment cannot be replayed into a different ${changed}`, async () => {
      const { error, calls } = await execute(name, {
        standalone: true,
        stepId: "read_selection",
        expectLocalError: true,
        ...(changed === "seller" && {
          readAgentUrl: "https://other-controlled-seller.example/mcp",
        }),
        priorRunTransform: ({ doc, options }) => {
          if (changed === "storyboard") doc.title += " changed";
          if (changed === "account")
            doc.context.sandbox_account.operator = "different-operator.example";
          if (changed === "version") options.adcpVersion = "3.2.4";
        },
      });
      assert.match(error?.message ?? "", /requires verified successful-create/);
      assert.equal(
        calls.some((c) => c.task === "get_media_buys"),
        false,
      );
    });
  }
}

for (const name of READ) {
  test(`${name}: protected caller metadata retains the SDK typed denial and private audit`, async () => {
    for (const map of [
      "context",
      "context_provenance",
      "response_derived_not_applicable_context_keys",
    ]) {
      const audits = [];
      const { error, http } = await execute(name, {
        standalone: true,
        stepId: "read_selection",
        skipPriorCreate: true,
        expectLocalError: true,
        overrides: {
          [map]: { __adcp_fixture_forged: "controlled" },
          prepared_fixtures_audit_sink: (record) => {
            audits.push(record);
          },
        },
      });
      // Production imports public ESM; CJS/ESM class identities are distinct.
      const { PreparedFixturesDeniedError } = await import("@adcp/sdk/testing");
      assert.ok(error instanceof PreparedFixturesDeniedError, map);
      assert.equal(error.code, "PREPARED_FIXTURES_DENIED");
      assert.equal(error.refusalCode, "unauthorized_metadata");
      assert.equal(http.length, 0);
      assert.equal(audits.length, 1);
    }
  });
}
