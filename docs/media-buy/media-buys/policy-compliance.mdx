---
title: Policy Compliance
---

# Policy Compliance

AdCP includes comprehensive policy compliance features to ensure brand safety and regulatory compliance across all advertising operations. This document explains how publishers should implement and enforce policy checks throughout the media buying lifecycle.

## Overview

Policy compliance in AdCP centers around the `promoted_offering` field - a required description of the advertiser and what is being promoted. This enables publishers to:

- Filter inappropriate advertisers before showing inventory
- Enforce category-specific restrictions
- Maintain brand safety standards
- Comply with regulatory requirements

## Promoted Offering Description

All product discovery and media buy creation requests must include a clear `promoted_offering` field that describes:

- The advertiser/brand making the request
- What is being promoted (product, service, cause, candidate, program, etc.)
- Key attributes or positioning of the offering

For comprehensive guidance on brief structure and the role of `promoted_offering`, see [Brief Expectations](../product-discovery/brief-expectations).

### Examples

Good promoted offering descriptions:
- "Nike Air Max 2024 - the latest innovation in cushioning technology featuring sustainable materials, targeting runners and fitness enthusiasts"
- "PetSmart's Spring Sale Event - 20% off all dog and cat food brands, plus free grooming consultation with purchase"
- "Biden for President 2024 - political campaign promoting Democratic candidate's re-election bid"

## Policy Check Implementation

Publishers must implement policy checks at two key points in the workflow:

### 1. During Product Discovery (`get_products`)

When a `get_products` request is received, the publisher should:

1. Validate that the `promoted_offering` is present and meaningful
2. Extract advertiser and category information
3. Check against publisher policies
4. Filter out unsuitable products

**Example Policy Check Flow:**
```python
def check_promoted_offering_policy(promoted_offering: str) -> PolicyResult:
    # Extract advertiser and category
    advertiser, category = extract_advertiser_info(promoted_offering)
    
    # Check blocked categories
    if category in BLOCKED_CATEGORIES:
        return PolicyResult(
            status="blocked",
            message=f"{category} advertising is not permitted on this publisher"
        )
    
    # Check restricted categories
    if category in RESTRICTED_CATEGORIES:
        return PolicyResult(
            status="restricted",
            message=f"{category} advertising requires manual approval",
            contact="sales@publisher.com"
        )
    
    return PolicyResult(status="allowed", category=category)
```

### 2. During Media Buy Creation (`create_media_buy`)

When creating a media buy:

1. Validate the `promoted_offering` against publisher policies
2. Ensure consistency with the campaign brief
3. Flag for manual review if needed
4. Return appropriate errors for violations

## Policy Compliance Responses

The protocol defines three compliance statuses:

### `allowed`
The promoted offering passes initial policy checks. Products are returned normally.

```json
{
  "products": [...],
  "policy_compliance": {
    "status": "allowed"
  }
}
```

### `restricted`
The advertiser category requires manual approval before products can be shown.

```json
{
  "products": [],
  "policy_compliance": {
    "status": "restricted",
    "message": "Cryptocurrency advertising is restricted but may be approved on a case-by-case basis.",
    "contact": "sales@publisher.com"
  }
}
```

### `blocked`
The advertiser category cannot be supported by this publisher.

```json
{
  "products": [],
  "policy_compliance": {
    "status": "blocked",
    "message": "Publisher policy prohibits alcohol advertising without age verification capabilities."
  }
}
```

## Creative Validation

All uploaded creatives should be validated against the declared `promoted_offering`:

1. **Automated Analysis**: Use creative recognition to verify brand consistency
2. **Human Review**: Manual verification for sensitive categories
3. **Continuous Monitoring**: Ongoing checks during campaign delivery

This ensures:
- Creative content matches the declared brand
- No misleading or deceptive advertising
- Brand safety for all parties

## Common Policy Categories

Publishers typically implement restrictions for:

### Blocked Categories
- Illegal products or services
- Prohibited content (varies by region)
- Categories requiring special licensing

### Restricted Categories (Manual Approval)
- Alcohol (may require age-gating)
- Gambling/Gaming
- Cryptocurrency/Financial services
- Political advertising
- Healthcare/Pharmaceuticals
- Dating services

### Special Requirements
- Political ads may require disclosure
- Healthcare may need disclaimers
- Financial services need compliance review

## Implementation Best Practices

1. **Clear Communication**: Provide specific reasons for restrictions
2. **Contact Information**: Include sales contact for restricted categories
3. **Consistent Enforcement**: Apply policies uniformly across all advertisers
4. **Documentation**: Maintain clear policy documentation for advertisers
5. **Appeals Process**: Allow advertisers to request policy exceptions

## Error Handling

For policy violations during media buy creation:

```json
{
  "error": {
    "code": "POLICY_VIOLATION",
    "message": "Offering category not permitted on this publisher",
    "field": "promoted_offering",
    "suggestion": "Contact publisher for category approval process"
  }
}
```

## Integration with HITL

Policy decisions can trigger Human-in-the-Loop workflows:

1. Restricted categories create `pending_manual` tasks
2. Human reviewers assess the campaign
3. Approval or rejection is communicated back
4. Campaign proceeds or is terminated based on decision

## Related Documentation

- [`get_products`](../task-reference/get_products) - Product discovery with policy checks
- [`create_media_buy`](../task-reference/create_media_buy) - Media buy creation with validation
- [Principals & Security](../advanced-topics/principals-and-security) - Authentication and authorization