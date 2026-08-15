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

## Standards landscape

Checked 2026-08-15.

### MCP

There is direct prior art, but no current interoperable mechanism:

- [MCP SEP-1576](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1576)
  proposed deduplicating tool schemas with local and external `$ref`s, varying
  `tools/list` detail, and retrieving a smaller relevant tool set. That is very
  close to this experiment. The proposal is now closed and marked dormant,
  with no linked implementation. The closing guidance recommends first using
  the [MCP contributor Discord](https://modelcontextprotocol.io/community/communication#discord)
  to establish renewed interest and sponsorship.
- [MCP SEP-834](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/834)
  is the complementary effort to make JSON Schema 2020-12 support explicit.
  Full JSON Schema support makes the references legal schema, but does not by
  itself define how an MCP client discovers, transports, registers, or places
  an external schema resource in model context.
- The [Skills over MCP Working Group](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/2628)
  is actively addressing adjacent tool-bloat and dependency-loading problems
  with resource-backed, lazily loaded skills. Its early tests covered
  fast-agent, Gemini CLI, Codex, and Goose. That work demonstrates that several
  clients can already put MCP resources into model context, but it does not yet
  make those resources a shared dictionary for `Tool.inputSchema` validation.

So a shared dictionary is technically credible and aligned with known MCP
work, but standard support is not imminent or assured. The useful next step is
to take this measured AdCP case to the MCP schema/tooling discussions as a
narrow proposal: capability negotiation, dictionary transport and identity,
external-reference resolution, caching, and fail-closed behavior. AdCP should
not advertise external references in ordinary `tools/list` until clients
negotiate that support.

### A2A

A2A has a different default shape. An
[Agent Skill](https://a2a-protocol.org/latest/definitions/) is descriptive and
advertises input and output media types, not a JSON Schema for each skill's
arguments. A [remote A2A agent](https://a2a-protocol.org/latest/topics/key-concepts/)
is intentionally opaque, so its internal tool schemas are not normally copied
into the caller's model context.

The [A2A extension mechanism](https://a2a-protocol.org/latest/topics/extensions/)
can nevertheless define structured `params`, schemas for additional data, or
a profile requiring schema-conforming data parts. An AdCP-over-A2A extension
could therefore identify a versioned shared schema bundle and negotiate it in
the Agent Card. That is possible without changing A2A core, but it would be an
AdCP extension requiring explicit support on both sides. It only creates the
same token-saving opportunity when the client exposes those typed AdCP
operations to its model; ordinary prompt-to-opaque-agent A2A traffic does not
have MCP's repeated-tool-schema cost.

## Evaluation package

[PR #6568](https://github.com/adcontextprotocol/adcp/pull/6568) is the runnable
reference experiment. Reviewers can check it out and reproduce the selection,
measurements, shared dictionary, adapter, and fail-closed validation:

```bash
gh pr checkout 6568
npm ci
npm run experiment:mcp-schema-context
npm run test:mcp-schema-projection
```

It is not yet a multi-client model-quality shootout. That follow-up should use
the same 16-tool corpus and record the metrics above for at least two client
and model families, with one standalone-schema arm and one pre-registered
dictionary arm. Keeping the harness separate from the protocol schemas lets
client-specific resource registration remain experimental.

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
