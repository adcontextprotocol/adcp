---
sidebar_label: Example Briefs
title: Example Campaign Briefs
---

# Example Campaign Briefs

These annotated examples demonstrate how to create effective campaign briefs at different complexity levels, showcasing the progression from essential elements to comprehensive strategies.

## 1. Minimal Brief: Essential Elements

### Local Service Business Campaign

```json
{
  "advertiser": "Mike's Plumbing Services",
  "promoted_offering": "24/7 emergency plumbing repairs and routine maintenance in Denver metro area",
  "objectives": "Drive phone calls for service appointments",
  "flight_dates": "October 15-31, 2024",
  "budget": "$8,000"
}
```

**Why This Works:**
- ✅ **Clear advertiser and offering** - Specifies service type and geographic scope
- ✅ **Specific objective** - "Phone calls" is measurable and actionable
- ✅ **Defined budget and timing** - Realistic for local service campaign
- ⚠️ **Could improve** - Add target CPA ($40-60 per call typical for plumbing)
- ⚠️ **Missing** - Audience definition (homeowners, property managers)

**Publisher Response:**
Publishers will likely recommend:
- Local inventory products with call tracking
- Mobile-first placements (emergency searches)
- Request clarification on success metrics
- Suggest dayparting for emergency service hours

**AdCP Workflow:**
1. `get_products` - Query local inventory with geographic constraints
2. `list_creative_formats` - Identify call-to-action enabled formats
3. `create_media_buy` - Submit with phone tracking requirements

---

## 2. Standard Brief: Audience + Metrics

### E-commerce Product Launch

```json
{
  "advertiser": "TechGear Pro",
  "promoted_offering": "New ANC-Pro wireless headphones with 40-hour battery life, premium audio drivers",
  
  "objectives": {
    "primary": "Drive online sales during launch week",
    "secondary": "Build brand awareness in audio enthusiast community"
  },
  
  "target_audience": {
    "demographics": "Ages 25-45, household income $50K+",
    "interests": "Technology, music, fitness, travel",
    "behaviors": "Early tech adopters, premium audio purchasers"
  },
  
  "success_metrics": {
    "ctr": "0.8-1.2%",
    "cpa": "$45-55",
    "roas": "300%",
    "conversion_rate": "2.5%"
  },
  
  "flight_dates": "November 1-14, 2024",
  "budget": "$25,000",
  
  "creative_requirements": "Product demos, lifestyle imagery, launch offer messaging"
}
```

**Why This Works:**
- ✅ **Realistic metrics** - CTR of 0.8-1.2% achievable for targeted campaigns
- ✅ **Clear audience definition** - Actionable demographic and behavioral signals
- ✅ **Multiple success metrics** - Allows optimization flexibility
- ✅ **Appropriate budget** - $25K reasonable for 2-week product launch
- ⚠️ **Could improve** - Specify creative formats needed (video vs. display)
- ⚠️ **Missing** - Competitive considerations, measurement preferences

**Publisher Response:**
Publishers will optimize for:
- Audience matching against tech/audio enthusiast segments
- Performance optimization toward CPA goals
- Creative format recommendations based on inventory
- Suggest retargeting pool creation

**AdCP Workflow:**
1. `get_products` with filters for audience targeting capabilities
2. `list_creative_formats` to match product demo requirements
3. Signal activation for tech enthusiast audiences
4. Performance monitoring via `get_media_buy_delivery`

---

## 3. Comprehensive Brief: Full Strategy

### B2B Software Campaign

```json
{
  "advertiser": "CloudSync Solutions",
  "promoted_offering": "Enterprise data synchronization platform for hybrid cloud environments",
  
  "campaign_context": "Q4 push to meet annual pipeline targets, focusing on enterprises actively evaluating cloud migration strategies",
  
  "business_objectives": {
    "immediate": "Generate 150 Marketing Qualified Leads (MQLs)",
    "quarterly": "Build pipeline of $2M in opportunities",
    "strategic": "Position as leader in hybrid cloud data management"
  },
  
  "target_audience": {
    "firmographics": {
      "company_size": "500-5000 employees",
      "industries": ["financial_services", "healthcare", "retail", "manufacturing"],
      "technology": "Multi-cloud environment (AWS, Azure, GCP)"
    },
    "personas": {
      "primary": "IT Directors, Cloud Architects, CTOs",
      "secondary": "DevOps Engineers, Data Engineers",
      "influencers": "IT Consultants, System Integrators"
    },
    "signals": {
      "intent": "Researching cloud migration, data sync, hybrid cloud",
      "technographic": "Using Kubernetes, Docker, cloud-native tools",
      "competitive": "Visiting competitor sites (Informatica, Talend, MuleSoft)"
    }
  },
  
  "success_metrics": {
    "lead_generation": {
      "mql_target": "150 leads",
      "cost_per_mql": "$200-250",
      "mql_to_sql_rate": "30%"
    },
    "engagement": {
      "content_downloads": "500 whitepapers/guides",
      "demo_requests": "50 qualified demos",
      "webinar_registrations": "200 attendees"
    },
    "brand": {
      "site_traffic_lift": "25%",
      "branded_search_increase": "40%"
    }
  },
  
  "campaign_execution": {
    "flight_dates": "October 1 - December 31, 2024",
    "budget": {
      "total": "$90,000",
      "monthly": "$30,000",
      "allocation": {
        "lead_gen": "60%",
        "brand_awareness": "25%",
        "retargeting": "15%"
      }
    },
    "geographic_focus": {
      "primary": ["US", "Canada"],
      "secondary": ["UK", "Germany"]
    }
  },
  
  "creative_and_messaging": {
    "formats_needed": {
      "display": ["300x250", "728x90", "160x600"],
      "video": ["in-stream_15s", "in-stream_30s"],
      "native": ["sponsored_content", "in-feed_units"]
    },
    "messaging_framework": {
      "pain_points": "Data silos, sync failures, compliance risks",
      "value_props": "Real-time sync, zero downtime, SOC2 certified",
      "proof_points": "Fortune 500 case studies, Gartner recognition"
    },
    "content_assets": {
      "whitepapers": "Hybrid Cloud Best Practices Guide",
      "case_studies": "Financial Services Digital Transformation",
      "demo_videos": "5-minute platform overview"
    }
  },
  
  "measurement_and_privacy": {
    "attribution": "Multi-touch with 30-day window",
    "analytics": "Google Analytics 4, Salesforce integration",
    "privacy": "GDPR/CCPA compliant, no third-party cookies",
    "brand_safety": "No competitor adjacency, B2B environments only"
  },
  
  "adcp_workflow": {
    "product_discovery": "Query B2B inventory with ABM capabilities",
    "format_matching": "Professional formats supporting lead capture",
    "signal_activation": "Intent and technographic data providers",
    "approval_required": "Legal review for compliance claims"
  }
}
```

**Why This Works:**
- ✅ **Complete strategic context** - Clear business goals and constraints
- ✅ **Detailed audience definition** - Firmographics, personas, and signals
- ✅ **Comprehensive metrics** - Lead gen, engagement, and brand KPIs
- ✅ **AdCP-specific workflow** - Shows protocol integration points
- ✅ **Privacy-forward approach** - GDPR/CCPA compliance specified
- ✅ **Realistic B2B economics** - $200-250 CPL standard for enterprise

**Publisher Optimization:**
- ABM platform activation for target account lists
- Intent data integration for in-market buyers
- LinkedIn and professional publisher prioritization
- Lead quality scoring and feedback loops

---

## 4. Complex Multi-Phase: Advanced Orchestration

### Automotive Model Launch

```json
{
  "advertiser": "EcoMotion Automotive",
  "promoted_offering": "2025 EcoMotion Hybrid SUV - Luxury hybrid with 500-mile range",
  
  "campaign_overview": "Three-phase launch targeting eco-conscious families transitioning from traditional luxury SUVs",
  
  "phased_execution": {
    "phase_1_awareness": {
      "dates": "October 1-31, 2024",
      "budget": "$200,000",
      "objectives": "Build awareness, reach 10M unique users",
      "success_metrics": {
        "reach": "10M uniques",
        "frequency": "3-5x",
        "video_completion_rate": "70%",
        "brand_lift": "12% awareness increase"
      },
      "formats_discovery": {
        "connected_tv": "30-second spots during family programming",
        "online_video": "15-second and 6-second bumpers",
        "display": "High-impact takeovers on auto sites"
      }
    },
    
    "phase_2_consideration": {
      "dates": "November 1-30, 2024",
      "budget": "$150,000",
      "objectives": "Drive configurator sessions and brochure downloads",
      "success_metrics": {
        "configurator_sessions": "50,000",
        "cost_per_session": "$3.00",
        "brochure_downloads": "10,000",
        "site_engagement_time": "3+ minutes"
      },
      "audience_refinement": {
        "retargeting": "Phase 1 video completers",
        "lookalikes": "Current hybrid owners",
        "conquest": "Competitive SUV intenders"
      }
    },
    
    "phase_3_conversion": {
      "dates": "December 1-31, 2024",
      "budget": "$100,000",
      "objectives": "Generate test drive appointments",
      "success_metrics": {
        "test_drives": "500 appointments",
        "cost_per_appointment": "$200",
        "dealer_locator_uses": "5,000",
        "appointment_show_rate": "70%"
      },
      "activation_strategy": {
        "geo_targeting": "10-mile radius of dealers",
        "dayparting": "Weekends and evenings",
        "weather_triggers": "Activate during good weather"
      }
    }
  },
  
  "audience_strategy": {
    "primary": {
      "demographics": "HHI $75K-150K, ages 35-55, families",
      "psychographics": "Environmentally conscious, tech-savvy, safety-focused",
      "behaviors": "SUV owners, outdoor enthusiasts, suburban lifestyle"
    },
    "signals": {
      "auto_intender": "In-market for SUVs",
      "green_interests": "EV/hybrid research, environmental content",
      "competitive": "Visiting Toyota Highlander, Honda Pilot pages"
    }
  },
  
  "creative_specifications": {
    "asset_requirements": {
      "video": {
        "hero_30s": "1920x1080, 16:9, max 50MB",
        "social_15s": "1080x1080, 1:1, max 30MB",
        "mobile_vertical": "1080x1920, 9:16, max 40MB"
      },
      "display": {
        "standard_sizes": "300x250, 728x90, 320x50",
        "rich_media": "HTML5 with 360-degree view",
        "file_size": "Max 150KB initial load"
      }
    },
    "dynamic_elements": {
      "dealer_locator": "Real-time nearest dealer",
      "inventory_status": "Available colors/trims",
      "incentive_offers": "Regional lease/finance offers"
    }
  },
  
  "measurement_framework": {
    "attribution": "Data-driven attribution with store visit tracking",
    "brand_study": "Control/exposed lift measurement",
    "incrementality": "Geo-experiments in 5 test markets",
    "competitive": "Share of voice and consideration tracking"
  },
  
  "adcp_integration": {
    "workflow": [
      "get_products: Query automotive inventory with CTV capability",
      "list_creative_formats: Discover video and rich media options",
      "activate_signal: Auto intender and green interest signals",
      "create_media_buy: Submit phased campaign with approval gates",
      "sync_creatives: Upload video and display assets per phase",
      "get_media_buy_delivery: Daily performance monitoring",
      "update_media_buy: Optimize based on phase performance"
    ],
    "approval_requirements": {
      "legal": "Claim substantiation for MPG/range",
      "brand": "Creative and placement approval",
      "dealer": "Regional offer coordination"
    }
  }
}
```

**Why This Works:**
- ✅ **Sophisticated phasing** - Clear progression through funnel
- ✅ **Detailed technical specs** - Asset requirements and file sizes
- ✅ **Advanced targeting** - Signals, weather triggers, dayparting
- ✅ **Complete AdCP workflow** - All protocol tools demonstrated
- ✅ **Realistic automotive KPIs** - $200 per test drive achievable
- ✅ **Multi-stakeholder coordination** - Legal, brand, dealer alignment

---

## Industry Quick Reference

### Key Considerations by Vertical

#### Financial Services
- **Compliance**: FINRA, truth in advertising, fair lending
- **Targeting restrictions**: No credit score or medical targeting
- **Success metrics**: Account opens, funded accounts, AUM growth
- **Typical CPAs**: $100-300 per funded account
- **Creative requirements**: Disclaimers, FDIC/SIPC notices

#### Healthcare
- **Privacy**: HIPAA compliance, no condition targeting
- **Geographic**: Service area restrictions
- **Metrics**: Appointment bookings, patient acquisition
- **Typical costs**: $30-80 per appointment
- **Requirements**: Provider credentials, insurance accepted

#### Streaming/Entertainment
- **Objectives**: Trial starts, subscriber retention
- **Metrics**: Cost per trial, trial-to-paid conversion
- **Typical costs**: $20-50 per trial start
- **Creative**: Content highlights, exclusive programming

#### Retail/E-commerce
- **Seasonality**: Holiday, back-to-school, Prime Day
- **Metrics**: ROAS, cart value, repeat purchase rate
- **Typical ROAS**: 300-500% for established brands
- **Formats**: Shopping ads, dynamic product ads

#### Mobile Apps
- **Objectives**: Installs, DAU, retention
- **Metrics**: CPI, D7/D30 retention, LTV
- **Typical CPI**: $2-5 for non-gaming apps
- **Requirements**: App store links, deep linking

---

## Brief Evaluation Checklist

Before submitting your brief, ensure you have:

### Essential Elements
- [ ] Advertiser name and promoted offering
- [ ] Clear business objectives
- [ ] Budget and flight dates
- [ ] Geographic scope (if applicable)

### Recommended Elements
- [ ] Target audience definition
- [ ] Success metrics with targets
- [ ] Creative format preferences
- [ ] Brand safety requirements

### Advanced Elements
- [ ] Signal activation requirements
- [ ] Measurement framework
- [ ] Privacy compliance needs
- [ ] Approval workflow requirements

---

## Related Documentation

- [Brief Expectations](./brief-expectations.md) - Processing guidelines and requirements
- [Media Buy Lifecycle](./media-buy-lifecycle.md) - Campaign execution workflow
- [Creative Formats](./creative-formats.md) - Available format specifications
- [Targeting Dimensions](./targeting-dimensions.md) - Audience capabilities