# Budget discovery and averaged execution for AdCP 4.0

Status: proposed. Tracks [#8685](https://github.com/adcontextprotocol/adcp/issues/8685).
The proposed 4.0 field names below are design choices, not fields supported by
the current schemas. The 3.3 error-details slice is implemented separately in
this change. Platform rules motivating the proposal are reported in the issue;
this document does not establish current vendor pricing or limits.

## Release split

| Release | Scope |
|---|---|
| 3.3 | Optional `basis`, `budget_field`, `constraint`, and `related_field` on `BUDGET_TOO_LOW` details. Keep all existing budget guarantees. |
| 4.0 | Currency-specific daily minimum discovery, typed averaging policies, daily targets, and explicit daily-only budget authorization throughout the purchase lifecycle. |

Make canonical pricing the primary home for minimums. Shipping a new minimum
only on legacy `get_products` would leave modern `list_products` buyers
without the same planning information. Any legacy projection retained in 4.0
should preserve the same constraints, subject to the negotiated schema. Do
not add a temporary second home for minimums merely to fit them into 3.3.

<!-- depends on #8858 (the DR-0036 rewrite) -->
`core/canonical-pricing-option.json`, `media-buy/product-purchase.json`, and
`media-buy/commercial-terms.json` are held closed until 4.0 (DR-0036, decided
2026-11-09). A minor adds nothing to them, and the additive-minor gate rejects
new properties there. `media-buy/product-purchase-input.json` opens in 3.3,
but a minimum accepted there would have no home in the purchase it produces,
so these budget semantics still wait for 4.0.

## Recommended release sequence

Finish the compatible 3.3 release, then develop 4.0 as the next feature line.
Keep 3.3 maintenance available during adoption. A bounded 4.0 scope should join
the production budget problem to already-planned account, format, security,
and commercial-term migrations. An exploratory 4.0 backlog item is not
automatically a GA blocker.

4.0 retains its established early-2027 target. The 18-month major-release
spacing commitment in `docs/reference/versioning.mdx` applies from 4.0 onward,
not to this transition. A removal needs no minimum notice period, and the
prior-major security-support commitment remains applicable.

## 1. Discovery: prices declare amounts, products declare behavior

Add optional `min_daily_budget` to a pricing option in its own `currency`,
alongside `min_spend_per_package`. Use one option per offered currency. Values
are nonnegative; absence means undeclared, explicit zero means no positive
static minimum. Omit unknown minimums rather than using null.

The minimum applies to the daily budget control the product declares. A
product exposing both a hard daily cap and a daily target must disclose any
different applicable minimums explicitly; do not assume that a target's
minimum automatically becomes a minimum hard cap. Resolve that two-control
representation before schema implementation.

A product-level daily-budget policy states:

- Supported control scopes and budget modes. Seller capabilities roll up
  support; the product declaration is authoritative for its execution rules.
- Whether averaged daily targets are supported. Existing `budget_capping`
  remains the independent declaration for hard daily caps.
- The native relationship to lifetime budgets: compatible or exclusive.
  Exclusivity describes native controls, not permission to ignore an AdCP cap.
- Whether a daily minimum is also constrained by the highest effective manual
  bid. Use a named rule, not an arbitrary expression language. Specify the
  native campaign scope and bid units; do not compare CPC and CPM raw values
  as if they were the same quantity. Resolve inherited policies and overrides
  before evaluating the rule.

Bind the effective policy to the selected product and pricing terms. A
material policy change must follow existing offer-version and accepted-term
rules rather than silently changing an active buy's maximum exposure.

## 2. Separate hard daily caps from daily targets

Retain `daily_budget_cap` as a hard daily spend ceiling. Introduce a distinct
`daily_budget_target` for averaged pacing. Neither implies support for the
other. Accept both only when their combination is advertised and enforceable;
reject unsupported controls or combinations before mutation.

A seller may enforce an AdCP hard ceiling independently of its native
platform's averaged target. Conversely, mapping a cap directly to an averaged
native budget is never conformant. Best-effort polling and pausing alone is
not evidence that a hard ceiling can be honored, especially with delayed spend
reporting and in-flight delivery.

## 3. Explicit authorization for daily-only execution

Recommend a required media-buy `budget_mode` discriminator in 4.0, with
`lifetime` and `daily` variants. One buy uses one mode; split mixed-mode
requirements into separate buys for the initial version. Currency stays
explicit and common to the buy, pricing options, targets, caps, and bidding.

| Mode and allocation | Required funding control | Lifetime ceiling |
|---|---|---|
| Lifetime, fixed | Each package's lifetime `budget` | Aggregate follows the existing fixed-allocation rules. |
| Lifetime, seller optimized | Shared `total_budget` | Required and hard. Package constraints remain subordinate. |
| Daily, fixed | Each package's `daily_budget_target` | Optional only when explicitly authored and enforceable; no inferred aggregate lifetime ceiling. |
| Daily, seller optimized | Shared media-buy `daily_budget_target` | Optional only when explicitly authored and enforceable. Root support is advertised independently of package support. |

Fixed daily allocation does not imply an aggregate daily target by summation:
different products can have different averaging clocks. A seller-optimized
daily pool needs one shared policy that every participating product supports.
Package-level daily targets inside that shared pool need a separately defined
subordinate allocation contract; exclude them from the initial implementation
rather than treating them as reservations.

Daily mode requires a finite flight and acceptance of its disclosed spend
envelope. It does not authorize unlimited spending or manufacture a lifetime
guarantee from target times flight length. For the first interoperable version,
a daily policy must provide enforceable finite daily and window maxima and
the boundary/change rules needed to evaluate exposure across the flight. A
seller with an unbounded or undeclared envelope cannot offer this daily-only
authorization mode; it needs an independently enforceable lifetime ceiling.

Remove the unconditional `total_budget` readback requirement only for the
explicit daily-mode branch. Echo authored caps when present and leave them
absent when none was authorized. Forecast spend belongs in forecast fields,
never in a fabricated hard-budget field.

Native daily/lifetime exclusivity does not force the protocol to prohibit both
when an adapter can enforce a lifetime cap independently. If it cannot honor
an explicitly requested lifetime cap, reject the combination before any
downstream write. Do not convert daily authorization to lifetime authorization
or vice versa without a new buyer commitment.

## 4. Averaging policy is part of accepted terms

Define a discriminated policy with a literal `kind` distinguishing a fixed
calendar window from a rolling window. The first implementation should cover
calendar weeks and an explicitly defined rolling-days variant only if an
adopter supplies executable evidence for it.

| Policy fact | Required interpretation |
|---|---|
| Calendar-week anchor | Local weekday on which a fixed week starts; never presented as a rolling seven-day window. |
| Timezone basis | Account timezone or an explicit fixed IANA timezone. Readback resolves the actual IANA value. |
| Daily maximum | `max_daily_multiple` times the accepted daily target, a hard daily bound. |
| Window maximum | `max_window_multiple` times the accepted daily target, not times a full window's target total. |
| Calendar day | Local midnight to local midnight; daylight-saving days may differ from 24 elapsed hours. |
| Partial window | Explicit full-window allowance or prorated allowance with a defined eligible-day calculation; no implicit proration. |
| Target change | Effective time, spend already consumed, and the resulting remainder of the current day/window. A change does not silently reset spend counters. |

`P7D` alone does not define these rules. The daily-target clock is independent
of the hard-cap clock unless the seller explicitly guarantees they coincide.
Resolve both clocks and apply every accepted ceiling independently.

Store the effective policy with accepted commercial terms. For example, a
constant target of 25 units, daily multiple 2, and fixed-week multiple 7 means
at most 50 units per day and 175 per complete budget week, subject to any
tighter accepted cap. A short flight crossing two calendar weeks must use
the disclosed partial-week rule; it cannot assume a single seven-day allowance.

## 5. Error recovery in 3.3

Keep the existing recommended `BUDGET_TOO_LOW` details shape open, and add
only optional fields:

| Field | Meaning |
|---|---|
| `basis` | `daily` or `lifetime`; absent is undeclared. |
| `budget_field` | Constrained budget at the request target scope, independent of the primary issue. Package indices refer to submitted request rows resolved through `package_id` on updates, not readback order. |
| `constraint` | `product_minimum`, `effective_bid_floor`, or another non-empty seller constraint. Unknown causes do not prevent use of the amount and field. |
| `related_field` | Request field contributing to the minimum; omitted if there is no corresponding buyer-authored field. |

`minimum_budget` is the computed minimum acceptable amount for `budget_field`,
or `error.field` only when that field unambiguously identifies a budget,
in `currency`, not the delta or necessarily the raw bid. Without a clear
budget locator the amount remains diagnostic. Read and reconcile retained
budgets before changing them; never invent a package index for a package
absent from an update request. `bid` is the cause of
a floor, not its duration. Compute floors against the complete proposed
budget/bid state; errors do not authorize an automatic increase in spending.
These details can describe existing daily controls without adding a new one.

## 6. Lifecycle and implementation gates for 4.0

Carry the same budget mode, accepted targets, policies, and any independent
hard ceilings through discovery, `buy_products`, proposal negotiation and
`accept_proposal`, accepted commercial terms and digests, governance planned
delivery, `control_media_buy`, forecasts, authoritative readback, and revision
history. Validate product participation in a shared daily pool before any
mutation. Budget or bid updates revalidate the complete resulting state.

Define updates before implementing them: omission preserves a target; a
number replaces it under the disclosed effective-time rules; null clears it
only when the resulting state has a valid funding control. Treat a budget-mode
switch as a new commercial commitment, not an ordinary target update. Define
target-change action rights explicitly; raising a soft target is not the same
operation as removing a hard cap.

Never down-project a daily-only 4.0 buy into a 3.x representation with an
invented lifetime budget. A 4.0 buyer may choose a supported 3.x lifetime mode
explicitly; a 3.x-pinned read cannot truthfully represent a daily-only buy and
must follow an agreed unsupported-representation contract. This requires
cross-version read tests before GA.

The release gate is a buyer journey: discover a currency option and its
constraints, authorize a spend envelope, book, change a bid and target, read
the effective controls, serve across a window boundary, then audit spend.
Include cases for bid inheritance, unsupported cap combinations, concurrent
updates, idempotent replay, partial weeks, timezone/DST boundaries, mid-window
target reductions after spend, delayed reporting, and target clearing.

Add typed-schema tests and compliance scenarios for those behaviors, and
update SDK representations, migration guidance, and certification budget
teaching before declaring 4.0 support. Gate GA on an independently operated
buyer and seller completing the journey, alongside the existing removal
registry and security release gates.
