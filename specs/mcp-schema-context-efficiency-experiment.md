# MCP schema context efficiency experiment

Status: non-normative experiment for Working Group review

Scope: active AdCP 3.2 Media Buy model context

Canonical validation schemas: unchanged

## Question

Can an MCP client preserve AdCP's typed tool inputs while avoiding repeated
copies of the same bundled JSON Schema definitions in model context?

The experiment measures a representative 16-tool Media Buy runtime selected
from the active role catalog by the capability algorithm introduced in #6562.
It compares four prompt presentations:

1. Today's standalone model-context schemas.
2. A prompt-only 3.2 schema cleanup.
3. Standalone tool roots plus one pre-registered shared definition dictionary.
4. The shared dictionary combined with the prompt cleanup.

None of these artifacts changes the parent Media Buy validation profile or the
wire contract advertised by a conforming server.

## Results

Token counts use `tiktoken`'s `o200k_base` encoding over compact JSON. Byte
counts are produced by the repository experiment and are the deterministic CI
metric; tokenizer counts are included to make the model-context effect legible.

| Presentation                       |   Bytes | Approx. tokens | Reduction |
| ---------------------------------- | ------: | -------------: | --------: |
| Standalone model-context inputs    | 290,821 |         73,032 |  baseline |
| Prompt cleanup                     | 233,008 |         58,295 |     20.2% |
| Shared dictionary                  | 101,627 |         25,557 |     65.0% |
| Shared dictionary + prompt cleanup |  86,882 |         21,753 |     70.2% |

The selected standalone schemas contain 559 definition instances but only 142
unique definitions. One shared dictionary therefore produces substantially
more savings than weakening the schemas themselves.

## Input-field weight

The experiment attributes each top-level input field's transitive `$defs`
closure to that field. The heaviest model-context fields are:

| Tool field                     | Definitions | Compact definition bytes |
| ------------------------------ | ----------: | -----------------------: |
| `refine_proposals.refinements` |          76 |                   43,309 |
| `list_products.criteria`       |          75 |                   42,556 |
| `request_proposals.criteria`   |          75 |                   42,556 |
| `buy_products.purchases`       |          64 |                   32,914 |
| `control_media_buy.packages`   |          49 |                   26,383 |
| Legacy-style account selectors |          13 |                    5,912 |

This report is intended to prevent accidental schema expansion: a small input
field can pull a much larger graph through reused entity types. For example,
`account-ref -> brand-ref -> image asset -> provenance` makes provenance part
of several account-selection requests.

## Shared dictionary presentation

Each tool retains its ordinary root input shape but omits its local `$defs`.
Root references point to a separately supplied JSON Schema resource:

```json
{
  "$ref": "adcp://schemas/shared#/$defs/external:core~1targeting.json"
}
```

The client pre-registers one resource with `$id` `adcp://schemas/shared` and the
142 unique definitions. References between definitions remain local to that
resource.

The repository test establishes the compatibility boundary deliberately:

- all 16 tool roots compile when the dictionary is registered;
- compilation fails with an unresolved external reference when it is absent.

Consequently this is not a replacement for standard `tools/list` today. It is
an opt-in client experiment for hosts that can place a resource in model
context and register it with their JSON Schema implementation.

## Prompt-only cleanup

The cleanup prototype applies four changes after producing the canonical
model-context view:

1. Project `account-ref` and `brand-ref` selector positions to the existing
   3.2 `canonical-account-ref` and `brand-key` shapes. These are subsets of the
   canonical validator and omit inline brand-kit/provenance baggage.
2. Replace the parallel 32-property targeting-requirement map with
   `required_dimensions` plus structured exceptions under `constraints`.
3. Omit deprecated `axe_include_segment`, `axe_exclude_segment`, and
   `signal_targeting` branches from the 3.2 prompt view.
4. Omit `pricing`, `start_time`, `end_time`, `measurement_terms`, and
   `performance_standards` from prompt-visible purchases. The selected pricing
   option already determines these fields; the canonical contract says an
   omitted value inherits and a supplied value must match.

Changes 1, 3, and 4 constrain what the model generates but remain accepted by
the canonical schemas. Change 2 uses a smaller authoring shape and therefore
requires a deterministic client adapter before canonical validation:

```json
{
  "required_dimensions": ["geo_countries", "browser"],
  "constraints": {
    "browser": { "families": ["chrome", "safari"] }
  }
}
```

expands to:

```json
{
  "geo_countries": true,
  "browser": { "families": ["chrome", "safari"] }
}
```

The experiment includes and tests this adapter for `list_products`,
`request_proposals`, and `refine_proposals`. It must remain opt-in unless the WG
chooses to adopt the compact shape as the canonical pre-release 3.2 shape.

## Proposed evaluation

Run standalone and shared-dictionary presentations through at least two client
and model families. Record:

- input-context tokens;
- correct tool-selection rate;
- canonical argument-validation rate after any adapter;
- repair turns required after validation errors;
- latency to first valid tool call;
- behavior when the dictionary resource is unavailable.

The shared dictionary should advance only if typed-call quality is no worse
than the standalone presentation and missing-resource behavior fails closed.

## Reproduction

```bash
npm run experiment:mcp-schema-context
npm run test:mcp-schema-projection
```

The first command rebuilds the generated schemas and prints the selection,
variant sizes, largest fields, and largest repeated definitions as JSON.

## WG decisions requested

1. Should AdCP propose or wait for a standard MCP mechanism for shared schema
   resources, while keeping this client experiment explicitly private?
2. Is a deterministic prompt-to-wire adapter acceptable, or should all model
   projections remain strict subsets with identical property names?
3. Should the compact targeting-requirement shape replace the current
   pre-release 3.2 shape before it becomes a compatibility obligation?
4. What client/model matrix and quality threshold should gate adoption?
