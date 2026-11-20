# Planning goals and plan breakdown for scheduled media

Status: proposed (draft, not yet filed as an RFC issue). Tracks Linear AI-23242.
Target: experimental surface (`media_buy.planning_goals`, `media_buy.plan_breakdown`),
following the DOOH impression basis precedent (RFC #7253, #8736). Touches no
schema that DR-0036 holds closed until 4.0.

This document follows the [RFC process](/docs/governance/rfc-process) template
(Motivation, Scope, Alternatives considered, Compatibility impact, Reviewer
checklist), then lists the open questions. The schemas, a guide page and a
tested worked example ride in the same PR.

## Motivation

On 20 November iHeartMedia (Benjamin Masse) demoed Harmony, their agentic radio
planner. The screens show a plan the way a radio buyer reads it: a totals strip
(markets, market audience, used budget, estimated audience, average index, GRP,
CPP, impressions, CPM, 4-week and campaign frequency) over tiles and tables by
week, daypart, spot length, market, station and format, each with budget %
against GRP %, CPM against plan, pacing, and reach and frequency by week. The
audience step before it lists signal tiers, markets, stations and formats with
composition rate, estimated audience and index. Benjamin's point was that radio
buyers think in these terms and a plan shown any other way is not understood.

AdCP can carry the *buy* for a plan like this today, but not the *plan* in
these terms, and not the goals the planner was optimizing:

1. A buyer cannot state structured goals. Budget set or suggested, an
   objective (max reach, max efficiency), a fixed GRP or impression target with
   a CPP or CPM ceiling, a maximum frequency and its window, spot-length mix,
   spots per hour, overbook, prime/fringe split, pacing, and stations, markets
   or formats to include or exclude all travel as prose in `brief`.
2. A seller cannot show the plan by market, station, format, daypart, week and
   spot length with GRP, CPP, CPM, composition rate and index per slice, or give
   plan-level reach and frequency over four weeks and the campaign.
3. A buyer cannot tell which goals a revision met. `refine_proposals` returns a
   new draft, and `constraints` can fail one, but nothing says "frequency met,
   Portland not in catalog".

The vocabulary is channel-neutral. Radio, linear TV and out-of-home all plan in
GRPs, impressions, reach and frequency over markets, dayparts and weeks.

## What exists today

More than expected. This proposal reuses all of it.

| Need | Exists | Gap |
|---|---|---|
| GRP, reach, frequency, impressions, plays, spend | `forecast-point.json` `metrics` (low/mid/high); `forecastable-metric` has `grps`, `reach`, `frequency` | No definition of what a GRP is rated against |
| Demo, provider, reach unit | `delivery-forecast.json`: `demographic_system` (incl. `nielsen_audio`), `demographic`, `measurement_source` (free slug), `reach_unit` | No rating universe, no index baseline, none on a plan view |
| Cost per point | `pricing-options/cpp-option.json` (rate, demo parameters) | No plan-level effective CPP/CPM |
| Dimensional rows | `forecast-point-dimensions.json` (geo, placement, device, audience, signal, time) | No station, programming format, daypart, spot length; rows describe availability and spend curves, not a scheduled plan |
| Package forecasts, R/F curves | `forecast_range_unit`: `package`, `reach_freq`, `weekly` | Not a decomposition of one plan |
| Dayparts, spot plans | `daypart-target.json` (minute resolution, experimental); `allocations[].daypart_targets` | No class mix (prime/fringe) |
| Budget split across packages | `budget_allocation.mode` fixed or `seller_optimized` | Different concept from budget set vs suggested |
| Open budget answer | `total_budget_guidance`; `offer_filters.budget_range` | No explicit "suggest" |
| Outcome/volume planning | `criteria.outcome_target`: goal (any `forecastable-metric`, so `grps`), `volume`, `cost_per` | `cost_per` needs a canonical optimization goal, so it cannot bind CPP or CPM |
| Frequency | `reach` optimization goal `target_frequency {min,max,window}`; `media_buy_frequency_cap` (enforced) | Broadcast cannot enforce per person; a planned average needs a different contract |
| Include/exclude | `property_list(_exclude)`, `geo_metros(_exclude)`, `product_changes` include/omit | Restrict delivery or name products; do not ask a *plan* to contain a station, market or format |
| Station ids | `station_id`, `facility_id` identifier types | none |
| Revision | `refine_proposals` `revise` with `criteria`, `constraints`, `unsatisfied_constraints`, `parent_proposal_id` | Hard constraints only; no per-goal report on a successful draft |
| As-run | `by_spot` with `network`, `station`, `daypart` | Delivery side; out of scope here |

Not in the spec at all: composition rate, index, spots per hour, overbook,
spot-length mix, a programming-format vocabulary, plan-level reach and
frequency windows, a met/missed report.

## Scope

Additive and optional. Everything is `x-status: experimental`, `x-added-in:
"3.3.0"`, and gated by two feature ids.

### 1. `criteria.planning_goals` (`core/planning-goals.json`)

Carried in `product-discovery-criteria.json`, so it is accepted by
`request_proposals` and by `refine_proposals` `revise` (where `criteria` already
replaces per field). Inert on `list_products`, like `outcome_target`.

| Property | Shape |
|---|---|
| `budget_mode` | `set` \| `suggest`. The amount stays in `offer_filters.budget_range`; on `suggest` a range is a hard envelope the suggestion falls inside. |
| `objective` | `max_reach` \| `max_efficiency` (lowest CPP, or CPM when impression-denominated) |
| `delivery_target` | `{metric: grps\|impressions, value, max_cost?: {amount, currency, cost_basis?}}`; ceiling is effective CPP or CPM, gross or net |
| `cost_ceiling` | `{metric: cpp\|cpm, amount, currency, cost_basis?}`: the same ceiling with no target; `max_cost` is shorthand for it. `refine_proposals` `constraints` do not cover it (`constraints.cpm` bounds the rate, there is no CPP) |
| `max_frequency` | `{value, window}` with `window` a `duration.json`: exactly `{28, days}` (four weeks) or `{1, campaign}` (whole flight), compared to the `reach_frequency` point of the same window and echoed in the goal result |
| `delivery_rules` | `spot_length_mix[] {duration_seconds, share_percentage}`, `max_spots_per_hour`, `overbook_percentage`, `daypart_mix[] {label, share_percentage, daypart_targets?}`, `mix_basis` (`spots`\|`budget`), `pacing` (existing enum) |
| `must_include`, `must_exclude` | `plan-scope-selector.json`: `stations[]` (identifiers), `markets[]` (`geo-metro.json`), `programming_formats[]` |
| `audience_basis` | `plan-audience-basis.json`: the basis the buyer wants figures counted on |

Semantics: goals are planning inputs the seller plans toward, not delivery
guarantees. Hard bounds stay in refinement `constraints`. `max_frequency` is a
forecast-evaluated average, never an enforced cap. `must_include` asks that the
plan contain the inventory; it is not targeting.

### 2. `proposal.plan_breakdown` (`core/plan-breakdown.json`)

On `canonical-proposal.json` and legacy `proposal.json`. A view of the proposal:
`commercial_terms` stays authoritative for the buy, `forecast` for any metric
both state.

- `audience_basis`: `measurement_source`, `demographic_system`, `demographic`,
  `audience[]`, `reach_unit`, `universe`, `index_baseline`. The first four have
  the forecast's names and meaning and MUST agree with it when both are present.
- `totals`: `budget`, `market_count`, `station_count`, `market_audience`,
  `estimated_audience`, `average_index`, `spots`, `impressions`, `grps`, `cpp`,
  `cpm`, and `reach_frequency[]` (cumulative reach and frequency over a window:
  4 weeks, the campaign, and optionally each week).
- `breakdowns[]`: one per dimension (`market`, `station`, `programming_format`,
  `daypart`, `week`, `spot_length`, `custom`). Each allocation carries a stable
  `key`, `label`, a typed reference, and `budget`, `spots`, `impressions`,
  `grps`, `cpp`, `cpm`, `composition_rate`, `index`, `target_persons`. A
  complete breakdown partitions the plan; a partial one sets `truncated` (and
  `total_count`), following `by_spot_truncated`.
- GRP is defined: `grps = impressions / universe * 100` when `universe` is
  stated.

### 3. `proposal.goal_results[]` (`core/goal-result.json`)

One entry per goal in the effective `planning_goals`: `goal`, `status` (`met`,
`missed`, `not_supported`), `target`, `achieved`, `detail`, `unmet_items`.
Re-optimization is the existing `refine_proposals` `revise` with a changed
`criteria.planning_goals`; each draft carries its own results; lineage is
`parent_proposal_id`. A draft that misses a goal is still `revised`.

### 4. Capabilities

`media_buy.planning_goals {supported_goals[], supported_objectives[]}` and
`media_buy.plan_breakdown {dimensions[]}`, plus the two feature ids in
`experimental_features`. A seller without the feature rejects
`criteria.planning_goals` with `UNSUPPORTED_FEATURE` (the `outcome_target`
rule); a seller with it reports a goal it cannot plan as `not_supported`.

### Files

New: `core/{planning-goals,plan-scope-selector,plan-audience-basis,plan-breakdown,plan-totals,plan-dimension-breakdown,plan-allocation,plan-reach-frequency-point,goal-result}.json`,
`enums/{planning-budget-mode,planning-objective,planning-goal-key,planning-goal-status,plan-breakdown-dimension}.json`.
Edited: `product-discovery-criteria.json`, `canonical-proposal.json`,
`proposal.json`, `get-adcp-capabilities-response.json`, `index.json`.
Docs: `docs/media-buy/product-discovery/broadcast-planning.mdx`, the
experimental-status table. Tests: `tests/broadcast-planning.test.cjs` and
fixtures.

## Worked example: Hearthside Coffee

Built from the Harmony screens: 9 markets, 33 stations, $198,476 over a
five-week flight (16 Nov to 20 Dec), 3.3 GRP, $61K CPP, 7.0M impressions,
$28.39 CPM, 2.8x four-week frequency, 3.3x campaign frequency, and the market,
station, format and daypart splits as shown. The fixtures are
`tests/fixtures/broadcast-planning/`; the guide page walks through them,
including the refinement and the goal results.

What the screens do not show, and how the fixtures handle it:

- Station tiles show 10 of 33, formats 9 of 11, dayparts 4 of 6 with detail.
  Those breakdowns are `truncated` with `total_count`.
- Per-market impressions are budget / CPM. They sum to 6,991,653, which is the
  7.0M shown, so the market CPMs and the plan CPM agree.
- GRP is carried as 3.25 (screen: 3.3) so budget / GRP = $61,070 (screen: $61K).
- Campaign reach is carried as 2.1M: 7.0M impressions at 3.3x frequency, and
  the same figure as Est. Audience.
- Provider, rating universe and market system are not on the screens; the
  fixture omits the first two and marks the third `custom`.
- The brief asked for $120K in Suggest mode and the plan suggested $198.5K. That
  gap is why `budget_mode: suggest` with a `budget_range` bound needs defined
  behavior (open question 10).

## Finding: what "GRP 3.3" is on the screens

A conventional GRP is impressions divided by a universe, times 100. The screen's
3.3 is impressions / Est. Audience (7.0M / 2.1M), and that is also exactly the
campaign frequency (3.3x), because Est. Audience is the campaign reach. Every
daypart row agrees (Weekend Day 2.5M impressions is 1.2, AM Drive 1.5M is 0.7,
about 2.1M per "point"). So the screen's GRP is numerically the plan's average
frequency, and its $61K CPP is budget divided by that figure.

Two readings fit, and a product review of this draft favors the first:

1. **The column is a ratio, not a rating.** Against the 3.1M market audience the
   conventional figure is 6.99M / 3.1M = 225 GRPs, which is also reach rate
   (2.1M / 3.1M = 68%) times frequency (3.3). CPP is then about $880, where
   $61K is roughly a $28 CPM times 2.1M, one "universe turn" and not a point.
2. **A national universe.** A conventional 3.3 on 7.0M impressions implies a
   universe near 212M, and the screen has a National toggle. 212M is not a
   standard population, so this reading is weaker.

The fixtures carry the figures as shown (3.25 GRPs, $61,070 CPP) because the
task is to reproduce the screens, and the guide marks them as unreconciled. If
reading 1 is right, the conventional values are 225 GRPs and about $882 CPP. This
is why the proposal defines the formula and adds `audience_basis.universe`: a
GRP figure with no stated universe cannot be compared across sellers. The
estimated 74% composition rate on the audience step also looks like a
population ratio (3.1M / 4.2M), not a composition in the trade sense.

## Alternatives considered

1. **Extend forecast points** with new dimension kinds (station, programming
   format, daypart, spot length) and metrics (spots, cpp, cpm, composition,
   index). This reuses the most, and the forecast stays the single source. Not
   chosen: forecast points model availability and spend curves, where rows at
   ascending budgets are alternatives, not parts of one plan; a decomposition of
   one schedule would overload `points[]` with a different meaning and force
   every consumer to branch on it. `plan_breakdown` carries ranges nowhere and
   defers to the forecast where both speak.
2. **Widen `outcome_target.cost_per`** to bind CPP and CPM. Not chosen:
   `cost_per` is a bidding-policy control tied to a canonical optimization goal
   and a media-buy bidding profile; a broadcast ceiling is a plan-level
   effective cost, checked after the fact, with no bid. Reusing it would blur
   two semantics. `delivery_target` sits beside it, and `outcome_target` still
   serves a `grps` volume with no ceiling.
3. **Put goals and breakdown in `ext`.** `ext.adcp` is reserved for WG-owned
   bindings and vendor namespaces are for partner features. These are generic
   protocol concepts across three channels, so they are first-party experimental
   fields, like `dooh_impression_basis`. A seller can pilot under
   `ext.<vendor>` with the same shapes first; moving to the first-party field is
   a rename, not a redesign.
4. **Hard goals.** Make every goal a constraint, so a miss makes the result
   `partial`. Not chosen: a planner wants the best available draft and a report,
   not an empty result, when 3 of 4 goals are met. Hard bounds already exist as
   `constraints`. A per-goal `strength` of `required` or `preferred` is the
   obvious extension (open question 29).
5. **A new task** (`plan_media`, `optimize_plan`). Not chosen: the lifecycle
   already has an immutable-draft loop with lineage. The missing piece is the
   evaluation, not the verb.
6. **Merge-by-key refinement** of `planning_goals`. Not chosen: criteria
   replace per field today; replacing the object keeps one rule and an agent
   restates goals cheaply.

## Compatibility impact

Non-breaking. All new properties are optional, on open schemas (`additionalProperties`
not set to false); no closed schema (`commercial-terms`, `product-purchase`,
`canonical-pricing-option`) is touched. `npm run lint:additive-minor` reports 0
new non-additive changes. New enum files only, no value added to an existing
enum. Sellers that do not implement the features see no change. Receivers that
validate against a schema that predates the fields ignore them (open schemas).
Experimental: fields can change inside 3.x with six weeks' notice.

Release: lands as an experimental surface in the 3.3 line, as #8736 did, or
moves to the next minor if the WG prefers; nothing here is a 4.0 item.

## Open questions

### For iHeartMedia (Benjamin Masse, Harmony)

1. **GRP universe.** See the finding above: what is "GRP 3.3" rated against? The
   Est. Audience, the 3.1M market audience, or a national universe (~212M)? Do
   you carry 3.3 or 330 on the wire?
2. **Est. Audience.** Is 2.1M the campaign reach, the target universe, or a
   third thing? How do Market Audience (3.1M), Total Population (4.2M) and Comp.
   Rate (74%) relate?
3. **Provider.** Whose data is behind the audience: TransUnion, Nielsen Audio,
   iHeart first-party? How is the demographic written, and is it a standard
   notation or `custom`?
4. **Market system.** The catalog has 154 markets, and Portland ME and
   Burlington VT are not in it. Are they Nielsen Audio markets, DMAs, or your
   own list? AdCP's `metro-system` has `nielsen_dma`, not Nielsen Audio markets.
5. **Index and composition.** Is Index vs a national average for the audience
   at the station, the market, or both? Is a market's Comp. Rate the audience
   as a share of market population (3.1M / 4.2M = 74% suggests so), and a
   station's the target share of its listeners? The trade usually means the
   latter by composition, and defines index as station composition over market
   composition. The schema uses 0 to 1 for a rate and a free-text
   `index_baseline`; should the baseline be an enum?
6. **Format vocabulary.** The screens show 11 formats in five families (Rock,
   CHR, Country, Spoken, Other). Is the format list stable and publishable? Do
   we want a family level (`programming_format_family`)?
7. **Prime/fringe.** The advanced bar reads "Prime/fringe 60...". Is that a
   spot share or a budget share, and which of the eight dayparts are prime?
   Does `daypart_mix` with a seller label cover it?
8. **Spots per hour and overbook.** Is "1 spot/hr" per station-hour? Is overbook
   a percentage over the GRP target, over spots, or over budget?
9. **Max frequency.** The goal is 3x. The screen shows 2.8x for four weeks and
   3.3x for the campaign. Which does the 3x compare to, and is the window
   user-selectable? The draft makes the window explicit: 28 days or the whole
   flight, echoed in the goal result, so 2.8 is never read against the campaign.
10. **Suggest with a stated budget.** The brief said $120K; Suggest returned
    $198.5K. What does Suggest solve for, and what should a stated budget do:
    ceiling, starting point, or nothing? The draft says a structured
    `budget_range` is a hard envelope, the suggestion stays inside it, and goals
    it cannot meet are reported `missed`; a budget only in prose bounds nothing.
    Is that the behavior Harmony wants?
11. **Weekly shape.** The legend shows Even pace, Dark week and an average of
    $39,695 a week. Is week budget something a buyer can request (flighting),
    and is reach and frequency by week cumulative?
12. **Versions.** "V1 Sugg" names a version. Does Optimize create V2 with the
    same goals? We map versions to proposals with `parent_proposal_id`.
13. **Per-slice figures.** Which figures can you give per market, per station
    and per format (spots, GRPs, composition, index), and which only in total?
    The market tiles show budget and CPM, not GRPs.
14. **Goals you evaluate.** Which of the goals would Harmony report as
    `not_supported`?
15. **Weighting and the brief.** The brief says "weight toward Boston and
    Providence" and "3+ frequency". The UI sets a *max* frequency of 3x, while
    the brief reads as a minimum (effective frequency). Which did the buyer
    mean? Neither market weighting nor a minimum or N+ frequency has a field in
    this draft.
16. **Units.** Radio plans on AQH persons and cume; "Estimated Audience" is
    not one of those. Which is it, and what impression basis (AQH-based, other)
    sits under `impressions`? Is CPP/CPM gross or net of commission
    (`cost_basis`)?
17. **Standalone cost ceiling.** Buyers say "keep CPP under $60K" with no GRP
    target. The draft adds `cost_ceiling {metric: cpp|cpm, amount, currency}`
    and keeps `delivery_target.max_cost` as shorthand. Refinement `constraints`
    do not cover it (`constraints.cpm` bounds the pricing-option rate; there is
    no CPP constraint). Is a ceiling without a target something Harmony
    evaluates, and is effective CPP or CPM what the buyer means?
18. **Stations at scale.** The catalog is 813 stations. Is a full station
    breakdown acceptable on the wire, or does it need paging?

### For TV sellers

19. **GRP and currency.** TV GRPs are rated per market against universe
    estimates and measured by a currency (Nielsen, VideoAmp, others) at a
    window (Live, C3, C7). Is `audience_basis` plus `measurement_source` enough,
    or does the plan need the window and the universe estimate version?
20. **Dimensions.** Station and network, market, daypart (early fringe, access,
    prime, late), program or genre, week, :15/:30/:60. Does `programming_format`
    stretch to genre and program? Do you need `network` as its own dimension
    rather than `custom`?
21. **Spot length.** `spot_length_mix` is a share of spots. TV plans on :30
    equivalents. Is a share of spots, of budget or of equivalized units the
    unit? (Tracked with the :30 equivalization gap in #8001.)
22. **Overbook and guarantees.** Is overbook the same idea as an
    audience-deficiency cushion? Where do makegoods fit relative to a goal that
    is `missed`?
23. **Per-spot limits.** Spots per hour is a radio term. TV talks about pods,
    breaks and competitive separation. What should the rule be?
24. **Reach and frequency.** Is four weeks the standard cume window, and is
    effective reach (3+) wanted alongside average frequency?

### For out-of-home sellers

25. **Do GRPs apply?** Many OOH plans use impressions, reach and frequency, and
    "showings" or share of voice rather than GRPs. Is `delivery_target` metric
    `impressions` enough, with `grps` optional?
26. **Dimensions.** Market, venue or media owner, format (bulletin, poster,
    digital), posting period, daypart for digital loops. Which map to the six
    dimensions and which are `custom`?
27. **Plays, not spots.** A loop's spot length and plays per hour are share of
    voice. Do `max_spots_per_hour` and `spot_length_mix` read as plays per hour
    and loop share, or do we want separate fields? (Compare the DOOH
    `plays` and impression basis work.)
28. **Index.** Is a Geopath audience index the same thing as `index`, and what
    is its baseline?

### For the working group

29. **Soft or required goals.** Add a per-goal `strength` of `required` or
    `preferred`, where a missed `required` goal makes the result `partial`?
30. **Replace or merge.** Is whole-object replace of `planning_goals` on a
    revision right, or should omitted goals inherit?
31. **`not_supported` or reject.** A goal the seller cannot plan is reported
    here; `outcome_target` rejects. Keep the difference?
32. **Legacy `get_products`.** The response fields (`plan_breakdown`,
    `goal_results`) are on the legacy proposal. The request side
    (`planning_goals`) is only on the compact lifecycle. Is that acceptable, or
    is a legacy `refine` mapping wanted?
33. **Plan versus delivery.** The screens' "CPM vs plan" and pacing tiles are
    plan-versus-actual. A follow-up RFC could align delivery reporting
    dimensions (`by_station`, `by_daypart`, ...) with these keys so a buyer
    can reconcile variance. Is that wanted?
34. **Specialism.** `sales-broadcast-tv` and `sales-dooh` exist; radio has no
    specialism. Does a radio seller claim one, or does this need a
    `sales-audio` or `sales-broadcast-radio` claim?
35. **Certification.** Planning-goals and plan-breakdown conformance (storyboard
    steps asserting `goal_results` coverage, breakdown partition sums) is a
    follow-up, and the media-buy specialist module may want a broadcast
    planning exercise.

## Naming decisions

Brian approved the defaults below (a through h in the coordinator brief).

| Decision | Default in this draft | Why / alternative |
|---|---|---|
| `budget_mode` | Keep, `set` \| `suggest` | Collides in sound with `budget_allocation.mode` (fixed \| seller_optimized, about splitting). Alt: `budget_source`. |
| Radio "format" | `programming_format` | `format` is a creative format in AdCP. Alt: `content_format`; `genre` is taken by the genre taxonomy. |
| `station` dimension | Keep | Precedent: `by_spot` has `network` and `station`. Alt: `property`, which is the AdCP term but unfamiliar to planners. OOH and TV network use `custom`. |
| Rate vs percentage | `share_percentage`, `overbook_percentage` (configured); `composition_rate` (measured, 0 to 1) | `docs/spec-guidelines.md` ratio rule. |
| GRP scale | Conventional points, `universe` stated | Alt: allow a declared scale. Only needed if Harmony's 3.3 is not conventional. |
| `grps`, `cpp`, `cpm` | Reused names | Match `forecastable-metric` and `pricing-model`. |
| Goals soft | Report, do not fail | Hard bounds stay in `constraints`. |

## Next steps

1. Brian decides naming and release line; file the RFC issue (`rfc` label) from
   the Motivation, Scope, Alternatives and Compatibility sections above.
2. iHeartMedia answers the iHeart questions; TV and OOH sellers answer theirs.
3. WG review (seven-day minimum, two reviewers), decision record, then this PR
   (carrying `Refs #N`) moves out of draft.
4. Follow-ups: a storyboard for goal results and breakdown partitions, delivery
   dimension alignment (question 30), SDK types, certification impact.

## Reviewer checklist

- [ ] Motivation is clear and not redundant with existing functionality
      (table above says what exists and what is missing)
- [ ] Scope is specific enough to implement without further clarification
- [ ] Alternatives section covers at least one non-obvious alternative
- [ ] Compatibility impact accurately states breaking vs. non-breaking
- [ ] Wire-format or schema snippet included (the schemas, the guide page and
      `tests/fixtures/broadcast-planning/`)
