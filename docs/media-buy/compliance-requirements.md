---
title: Compliance Requirements
---

# Compliance Requirements

This document defines standardized compliance requirement identifiers for the AdCP Media Buy Protocol. These identifiers are used in the `compliance_requirements` field of the `get_products` request to specify advertiser requirements.

## Age Verification and Gating

### Age-Based Access Control
- `age_gate_13_plus` - Content restricted to users 13 and older
- `age_gate_16_plus` - Content restricted to users 16 and older  
- `age_gate_18_plus` - Content restricted to users 18 and older
- `age_gate_21_plus` - Content restricted to users 21 and older (alcohol, gambling)
- `age_verification_required` - Publisher must verify user age through documented process

### Children's Privacy
- `coppa_compliant` - Compliant with Children's Online Privacy Protection Act (US)
- `no_behavioral_targeting_under_16` - No behavioral advertising to users under 16
- `parental_consent_required` - Requires verifiable parental consent for data collection

## Privacy and Data Protection

### Regional Privacy Laws
- `gdpr_compliant` - General Data Protection Regulation (EU)
- `ccpa_compliant` - California Consumer Privacy Act
- `lgpd_compliant` - Lei Geral de Proteção de Dados (Brazil)
- `pipeda_compliant` - Personal Information Protection and Electronic Documents Act (Canada)
- `privacy_shield_certified` - EU-US Privacy Shield certification

### Consent and Transparency
- `explicit_consent_required` - User must explicitly consent to data collection
- `tcf_v2_compliant` - IAB Europe Transparency & Consent Framework v2.0
- `gpp_compliant` - IAB Tech Lab Global Privacy Platform

## Regulated Industries

### Alcohol Advertising
- `alcohol_age_gated` - Age verification for alcohol advertising
- `responsible_drinking_messaging` - Must include responsible drinking message
- `no_appeal_to_minors` - Cannot appeal to minors in creative or placement

### Gambling and Gaming
- `gambling_age_verified` - Age verification for gambling advertising
- `responsible_gambling_messaging` - Must include responsible gambling message
- `self_exclusion_list_check` - Check against gambling self-exclusion lists
- `gambling_license_verified` - Advertiser gambling license verified

### Pharmaceutical and Healthcare
- `pharma_dtc_compliant` - Direct-to-consumer pharmaceutical advertising compliant
- `healthcare_hipaa_compliant` - HIPAA compliant for healthcare data
- `prescription_drug_disclosures` - Required disclosures for prescription drugs
- `fda_approved_claims_only` - Only FDA-approved claims allowed

### Financial Services
- `financial_disclosures_required` - Required financial disclosures present
- `investment_risk_warnings` - Investment risk warnings required
- `lending_apr_disclosure` - APR disclosure for lending products
- `cryptocurrency_risk_disclosure` - Cryptocurrency investment risk disclosures

## Political and Issue Advertising

### Political Advertising
- `political_ad_disclosure` - Political advertiser disclosure required
- `political_ad_archive` - Ads must be archived in public database
- `election_silence_period` - Compliance with election silence periods
- `political_microtargeting_restricted` - Restrictions on political microtargeting

### Issue-Based Advertising
- `issue_ad_disclosure` - Disclosure for issue-based advertising
- `foreign_entity_restriction` - No foreign entities for political/issue ads

## Content and Creative Standards

### General Content Standards
- `no_misleading_claims` - No false or misleading advertising claims
- `substantiation_required` - Claims must be substantiated
- `clear_advertiser_identification` - Clear identification of advertiser

### Sensitive Content
- `no_discriminatory_content` - No discriminatory advertising
- `no_harmful_content` - No content promoting self-harm or violence
- `content_rating_appropriate` - Content appropriate for placement rating

## Industry-Specific Requirements

### Automotive
- `auto_dealer_disclosure` - Dealer information disclosure required
- `vehicle_pricing_disclosures` - Required pricing disclosures for vehicles

### Real Estate
- `fair_housing_compliant` - Fair Housing Act compliance
- `real_estate_license_disclosure` - Real estate license disclosure

### Employment
- `equal_opportunity_employer` - Equal opportunity employment compliance
- `no_discriminatory_hiring` - No discriminatory hiring practices

## Technical and Operational

### Ad Quality
- `brand_safety_verified` - Brand safety verification required
- `malware_free_certified` - Certified malware-free creatives
- `viewability_standards_met` - Meets IAB viewability standards

### Measurement and Verification
- `third_party_verification` - Third-party ad verification allowed
- `measurement_pixels_allowed` - Measurement pixels permitted
- `impression_tracking_transparent` - Transparent impression tracking

## Usage Notes

### For Advertisers
When making a `get_products` request, include relevant compliance requirements:

```json
{
  "promoted_offering": "Heineken 0.0 non-alcoholic beer - taste of beer without the alcohol",
  "compliance_requirements": ["alcohol_age_gated", "responsible_drinking_messaging"]
}
```

### For Publishers
Publishers should:
1. Map these standardized requirements to their internal capabilities
2. Return appropriate policy_compliance status based on what they can support
3. Include `met_requirements` and `unmet_requirements` in responses

### Extensibility
This list is not exhaustive. Publishers may support additional compliance requirements not listed here. The protocol allows for custom requirements with the following naming convention:
- Publisher-specific: `publisher_name:requirement`
- Region-specific: `region:requirement` (e.g., `uk:ofcom_compliant`)
- Industry-specific: `industry:requirement` (e.g., `gaming:esrb_rated`)

## Future Considerations

As regulations evolve, new compliance requirements may be added to this specification. Key areas to monitor:
- AI-generated content disclosure requirements
- Sustainability and environmental claims
- Accessibility standards compliance
- Cross-border data transfer requirements