const fs = require("fs");
const path = require("path");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

const SCHEMA_ROOT = path.join(__dirname, "..", "static", "schemas", "source");

function readSchema(uri) {
  assert.match(uri, /^\/schemas\//);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice(9)), "utf8"));
}

function hasConsistentInventoryIdentity(row) {
  if (row.placement_identity?.placement_id !== undefined &&
      row.placement_identity.placement_id !== row.placement_id) return false;
  if (row.placement_identity?.kind === "publisher_ref" &&
      row.publisher_domain !== undefined &&
      row.placement_identity.publisher_domain !== row.publisher_domain) return false;
  if (row.property_ref?.publisher_domain !== undefined &&
      row.property_ref.publisher_domain !== row.publisher_domain) return false;
  return true;
}

async function compile(schema) {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async ref => readSchema(ref) });
  addFormats(ajv);
  return ajv.compileAsync(schema);
}

describe("canonical inventory delivery reporting", () => {
  let validateRequest;
  let validatePlacementRef;
  let validatePlacement;
  let validatePlacementIdentity;
  let validateCanonicalPlacement;
  let validatePlacementSelection;
  let validatePlacementRow;
  let validatePropertyRow;
  let validateCollectionRow;
  let validateInstallmentRow;
  let validateIntersectionRow;
  let validatePlacementPropertyRow;

  before(async () => {
    const response = readSchema("/schemas/media-buy/get-media-buy-delivery-response.json");
    const extension = response.properties.media_buy_deliveries.items.properties.by_package.items.allOf
      .find(schema => schema.properties);
    [
      validateRequest,
      validatePlacementRef,
      validatePlacement,
      validatePlacementIdentity,
      validateCanonicalPlacement,
      validatePlacementSelection,
      validatePlacementRow,
      validatePropertyRow,
      validateCollectionRow,
      validateInstallmentRow,
      validateIntersectionRow,
      validatePlacementPropertyRow,
    ] = await Promise.all([
      compile(readSchema("/schemas/media-buy/get-media-buy-delivery-request.json")),
      compile(readSchema("/schemas/core/placement-ref.json")),
      compile(readSchema("/schemas/core/placement.json")),
      compile(readSchema("/schemas/core/placement-identity.json")),
      compile(readSchema("/schemas/core/canonical-placement.json")),
      compile(readSchema("/schemas/core/placement-selection.json")),
      compile(extension.properties.by_placement.items),
      compile(extension.properties.by_property.items),
      compile(extension.properties.by_collection.items),
      compile(extension.properties.by_installment.items),
      compile(extension.properties.by_collection_property.items),
      compile(extension.properties.by_placement_property.items),
    ]);
  });

  it("preserves legacy placement shapes while canonical identities name their authority", () => {
    assert.equal(validatePlacementRef({ publisher_domain: "publisher.example", placement_id: "pre_roll" }), true);
    assert.equal(validatePlacementRef({ placement_id: "pre_roll" }), true);
    assert.equal(validatePlacement({
      kind: "seller_inline",
      placement_id: "pre_roll",
      name: "Pre-roll",
      mode: "targetable",
    }), true, JSON.stringify(validatePlacement.errors));
    assert.equal(validatePlacementIdentity({
      kind: "publisher_ref",
      publisher_domain: "publisher.example",
      placement_id: "pre_roll",
    }), true, JSON.stringify(validatePlacementIdentity.errors));
    assert.equal(validatePlacementIdentity({
      kind: "seller_inline",
      seller_agent: { agent_url: "https://seller.example/adcp" },
      placement_id: "pre_roll",
    }), true, JSON.stringify(validatePlacementIdentity.errors));
    assert.equal(validatePlacementIdentity({
      kind: "seller_inline",
      publisher_domain: "publisher.example",
      placement_id: "pre_roll",
    }), false);
    assert.equal(validateCanonicalPlacement({
      kind: "seller_inline",
      seller_agent: { agent_url: "https://seller.example/adcp" },
      placement_id: "pre_roll",
      name: "Pre-roll",
      mode: "targetable",
    }), true, JSON.stringify(validateCanonicalPlacement.errors));
    assert.equal(validateCanonicalPlacement({
      kind: "seller_inline",
      publisher_domain: "publisher.example",
      placement_id: "pre_roll",
      name: "Pre-roll",
      mode: "targetable",
    }), false);
    assert.equal(validateCanonicalPlacement({
      kind: "publisher_ref",
      publisher_domain: "publisher.example",
      seller_agent: { agent_url: "https://seller.example/adcp" },
      placement_id: "pre_roll",
      mode: "targetable",
    }), false);
  });

  it("selects publisher and seller placements with the authority-discriminated identity", () => {
    assert.equal(validatePlacementSelection({
      mode: "selected",
      placement_refs: [{ publisher_domain: "publisher.example", placement_id: "pre_roll" }],
    }), true, JSON.stringify(validatePlacementSelection.errors));
    assert.equal(validatePlacementSelection({
      mode: "selected",
      placement_refs: [{
        kind: "publisher_ref",
        publisher_domain: "publisher.example",
        placement_id: "pre_roll",
      }],
    }), true, JSON.stringify(validatePlacementSelection.errors));
    assert.equal(validatePlacementSelection({
      mode: "selected",
      placement_refs: [{
        kind: "seller_inline",
        seller_agent: { agent_url: "https://seller.example/adcp" },
        placement_id: "pre_roll",
      }],
    }), true, JSON.stringify(validatePlacementSelection.errors));
    assert.equal(validatePlacementSelection({
      mode: "selected",
      placement_refs: [{ kind: "seller_inline", placement_id: "pre_roll" }],
    }), false);
  });

  it("adds self-contained placement identity without invalidating legacy rows", () => {
    const canonical = {
      placement_id: "pre_roll",
      placement_identity: {
        kind: "publisher_ref",
        publisher_domain: "publisher.example",
        placement_id: "pre_roll",
      },
      placement_name: "Pre-roll",
      impressions: 100,
      spend: 25,
    };
    assert.equal(validatePlacementRow(canonical), true, JSON.stringify(validatePlacementRow.errors));
    assert.equal(validatePlacementRow({ placement_id: "pre_roll", impressions: 100, spend: 25 }), true);
    const contradictory = {
      ...canonical,
      placement_identity: { ...canonical.placement_identity, placement_id: "mid_roll" },
    };
    assert.equal(validatePlacementRow(contradictory), true, "JSON Schema cannot compare sibling values");
    assert.equal(hasConsistentInventoryIdentity(contradictory), false);
    assert.match(
      readSchema("/schemas/core/placement-delivery-metrics.json")["x-adcp-validation"]
        .verifier_constraints.placement_id_consistency,
      /MUST equal/
    );
  });

  it("accepts property, collection, installment, and collection-property rows", () => {
    const property_ref = { publisher_domain: "streaming.example", property_id: "living_room_app" };
    const identifier = { type: "bundle_id", value: "com.streaming.livingroom" };
    const collection_ref = { publisher_domain: "studio.example", collection_id: "nightly_script" };
    assert.equal(validatePropertyRow({ publisher_domain: "streaming.example", identifier, property_ref, impressions: 60, spend: 12 }), true, JSON.stringify(validatePropertyRow.errors));
    assert.equal(validatePropertyRow({ publisher_domain: "streaming.example", identifier, impressions: 60, spend: 12 }), true, JSON.stringify(validatePropertyRow.errors));
    assert.equal(validatePropertyRow({ identifier, impressions: 60, spend: 12 }), false);
    assert.equal(hasConsistentInventoryIdentity({
      publisher_domain: "other.example",
      property_ref,
    }), false);
    assert.equal(validateCollectionRow({ collection_ref, impressions: 60, spend: 12 }), true, JSON.stringify(validateCollectionRow.errors));
    assert.equal(validateInstallmentRow({
      installment_ref: { collection_ref, installment_id: "episode_42" },
      impressions: 60,
      spend: 12,
    }), true, JSON.stringify(validateInstallmentRow.errors));
    assert.equal(validateIntersectionRow({ collection_ref, publisher_domain: "streaming.example", identifier, property_ref, impressions: 60, spend: 12 }), true, JSON.stringify(validateIntersectionRow.errors));
    assert.equal(validateIntersectionRow({ collection_ref, publisher_domain: "streaming.example", property_ref, impressions: 60, spend: 12 }), false);
    assert.equal(validatePlacementPropertyRow({
      placement_id: "feed",
      placement_identity: {
        kind: "publisher_ref",
        publisher_domain: "streaming.example",
        placement_id: "feed",
      },
      publisher_domain: "streaming.example",
      identifier,
      property_ref,
      impressions: 60,
      spend: 12,
    }), true, JSON.stringify(validatePlacementPropertyRow.errors));
    assert.equal(validatePlacementPropertyRow({
      placement_id: "feed",
      publisher_domain: "streaming.example",
      identifier,
      impressions: 60,
      spend: 12,
    }), false);
  });

  it("declares all inventory dimensions and validates their controls", () => {
    for (const dimension of ["placement", "property", "collection", "installment", "collection_property", "placement_property"]) {
      assert.equal(validateRequest({ reporting_dimensions: { [dimension]: { limit: 10, sort_by: "impressions" } } }), true, dimension);
      assert.equal(validateRequest({ reporting_dimensions: { [dimension]: { limit: 0 } } }), false, dimension);
    }
  });

  it("advertises all inventory dimensions on both capability surfaces", () => {
    for (const uri of [
      "/schemas/core/reporting-capabilities.json",
      "/schemas/core/canonical-reporting-capabilities.json",
    ]) {
      const properties = readSchema(uri).properties;
      for (const capability of [
        "supports_placement_breakdown",
        "supports_property_breakdown",
        "supports_collection_breakdown",
        "supports_installment_breakdown",
        "supports_collection_property_breakdown",
        "supports_placement_property_breakdown",
      ]) {
        assert.equal(properties[capability].type, "boolean", `${uri} ${capability}`);
      }
      assert.equal(properties.property_breakdown_min_impressions.type, "integer", uri);
      assert.equal(properties.property_breakdown_min_impressions.minimum, 1, uri);
    }
  });

  it("discloses suppression separately for every property-grain breakdown", () => {
    const response = readSchema("/schemas/media-buy/get-media-buy-delivery-response.json");
    const properties = response.properties.media_buy_deliveries.items.properties.by_package.items.allOf
      .find(schema => schema.properties).properties;
    for (const dimension of ["property", "collection_property", "placement_property"]) {
      assert.equal(properties[`by_${dimension}_suppressed`].type, "boolean", dimension);
      assert.match(properties[`by_${dimension}_truncated`].description, /non-suppressed/);
    }
  });
});
