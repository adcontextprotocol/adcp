---
name: adcp-deals
description: Execute AdCP Deals Protocol operations - create and manage PMP, PG, and AP deals with sales agents. Use when users want to create deals, negotiate terms, activate deals on DSP/SSP, or get deal diagnostics.
---

# AdCP Deals Protocol

This skill enables you to execute the AdCP Deals Protocol with sales agents. Use the standard MCP tools (`create_deal`, `list_deals`, `update_deal_terms`, `transition_deal_state`, `activate_deal`, etc.) exposed by the connected agent.

## Overview

The Deals Protocol provides tasks for deal lifecycle, activation, and diagnostics:

| Task | Purpose |
|------|---------|
| `get_products` | Discover products with deal support (filter by transaction_type: PMP, PG, AP) |
| `create_deal` | Create a logical deal (starts PROPOSED or DRAFT) |
| `list_deals` | List/filter deals; use deal_ids for single-deal fetch |
| `update_deal_terms` | Negotiate/counter-offer (versioned terms) |
| `transition_deal_state` | Accept, schedule, pause, reject, cancel, complete |
| `activate_deal` | Make deal transact-able on DSP/SSP |
| `get_deal_activation_status` | Per-destination activation status |
| `list_deal_mappings` | Logical-to-physical deal ID mappings |
| `get_deal_metrics` | Canonical deal reporting |
| `get_deal_diagnostics` | Health, root causes, recommendations |

## Typical Workflow

1. **Discover products**: `get_products` with filters.transaction_type (PMP, PG, or AP)
2. **Create deal**: `create_deal` with product_id, transaction_type, terms
3. **Negotiate**: `update_deal_terms` as needed; then `transition_deal_state` to ACCEPTED
4. **Activate**: `activate_deal` with destinations (DSP/SSP)
5. **Monitor**: `get_deal_metrics`, `get_deal_diagnostics`
