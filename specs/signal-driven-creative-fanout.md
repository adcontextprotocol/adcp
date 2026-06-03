# Signal-driven creative fan-out

RFC for #5240. Target: 3.2 follow-on after the build-creative multiplicity
work lands. This is not a current wire contract.

## Problem

Some campaigns need one kept creative per signal condition: rain creative,
sun creative, loyalty-segment creative, and so on. These are not variants of
one deliverable. They are distinct deliverables that must all be kept and
trafficked independently, each constrained to packages whose targeting includes
the matching signal condition.

The hard part is not just counting leaves. The hard part is shared condition
identity across the creative agent, buyer agent, signal provider, and sales
agent. A creative tagged for one provider's "rain" condition must not be
silently trafficked against another provider's "rain" condition when those
providers use different definitions, lookback windows, or identity substrates.

## Current schema boundary

The current `core/signal-ref.json` identifies a signal definition:

- `scope: "product"` for product-local options.
- `scope: "data_provider"` for provider-published definitions.
- `scope: "signal_source"` for source-native signals.

That definition identity is necessary but not always sufficient for fan-out
condition identity. A fan-out leaf usually needs the resolved condition handle
returned by `get_signals.signals[].signal_agent_segment_id`, or a typed value
expression for inherently categorical signals where the value is the
discriminator.

## Proposed condition identity rule

Use a resolved segment handle as the primary condition identity when one exists.
Use a categorical value expression only as the fallback for signals whose value
is inherently the discriminator and where the provider does not expose a
resolved segment handle.

Recommended shape for a fan-out condition binding:

```json
{
  "signal_ref": {
    "scope": "data_provider",
    "data_provider_domain": "provider-a.example",
    "signal_id": "weather"
  },
  "signal_agent_segment_id": "provider_a:weather:rain_pl_waw_2026",
  "value_type": "binary",
  "value": true
}
```

Fallback shape for inherently categorical signals:

```json
{
  "signal_ref": {
    "scope": "data_provider",
    "data_provider_domain": "provider-a.example",
    "signal_id": "weather_condition"
  },
  "value_type": "categorical",
  "values": ["rain"]
}
```

Rules:

- Buyers SHOULD propagate `signal_agent_segment_id` verbatim when `get_signals`
  or a product `signal_targeting_options` entry exposes it.
- Buyers SHOULD NOT reconstruct a segment handle from `signal_id` and
  categorical values when the provider already returned a resolved segment.
- Providers MAY namespace `signal_agent_segment_id` values. Consumers MUST treat
  them as opaque and MUST NOT parse the namespace for business logic.
- Categorical fallback identity is weaker. It is appropriate for inherently
  categorical signals, but it depends on the referenced definition's taxonomy
  and should not be used as a cross-provider equivalence claim.

This preserves small-provider adoption: cross-provider distinction is carried in
provider-scoped opaque IDs such as `provider_a:weather:rain_pl_waw_2026` versus
`provider_b:precip:high`, without requiring a centralized taxonomy registry.

## Build-time fan-out vs runtime DCO

Use build-time signal fan-out when the buyer needs distinct trafficking,
measurement, approval, or package assignment per condition, and the creative
materially differs by condition.

Use runtime dynamic creative optimization when there is one trafficked creative
and the signal only controls serve-time substitution such as copy, image, or
macro values inside the same delivery object.

The same signal can support both models. The buyer chooses based on the desired
operational contract, not on the signal's value type.

## Request model

Add a fan-out input to `build_creative` that declares one or more production
axes. The v1 feature SHOULD allow one signal axis in execution, but the shape
SHOULD include per-axis caps from the beginning so later cross-products do not
need a breaking reshape.

Illustrative shape:

```json
{
  "message": "Build weather-specific 300x250 display creatives.",
  "target_format_id": "iab-display-300x250",
  "signal_fanout": {
    "max_leaves_total": 6,
    "axes": [
      {
        "axis_id": "weather",
        "max_leaves": 3,
        "conditions": [
          {
            "label": "Rain",
            "signal_ref": {
              "scope": "data_provider",
              "data_provider_domain": "provider-a.example",
              "signal_id": "weather"
            },
            "signal_agent_segment_id": "provider_a:weather:rain_pl_waw_2026",
            "value_type": "binary",
            "value": true
          }
        ]
      }
    ]
  }
}
```

The production leaf count is:

```text
catalog_items * signal_conditions * variants
```

For v1, `signal_conditions` is the count of conditions on the single allowed
signal axis. The request still carries `max_leaves` on that axis so runaway
leaf counts fail before CPU is spent on creatives no one will traffic.

## Response model

Each kept creative in `creatives[]` should carry the fan-out bindings that
explain why it exists:

```json
{
  "creative_id": "cr_rain_300x250_001",
  "creative_manifest": { "format_id": "iab-display-300x250" },
  "fanout_bindings": [
    {
      "axis_id": "weather",
      "signal_ref": {
        "scope": "data_provider",
        "data_provider_domain": "provider-a.example",
        "signal_id": "weather"
      },
      "signal_agent_segment_id": "provider_a:weather:rain_pl_waw_2026",
      "value_type": "binary",
      "value": true
    }
  ]
}
```

The response binding is the trafficking contract input. The buyer or sales agent
can compare it with package `targeting_overlay.signal_targeting_groups` before
assigning the creative to a package.

## Trafficking contract

Signal-built creatives SHOULD only run in packages whose targeting includes a
compatible signal condition. Sales agents SHOULD reject or warn on assignment
when the package targeting does not include the creative's fan-out binding.

Compatibility rules:

- If both sides carry `signal_agent_segment_id`, compare the string exactly.
- If both sides only carry categorical value expressions, compare `signal_ref`,
  `value_type`, and value set semantics.
- Do not treat equal categorical labels from different providers as compatible
  unless an explicit equivalence mechanism exists.
- If one side carries a segment handle and the other only carries a categorical
  value expression, the seller may accept only when it can resolve both to the
  same provider-issued segment. Otherwise it should reject or warn.

The SHOULD to MUST decision should be driven by implementation evidence: how
often sellers can resolve the package side of the comparison, how often buyer
agents include segment handles, and whether per-destination coverage data makes
false-positive enforcement unlikely.

## Per-axis caps

Per-axis caps should ship in v1 even if multi-axis cross-products are deferred.
Without them, a buyer can ask for `weather * daypart * geo` and exceed the
build budget before the agent can explain which axis caused the blow-up.

Minimum cap fields:

- `max_leaves_total`: whole request ceiling after catalog, signal, and variant
  multiplication.
- `axes[].max_leaves`: per-axis ceiling for the number of conditions the agent
  may materialize.
- Estimate output: `leaves_total` plus per-axis counts so the buyer can trim the
  correct dimension.

Agents SHOULD fail before building when any cap is exceeded. `mode: "estimate"`
SHOULD return the same cap accounting without producing creatives.

## Per-destination fidelity metadata

#5248 item 3 is adjacent to this RFC. If the fan-out binding is the
load-bearing primitive for trafficking enforcement, buyers need to know how
well that condition survives activation into each destination or identity
substrate.

Open design question: expose destination-specific fidelity adjacent to
`get_signals` deployment metadata or as a destination capability declaration.
The useful planning fields are likely:

- destination identity, using `core/destination.json`.
- identity substrate, such as UID2, ID5, hashed email, publisher first-party ID,
  or platform-native ID.
- match-rate or activation-rate estimate.
- coverage estimate, ideally reusing the `coverage_rate` style from
  `signal-coverage-forecast.json`.
- timestamp and denominator notes.

This should remain optional planning metadata in the first fan-out draft. It is
not required to define the resolved segment identity rule, but it may determine
when the trafficking constraint can graduate from SHOULD to MUST.

## Open forks

- Field name: reuse `signal_fanout` on `build_creative`, or define a general
  `fanout` object that later covers catalog and signal axes uniformly.
- Response placement: top-level `creatives[].fanout_bindings` versus embedding
  the binding in each manifest.
- Enforcement severity: seller reject, seller warning, or buyer-side preflight
  before creative assignment.
- Multi-axis launch timing: single signal axis in v1, cross-product later, but
  per-axis caps in v1.
