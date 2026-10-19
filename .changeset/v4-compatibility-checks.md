---
"adcontextprotocol": patch
---

compliance: add advisory AdCP 4.0 compatibility checks so 3.x agents learn what 4.0 removes or tightens before it ships (#8332).

- New registry `universal/v4-compatibility.yaml` lists each 4.0 check with a stable id, tracking issue, detection rule, fix, and the validation or runner notice that observes it. A report joins run output against it to show each check as passed, failing, or not observable.
- New authored check kind `all_fields_present`: every item of an array carries a field. An absent or empty array grades not_applicable instead of passing vacuously.
- `media_buy_seller` product discovery adds the advisory check `format_ids_removed_in_4_0` (every product declares `format_options`). `version_negotiation` tags its existing `supported_versions` and `adcp_version` echo validations as `major_versions_removed_in_4_0` and `adcp_version_echo_required_in_4_0`.
- The three canonical 4.0 notice codes are registered as checks under the same ids. `request_signing_required_in_4_0` and `legacy_hmac_fallback_removed_in_4_0` are also graded as advisory validations on the `media_buy_seller` and `capability_discovery` capability steps, so a report does not depend on notice emission. `signed_requests_specialism_deprecated` now declares `effective_version: "4.0"`.
- New migration page `reference/migration/v4-compatibility` and a build lint keep the registry, storyboards, notice codes, and page anchors in step.

None of these checks fails a 3.x conformance run.
