---
"adcontextprotocol": patch
---

Open the 3.2 capability blocks and containers that 3.3 extends, as corrections under DR-0036.

3.2 published these schemas with `additionalProperties: false`. DR-0019 keeps capability blocks and container objects open, and calls a class B row without an escape hatch a defect. These locations now set `additionalProperties: true`:

- `core/daypart-target.json`. Its root `oneOf` still rejects a window that mixes `start_hour`/`end_hour` with `start_time`/`end_time`.
- `core/targeting-overlay-requirements.json`, with its structured daypart requirement and demographics requirement branches.
- The structured daypart support branch of `core/targeting-overlay-support.json`.
- `core/spot-reporting-capability.json` and `core/canonical-reporting-capabilities.json`.

Every payload that was valid stays valid. The 3.3 fields on these schemas go only to 3.3 peers, because a strict 3.2 validator still rejects them. No 3.2.x patch opens them.


The `assign` branch of `sync_creatives` `assignment_operations[]` stays closed. A named exception under DR-0036 lets it take `trackers` and `landing_page_url`, which require `creative.supports_assignment_trackers` and `creative.supports_assignment_landing_page`. It still rejects any other property.
