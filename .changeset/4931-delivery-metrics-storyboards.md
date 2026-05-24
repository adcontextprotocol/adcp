---
"adcontextprotocol": patch
---

Add 3.1 compliance storyboards for `reach_window` and `viewability.viewed_seconds` in delivery reporting.

`reach_buy_flow.yaml` now covers cumulative, period, and rolling `reach_window` delivery rows, including the required `period` shape for period and rolling windows. It also adds a permanent advisory for reach rows that omit `reach_window`, which remain schema-valid but are not safe for buyers to sum or average across reporting periods.

`delivery_reporting.yaml` now includes a viewability-capable vCPM video buy and verifies that simulated delivery reports surface `viewability.viewed_seconds` alongside measurable impressions, viewable rate, and the viewability standard.

`comply-test-controller-request.json` and the controller docs now declare typed `simulate_delivery` params for `reach`, `frequency`, `reach_window`, and `viewability` so storyboard examples have a schema-grounded controller contract.

The training-agent controller now persists those simulated metrics and returns them through `get_media_buy_delivery`, keeping the reference sandbox aligned with the new storyboard coverage.
