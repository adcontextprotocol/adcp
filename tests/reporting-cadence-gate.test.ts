import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const ROOT = join(__dirname, "..");

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

test("reporting cadence gates optimization eligibility (MUST, 3.2)", () => {
  const enumSchema = JSON.parse(
    read("static/schemas/source/enums/reporting-frequency.json")
  );

  // The measured-channel cadences the gate is defined over.
  for (const value of ["weekly", "quarterly", "post_campaign"]) {
    expect(enumSchema.enum).toContain(value);
  }

  // The normative sentence lives on the enum description — MUST-level, both
  // halves (gate + prohibition), naming the gated cadences.
  expect(enumSchema.description).toMatch(/MUST treat/);
  expect(enumSchema.description).toMatch(/MUST NOT/);
  expect(enumSchema.description).toMatch(/optimization-eligibility gate/);
  expect(enumSchema.description).toMatch(/quarterly or post_campaign/);

  // The governing doc carries the same rule against the real wire field, and
  // routes enforcement to buyer-artifact grading rather than seller conduct.
  const doc = read("docs/media-buy/media-buys/optimization-reporting.mdx");
  expect(doc).toMatch(/Cadence gates optimization eligibility/);
  expect(doc).toMatch(/available_reporting_frequencies/);
  expect(doc).toMatch(/MUST NOT make mid-flight optimization decisions/);
  expect(doc).toMatch(/`quarterly` or `post_campaign`/);
  expect(doc).toMatch(/buyer-artifact testing/);

  // The obligation is the buyer's; the doc must not drift into a field name
  // that does not exist on the wire.
  expect(doc).not.toMatch(/reporting_capabilities\.reporting_frequencies/);
});
