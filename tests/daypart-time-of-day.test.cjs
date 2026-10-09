/**
 * Minute-resolution daypart windows (#6707): start_time/end_time beside the
 * whole-hour fields, exclusive with them, plus the product-scoped
 * time_granularity declaration and buyer requirement.
 */
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const SCHEMA_ROOT = path.join(__dirname, "..", "static", "schemas", "source");

async function loadSchema(uri) {
  const filename = path.resolve(SCHEMA_ROOT, uri.slice("/schemas/".length));
  if (!filename.startsWith(`${SCHEMA_ROOT}${path.sep}`)) {
    throw new Error(`Schema path escape: ${uri}`);
  }
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

async function compile(uri) {
  const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true, loadSchema });
  addFormats(ajv);
  return ajv.compileAsync(await loadSchema(uri));
}

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday"];

test("daypart entries carry exactly one of the hour or clock-time forms", async () => {
  const validate = await compile("/schemas/core/daypart-target.json");

  const valid = [
    { days: WEEKDAYS, start_hour: 9, end_hour: 11 },
    { days: WEEKDAYS, start_hour: 0, end_hour: 24, timezone: "inventory_local" },
    // "19:30–23:00 Mon–Fri local" (Dutch linear TV pilot)
    { days: WEEKDAYS, start_time: "19:30", end_time: "23:00", timezone: "Europe/Amsterdam" },
    { days: WEEKDAYS, start_time: "20:28", end_time: "20:31" },
    // Overnight: end earlier than start crosses midnight
    { days: ["friday", "saturday"], start_time: "22:00", end_time: "02:00", label: "Late fringe" },
    { days: ["sunday"], start_time: "23:15", end_time: "00:00" },
    { days: ["monday"], start_time: "00:00", end_time: "06:00" },
  ];
  for (const daypart of valid) {
    assert.equal(validate(daypart), true, JSON.stringify(daypart));
  }

  const invalid = [
    ["neither form", { days: WEEKDAYS }],
    ["hour start only", { days: WEEKDAYS, start_hour: 9 }],
    ["time start only", { days: WEEKDAYS, start_time: "19:30" }],
    ["time end only", { days: WEEKDAYS, end_time: "23:00" }],
    ["both forms", { days: WEEKDAYS, start_hour: 19, end_hour: 23, start_time: "19:30", end_time: "23:00" }],
    ["hour start with time end", { days: WEEKDAYS, start_hour: 19, end_time: "23:00" }],
    ["time start with hour end", { days: WEEKDAYS, start_time: "19:30", end_hour: 23 }],
    ["complete time form plus stray hour", { days: WEEKDAYS, start_time: "19:30", end_time: "23:00", start_hour: 19 }],
    ["complete hour form plus stray time", { days: WEEKDAYS, start_hour: 19, end_hour: 23, end_time: "23:00" }],
    ["missing days", { start_time: "19:30", end_time: "23:00" }],
    ["unknown field", { days: WEEKDAYS, start_time: "19:30", end_time: "23:00", end_minute: 0 }],
  ];
  for (const [label, daypart] of invalid) {
    assert.equal(validate(daypart), false, label);
  }
});

test("equal clock times are schema-valid but a spec-level INVALID_REQUEST", async () => {
  // Draft-07 cannot compare two string properties; sellers enforce
  // end_time != start_time at request validation (see end_time description).
  const validate = await compile("/schemas/core/daypart-target.json");
  assert.equal(validate({ days: WEEKDAYS, start_time: "06:00", end_time: "06:00" }), true);
});

test("start_time and end_time are strict HH:MM 24-hour strings", async () => {
  const validate = await compile("/schemas/core/daypart-target.json");
  for (const value of ["00:00", "09:05", "19:30", "23:59"]) {
    assert.equal(
      validate({ days: WEEKDAYS, start_time: value, end_time: "12:00" }),
      true,
      value
    );
  }
  for (const value of [
    "24:00",
    "7:30",
    "19:3",
    "19:60",
    "25:00",
    "19:30:00",
    "1930",
    "19.30",
    " 19:30",
    "19:30\n",
    "7:30pm",
    "",
    1930,
    null,
  ]) {
    assert.equal(
      validate({ days: WEEKDAYS, start_time: value, end_time: "23:00" }),
      false,
      `start_time ${JSON.stringify(value)}`
    );
    assert.equal(
      validate({ days: WEEKDAYS, start_time: "19:30", end_time: value }),
      false,
      `end_time ${JSON.stringify(value)}`
    );
  }
});

test("clock-time daypart fields are experimental and documented as such", () => {
  const daypart = JSON.parse(
    fs.readFileSync(path.join(SCHEMA_ROOT, "core", "daypart-target.json"), "utf8")
  );
  for (const field of ["start_time", "end_time"]) {
    assert.equal(daypart.properties[field]["x-status"], "experimental", field);
    assert.equal(daypart.properties[field]["x-added-in"], "3.3.0", field);
  }
  // The whole-hour fields stay stable and keep their original shape.
  assert.equal(daypart.properties.start_hour["x-status"], undefined);
  assert.equal(daypart.properties.end_hour["x-status"], undefined);
  assert.deepEqual(daypart.required, ["days"]);
  assert.match(daypart.properties.end_time.description, /crosses midnight/);
  assert.match(daypart.properties.end_time.description, /MUST NOT equal start_time/);
  assert.match(daypart.properties.start_time.description, /MUST reject, never round/);

  const granularity = JSON.parse(
    fs.readFileSync(path.join(SCHEMA_ROOT, "enums", "daypart-time-granularity.json"), "utf8")
  );
  assert.deepEqual(granularity.enum, ["hour", "quarter_hour", "minute"]);
  assert.equal(granularity["x-status"], "experimental");
});

test("targeting overlays accept both daypart forms side by side", async () => {
  const validateTargeting = await compile("/schemas/core/targeting.json");
  const validateInput = await compile("/schemas/core/targeting-input.json");
  const overlay = {
    daypart_targets: [
      { days: ["saturday"], start_hour: 6, end_hour: 10 },
      { days: WEEKDAYS, start_time: "19:30", end_time: "23:00", timezone: "inventory_local" },
    ],
  };
  assert.equal(validateTargeting(overlay), true, JSON.stringify(validateTargeting.errors));
  assert.equal(validateInput(overlay), true, JSON.stringify(validateInput.errors));
  assert.equal(
    validateTargeting({
      daypart_targets: [{ days: WEEKDAYS, start_hour: 19, end_hour: 23, start_time: "19:30", end_time: "23:00" }],
    }),
    false
  );
});

test("overlay support declares and requires time granularity", async () => {
  const validateSupport = await compile("/schemas/core/targeting-overlay-support.json");
  const validateRequirements = await compile("/schemas/core/targeting-overlay-requirements.json");

  for (const declaration of [
    { daypart_targets: true },
    { daypart_targets: { timezone_modes: ["inventory_local"] } },
    { daypart_targets: { timezone_modes: ["inventory_local"], time_granularity: "hour" } },
    { daypart_targets: { timezone_modes: ["inventory_local"], time_granularity: "quarter_hour" } },
    {
      daypart_targets: {
        timezone_modes: ["inventory_local", "iana"],
        iana_timezones: ["Europe/Amsterdam"],
        time_granularity: "minute",
      },
    },
  ]) {
    assert.equal(validateSupport(declaration), true, JSON.stringify(declaration));
  }
  for (const declaration of [
    { daypart_targets: { time_granularity: "minute" } },
    { daypart_targets: { timezone_modes: ["inventory_local"], time_granularity: "second" } },
    { daypart_targets: { timezone_modes: ["inventory_local"], time_granularity: "30_minute" } },
    { daypart_targets: { timezone_modes: ["inventory_local"], time_granularity: true } },
  ]) {
    assert.equal(validateSupport(declaration), false, JSON.stringify(declaration));
  }

  for (const requirement of [
    { daypart_targets: true },
    { daypart_targets: { timezone_modes: ["inventory_local"] } },
    { daypart_targets: { time_granularity: "quarter_hour" } },
    { daypart_targets: { timezone_modes: ["iana"], iana_timezones: ["Europe/Amsterdam"], time_granularity: "minute" } },
  ]) {
    assert.equal(validateRequirements(requirement), true, JSON.stringify(requirement));
  }
  for (const requirement of [
    { daypart_targets: {} },
    { daypart_targets: { ext: {} } },
    { daypart_targets: { iana_timezones: ["Europe/Amsterdam"] } },
    { daypart_targets: { iana_timezones: ["Europe/Amsterdam"], time_granularity: "minute" } },
    { daypart_targets: { timezone_modes: ["inventory_local"], iana_timezones: ["Europe/Amsterdam"] } },
    { daypart_targets: { time_granularity: "seconds" } },
  ]) {
    assert.equal(validateRequirements(requirement), false, JSON.stringify(requirement));
  }
});
