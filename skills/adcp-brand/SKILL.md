---
name: adcp-brand
description: Execute AdCP Brand Protocol operations with brand agents - get brand identity data, search for licensable rights, acquire rights for campaigns, and manage existing grants. Use when users want to look up brand identities, find talent or IP for licensing, or manage rights grants.
---

# AdCP Brand Protocol

This skill enables you to execute the AdCP Brand Protocol with brand agents. The Brand Protocol provides access to brand identity, creative guidelines, and licensable rights (talent, IP, content).

> **Buyer-side basics** — idempotency replay, `oneOf` variants, async `status:'submitted'` polling, error recovery from `adcp_error.issues[]` — live in `skills/call-adcp-agent/SKILL.md`. This skill covers per-task semantics only.

## Overview

The Brand Protocol provides 4 standardized tasks:

| Task | Purpose | Response Time |
|------|---------|---------------|
| `get_brand_identity` | Get brand identity and guidelines | ~1-3s |
| `get_rights` | Search licensable rights | ~1-5s |
| `acquire_rights` | Acquire rights for a campaign | ~1-10s |
| `update_rights` | Modify an existing grant | ~1-5s |

## Typical Workflow

### Brand Identity Lookup
1. **Get identity**: `get_brand_identity` with brand domain and optional field filter
2. **Use data**: Apply colors, logos, tone, guidelines to creative generation

### Rights Licensing
1. **Search rights**: `get_rights` with natural language query and use types
2. **Review options**: Evaluate matches by pricing, availability, compatibility
3. **Acquire**: `acquire_rights` with selected pricing option and campaign details
4. **Manage**: `update_rights` to extend, adjust caps, or pause/resume

---

## Task Reference

### get_brand_identity

Get brand identity data from a brand agent.

**Request:**
```json
{
  "brand_id": "athlete-jane-doe",
  "fields": ["description", "logos", "colors", "tone"],
  "use_case": "creative_production",
  "authorized": true
}
```

**Key fields:**
- `brand_id` (string, required): Brand identifier within the agent's roster
- `fields` (array, optional): Sections to include — `description`, `industry`, `keller_type`, `logos`, `colors`, `fonts`, `visual_guidelines`, `tone`, `tagline`, `voice_synthesis`, `assets`, `rights`. Omit for all.
- `use_case` (string, optional): Intended use — `endorsement`, `voice_synthesis`, `likeness`, `creative_production`, `media_planning`
- `authorized` (boolean, optional): Sandbox only — simulate authorized access to see protected fields. Real agents use OAuth. Default false.

**Response contains:**
- `brand`: Brand identity object with requested fields
- Public fields (always available): `description`, `industry`, `logos` (public subset)
- Protected fields (require authorization): `colors`, `fonts`, `tone`, `voice_synthesis`, `visual_guidelines`, full `assets`

---

### get_rights

Search for licensable rights (talent, IP, content) from a brand agent.

**Request:**
```json
{
  "query": "Dutch athlete for restaurant brand in Amsterdam, budget 400 EUR/month",
  "uses": ["likeness", "endorsement"],
  "buyer_brand": {
    "domain": "restaurant.nl"
  },
  "countries": ["NL"],
  "include_excluded": false
}
```

**Key fields:**
- `query` (string, required): Natural language description of desired rights
- `uses` (array, required): Rights uses — `likeness`, `voice`, `name`, `endorsement`
- `buyer_brand` (object, optional): Buyer brand for compatibility filtering — `{ domain, brand_id }`
- `countries` (array, optional): Countries where rights are needed (ISO 3166-1 alpha-2)
- `brand_id` (string, optional): Search within a specific brand only
- `include_excluded` (boolean, optional): Include filtered-out results with reasons. Default false.

**Response contains:**
- `rights`: Array of matching rights offerings with:
  - `rights_id`: Use in `acquire_rights`
  - `brand_id`, `name`, `description`: Who/what the rights cover
  - `uses`: Available use types
  - `pricing_options`: Array with `pricing_option_id`, `price`, `currency`, `period`
  - `availability`: Geographic and temporal restrictions
  - `exclusions`: Any brand/category conflicts

---

### acquire_rights

Acquire rights from a brand agent for a campaign.

**Request:**
```json
{
  "rights_id": "rights_jane_doe_endorsement",
  "pricing_option_id": "monthly_standard",
  "buyer": {
    "domain": "restaurant.nl"
  },
  "campaign": {
    "description": "Social media campaign featuring athlete endorsement for Amsterdam restaurant launch",
    "uses": ["likeness", "endorsement"],
    "countries": ["NL"],
    "estimated_impressions": 500000,
    "start_date": "2025-03-01",
    "end_date": "2025-06-30"
  }
}
```

**Key fields:**
- `rights_id` (string, required): From `get_rights` response
- `pricing_option_id` (string, required): Selected pricing option
- `buyer` (object, required): Buyer brand identity — `{ domain, brand_id }`
- `campaign` (object, required): Campaign details for rights clearance
  - `description` (string, required): How the rights will be used
  - `uses` (array, required): Rights uses for this campaign
  - `countries` (array, optional): Campaign countries
  - `estimated_impressions` (integer, optional): Estimated total impressions
  - `start_date`, `end_date` (string, optional): Campaign dates (YYYY-MM-DD)

**Response contains:**
- `status`: `acquired`, `pending_approval`, or `rejected`
- `rights_grant_id`: Grant identifier (if acquired)
- `generation_credentials`: Credentials for AI generation (voice synthesis, likeness, etc.)
- `rejection_reason`: Why the request was rejected (category conflict, exclusivity, etc.)

---

### update_rights

Update an existing rights grant — extend dates, adjust impression caps, or pause/resume.

**Request:**
```json
{
  "rights_id": "grant_abc123",
  "end_date": "2025-09-30",
  "impression_cap": 1000000,
  "paused": false
}
```

**Key fields:**
- `rights_id` (string, required): Rights grant identifier from `acquire_rights`
- `end_date` (string, optional): New end date (must be >= current end date)
- `impression_cap` (number, optional): New impression cap (must be >= current)
- `paused` (boolean, optional): Pause or resume the grant

---

## Key Concepts

### Public vs Protected Fields

Brand agents distinguish between public and protected data:
- **Public**: Available without authorization — basic description, industry, public logos
- **Protected**: Requires OAuth or authorized flag — colors, fonts, tone, voice synthesis credentials, full asset library

### Rights Use Types

- `likeness`: Use of a person's visual likeness (photos, AI-generated images)
- `voice`: Voice synthesis or audio recording rights
- `name`: Use of a person's name in advertising
- `endorsement`: Endorsement/testimonial rights

### Rights Clearance

`acquire_rights` checks:
1. Brand/category compatibility (no competitor conflicts)
2. Geographic availability
3. Temporal availability
4. Existing exclusivity agreements

Results: `acquired` (immediate), `pending_approval` (human review), or `rejected` (with reason).

---

## Error Handling

Common error codes:

- `BRAND_NOT_FOUND`: Invalid brand_id
- `RIGHTS_NOT_FOUND`: Invalid rights_id
- `PRICING_OPTION_NOT_FOUND`: Invalid pricing_option_id
- `CATEGORY_CONFLICT`: Buyer brand conflicts with existing agreements
- `GEOGRAPHIC_RESTRICTION`: Rights not available in requested countries
- `AUTHORIZATION_REQUIRED`: Protected fields require OAuth
