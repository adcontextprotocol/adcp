---
"adcontextprotocol": patch
---

Accept payloads that two branches of a `oneOf` both matched, which the union rejected (#9051, #3939). In each union, the branch that should give way now refuses the other branch's shape with `not: { $ref: … }`, so such a payload resolves to one branch and nothing that validated before stops validating.

- `property/property-feature-result.json` `property` rejected every property ID: a value such as `homepage` is both a string and a valid `core/property-id.json`. The domain-string branch now refuses property IDs, so they validate as the property ID.
- The six content-standards responses (`calibrate-content`, `create-content-standards`, `get-content-standards`, `get-media-buy-artifacts`, `list-content-standards`, `validate-content-delivery`) rejected a success body that also lists `errors`. Their error branch now refuses a valid success body, so it is the success shape.
- `adagents.json` rejected a file carrying both a valid `authoritative_location` and inline `authorized_agents`. The inline variant now refuses a valid URL reference, so the file is the URL reference and validators follow `authoritative_location`, as the validation steps in `adagents.mdx` describe.
- `calibration_exemplars` pass and fail entries in `create-content-standards-request` and `update-content-standards-request` rejected an artifact that also carries `type` and `value`. The URL-reference branch now refuses a valid artifact.
