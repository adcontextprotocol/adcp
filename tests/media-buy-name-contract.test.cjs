const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const Ajv = require("ajv");

const SCHEMA_BASE_DIR = path.join(
  __dirname,
  "..",
  "static",
  "schemas",
  "source"
);

function load(relativePath) {
  return JSON.parse(
    fs.readFileSync(path.join(SCHEMA_BASE_DIR, relativePath), "utf8")
  );
}

function successProperties(relativePath, title) {
  const schema = load(relativePath);
  return schema.oneOf.find((branch) => branch.title === title).properties;
}

const surfaces = [
  {
    label: "core MediaBuy",
    field: load("core/media-buy.json").properties.name,
    obligation: /MUST include the persisted name/,
  },
  {
    label: "create request",
    field: load("media-buy/create-media-buy-request.json").properties.name,
    obligation: /MUST persist it and echo it unchanged/,
  },
  {
    label: "update request",
    field: load("media-buy/update-media-buy-request.json").properties.name,
    obligation: /SHOULD echo the prior unchanged value/,
  },
  {
    label: "create success",
    field: successProperties(
      "media-buy/create-media-buy-response.json",
      "CreateMediaBuySuccess"
    ).name,
    obligation: /MUST echo it unchanged/,
  },
  {
    label: "update success",
    field: successProperties(
      "media-buy/update-media-buy-response.json",
      "UpdateMediaBuySuccess"
    ).name,
    obligation: /MUST return the stored value/,
  },
  {
    label: "get_media_buys item",
    field: load("media-buy/get-media-buys-response.json").properties.media_buys
      .items.properties.name,
    obligation: /MUST include name/,
  },
  {
    label: "buy_products request",
    field: load("media-buy/buy-products-request.json").properties.name,
    obligation: /MUST persist it and echo it unchanged/,
  },
  {
    label: "accept_proposal request",
    field: load("media-buy/accept-proposal-request.json").properties.name,
    obligation: /MUST persist it and echo it unchanged/,
  },
  {
    label: "media buy commitment response",
    field: successProperties(
      "media-buy/media-buy-commitment-response.json",
      "Committed Media Buy"
    ).name,
    obligation: /MUST return the stored value/,
  },
];

describe("media-buy name contract", () => {
  it("declares the same bounded display label on every write and read surface", () => {
    const ajv = new Ajv({ strict: false });
    for (const { label, field } of surfaces) {
      assert.equal(field.type, "string", `${label} name must be a string`);
      assert.equal(
        field.maxLength,
        255,
        `${label} name must use the shared 255-character limit`
      );

      const validate = ajv.compile(field);
      assert.equal(
        validate("A".repeat(255)),
        true,
        `${label} must accept a 255-character name`
      );
      assert.equal(
        validate("A".repeat(256)),
        false,
        `${label} must reject a 256-character name`
      );
      assert.equal(validate(""), false, `${label} must reject an empty name`);
      assert.equal(
        validate(" \t\n "),
        false,
        `${label} must reject a whitespace-only name`
      );
    }
  });

  it("keeps persistence and readback obligations normative", () => {
    for (const { label, field, obligation } of surfaces) {
      assert.match(
        field.description,
        obligation,
        `${label} lost its name persistence obligation`
      );
      assert.match(
        field.description,
        /not an identifier or financial reference/i,
        `${label} must distinguish the display label from identity and finance fields`
      );
    }
  });

  it("scopes accept_proposal's name outside the terms digest and states proposal-seeding precedence", () => {
    const field = load("media-buy/accept-proposal-request.json").properties
      .name;
    assert.match(
      field.description,
      /not a covered component of proposal_terms_digest/,
      "accept_proposal name must be explicitly excluded from the terms digest"
    );
    assert.match(
      field.description,
      /sellers MAY seed the MediaBuy name from the accepted proposal's own name/,
      "accept_proposal name must state the proposal-seeded fallback"
    );
  });
});
