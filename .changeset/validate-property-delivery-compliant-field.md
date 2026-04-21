---
"adcontextprotocol": minor
---

`validate_property_delivery`: add optional root-level `compliant: boolean` field to the response schema — an overall compliance flag derived from `summary.non_compliant_records === 0`, surfaced at the root as a convenience signal for buyers. Consumers SHOULD fall back to summary counts when the field is absent. Resolves a contradiction between the JSON schema (which previously forbade `compliant` via root `additionalProperties: false`), `@adcp/client`'s hand-written zod response schema (which required `compliant`), and the `property_lists` storyboard (which asserted on `field_value compliant`).

Also fixes the `property_lists` storyboard's delivery records to use the schema-correct `identifier:` key instead of the non-schema `property:` key, and aligns the `validate_property_delivery` expected narrative with the `features[]` per-record contract.
