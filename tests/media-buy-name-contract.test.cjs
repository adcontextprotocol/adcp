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
});
