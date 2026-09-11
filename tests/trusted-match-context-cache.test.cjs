const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const specification = fs.readFileSync(
  path.join(__dirname, "..", "docs", "trusted-match", "specification.mdx"),
  "utf8"
);

test("Context Match caching partitions every result-affecting request", () => {
  assert.match(specification, /\{provider_id, context_hash\}/);
  assert.doesNotMatch(
    specification,
    /recommended cache key is `\{property_rid, placement_id, provider_id\}`/
  );
  assert.match(specification, /Remove `\$schema`/);
  assert.match(specification, /and `request_id`/);
  assert.match(specification, /RFC 8785 JCS/);
  assert.match(specification, /Array order is preserved/);
  assert.match(
    specification,
    /MUST set the returned response's `request_id` to the current request's `request_id`/
  );
  assert.match(
    specification,
    /`context_hash` and any retained hash preimage MUST NOT appear in logs, metric labels, or traces/
  );
  assert.match(
    specification,
    /MAY prefix `context_hash` with `property_rid` for cache-store sharding/
  );
  assert.match(specification, /`cache_ttl: 0` is appropriate for those placements/);
});
