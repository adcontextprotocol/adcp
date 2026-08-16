const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { runValidations } = require("@adcp/sdk/testing");

const ROOT = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("portfolio routing scope is authoritative when present and advisory in 3.2", () => {
  const capabilities = JSON.parse(
    read("static/schemas/source/protocol/get-adcp-capabilities-response.json")
  );
  const portfolio = capabilities.properties.media_buy.properties.portfolio;
  for (const field of ["primary_channels", "primary_countries"]) {
    assert.match(portfolio.properties[field].description, /exhaustive/i, field);
    assert.equal(portfolio.properties[field].minItems, undefined, field);
    assert.equal(portfolio.properties[field].uniqueItems, undefined, field);
  }
  assert.match(portfolio.description, /omitted.*unknown/is);
  assert.match(portfolio.description, /MUST NOT be interpreted as global/i);
  assert.equal(portfolio.properties.primary_countries.items.type, "string");
  assert.equal(
    portfolio.properties.primary_countries.items.pattern,
    "^[A-Z]{2}$"
  );

  const scenario = read(
    "static/compliance/source/protocols/media-buy/scenarios/portfolio_routing_scope.yaml"
  );
  assert.match(scenario, /introduced_in: "3\.2"/);
  assert.equal((scenario.match(/severity: advisory/g) || []).length, 4);
  assert.equal((scenario.match(/permanent_advisory:/g) || []).length, 4);
  assert.match(scenario, /task: get_products/);
  assert.match(scenario, /products\[\*\]\.channels\[\*\]/);
  assert.match(scenario, /check: all_fields_in_context_array/);
  assert.doesNotMatch(scenario, /targeting_overlay:\s*\n\s*geo_countries/);
  assert.equal((scenario.match(/depends_on: \[\]/g) || []).length, 1);
  assert.equal(
    (scenario.match(/check: field_present\n\s+path: "products"/g) || []).length,
    1
  );

  const [legacyRunnerResult] = runValidations(
    [
      {
        check: "all_fields_in_context_array",
        path: "products[*].channels[*]",
        context_key: "portfolio_channels",
        description: "Every product channel stays within declared scope",
      },
    ],
    {
      taskName: "get_products",
      taskResult: {
        success: true,
        data: { products: [{ channels: ["display"] }] },
      },
      agentUrl: "https://seller.example",
      contributions: new Set(),
      storyboardContext: { portfolio_channels: ["display"] },
    }
  );
  assert.equal(legacyRunnerResult.passed, true);
  assert.equal(
    legacyRunnerResult.not_applicable,
    true,
    "pre-implementation SDKs must skip the additive check, not false-fail it"
  );
});
