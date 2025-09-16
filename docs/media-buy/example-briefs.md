---
sidebar_label: Example Briefs
title: Example Campaign Briefs
---

# Example Campaign Briefs

These annotated examples demonstrate how natural language briefs work in AdCP, showing progression from essential elements to comprehensive campaign strategies.

## 1. Minimal Brief: Essential Elements

### Local Service Business Campaign

```json
{
  "brief": "Mike's Plumbing Services needs to drive phone calls for emergency plumbing repairs and routine maintenance in the Denver metro area. We have $8,000 to spend from October 15-31, 2024. Looking for local inventory that can drive calls, ideally during emergency hours when people need immediate service."
}
```

**Why This Works:**
- ✅ **Clear advertiser and offering** - Specifies service type and geographic scope
- ✅ **Specific objective** - "Phone calls" is measurable and actionable
- ✅ **Defined budget and timing** - Realistic for local service campaign
- ⚠️ **Could improve** - Add target CPA ($40-60 per call typical for plumbing)
- ⚠️ **Missing** - Audience definition (homeowners, property managers)

**Publisher Response:**
Publishers will likely:
- Parse "Denver metro area" for geographic targeting
- Identify "phone calls" as conversion goal
- Recommend local inventory with call tracking
- Suggest mobile-first placements for emergency searches
- Request clarification on success metrics

**AdCP Workflow:**
1. `get_products` - Query with filters matching brief requirements
2. `list_creative_formats` - Identify call-to-action enabled formats
3. `create_media_buy` - Submit with brief and selected products

---

## 2. Standard Brief: Audience + Metrics

### E-commerce Product Launch

```json
{
  "brief": "TechGear Pro is launching our new ANC-Pro wireless headphones with 40-hour battery life and premium audio drivers. Our goal is to drive online sales during launch week (November 1-14, 2024) with a secondary objective of building brand awareness in the audio enthusiast community. Target audience is ages 25-45 with household income $50K+, interested in technology, music, fitness, and travel - early tech adopters who buy premium audio products. Success metrics: 0.8-1.2% CTR, $45-55 CPA, 300% ROAS, 2.5% conversion rate. Budget is $25,000. Need creative that showcases product demos, lifestyle imagery, and launch offer messaging."
}
```

**Why This Works:**
- ✅ **Realistic metrics** - CTR of 0.8-1.2% achievable for targeted campaigns
- ✅ **Clear audience definition** - Actionable demographic and behavioral signals
- ✅ **Multiple success metrics** - Allows optimization flexibility
- ✅ **Appropriate budget** - $25K reasonable for 2-week product launch
- ✅ **Creative direction** - Helps with format selection

**Publisher Response:**
Publishers will:
- Extract demographic targeting (25-45, $50K+ HHI)
- Build interest segments (technology, music, fitness, travel)
- Optimize toward specified CPA and ROAS goals
- Match creative requirements to available formats
- Create retargeting pools for launch period

**AdCP Workflow:**
1. `get_products` - Filter for audience targeting capabilities
2. `list_creative_formats` - Match product demo requirements
3. `create_media_buy` - Include full brief with success metrics
4. `get_media_buy_delivery` - Monitor against KPI targets

---

## 3. Comprehensive Brief: Full Strategy

### B2B Software Campaign

```json
{
  "brief": "CloudSync Solutions needs to generate 150 Marketing Qualified Leads (MQLs) for our enterprise data synchronization platform for hybrid cloud environments. This is our Q4 push to meet annual pipeline targets, focusing on enterprises actively evaluating cloud migration strategies. We need to build a pipeline of $2M in opportunities while positioning ourselves as the leader in hybrid cloud data management.\n\nTarget companies with 500-5000 employees in financial services, healthcare, retail, and manufacturing that use multi-cloud environments (AWS, Azure, GCP). Decision makers include IT Directors, Cloud Architects, and CTOs, with DevOps Engineers and Data Engineers as secondary targets. Also want to reach IT Consultants and System Integrators who influence decisions.\n\nLook for signals indicating intent around cloud migration, data sync, and hybrid cloud research. Target companies using Kubernetes, Docker, and cloud-native tools. Include competitive conquest against visitors to Informatica, Talend, and MuleSoft.\n\nSuccess metrics: 150 MQLs at $200-250 per lead with 30% MQL-to-SQL conversion rate. Also targeting 500 whitepaper downloads, 50 qualified demo requests, and 200 webinar registrations. For brand metrics, looking for 25% site traffic lift and 40% increase in branded search.\n\nCampaign runs October 1 - December 31, 2024 with $90,000 total budget ($30,000 monthly). Allocate 60% to lead gen, 25% to brand awareness, and 15% to retargeting. Focus on US and Canada primarily, with UK and Germany as secondary markets.\n\nNeed display formats (300x250, 728x90, 160x600), video (15s and 30s in-stream), and native (sponsored content and in-feed units). Messaging should address pain points like data silos, sync failures, and compliance risks. Emphasize our real-time sync, zero downtime, and SOC2 certification. Use Fortune 500 case studies and Gartner recognition as proof points.\n\nContent assets include our Hybrid Cloud Best Practices Guide whitepaper, Financial Services Digital Transformation case study, and 5-minute platform overview video. Require multi-touch attribution with 30-day window, Google Analytics 4 and Salesforce integration. Must be GDPR/CCPA compliant with no third-party cookies. No competitor adjacency and B2B environments only for brand safety."
}
```

**Why This Works:**
- ✅ **Complete context** - Business goals, timeline, and constraints clear
- ✅ **Detailed targeting** - Firmographics, personas, and intent signals
- ✅ **Comprehensive metrics** - Lead gen, engagement, and brand KPIs
- ✅ **Budget allocation** - Clear spending priorities
- ✅ **Content strategy** - Specific assets and messaging framework
- ✅ **Compliance requirements** - Privacy and brand safety specified

**Publisher Response:**
Publishers will:
- Activate ABM platforms for target account lists
- Integrate intent data for in-market identification
- Prioritize LinkedIn and B2B publisher inventory
- Set up lead quality scoring and feedback loops
- Implement specified attribution and analytics
- Ensure GDPR/CCPA compliance in targeting

---

## 4. Complex Multi-Phase: Advanced Orchestration

### Automotive Model Launch

```json
{
  "brief": "EcoMotion Automotive is launching the 2025 EcoMotion Hybrid SUV, our first luxury hybrid with 500-mile range targeting eco-conscious families transitioning from traditional luxury SUVs. This is a three-phase campaign with different objectives and budgets for each phase.\n\nPHASE 1 - AWARENESS (October 1-31, 2024, $200,000):\nBuild awareness reaching 10M unique users with 3-5x frequency. Success metrics: 70% video completion rate and 12% brand lift. Need connected TV (30-second spots during family programming), online video (15-second and 6-second bumpers), and high-impact display takeovers on auto sites.\n\nPHASE 2 - CONSIDERATION (November 1-30, 2024, $150,000):\nDrive 50,000 configurator sessions at $3.00 cost per session and 10,000 brochure downloads. Expecting 3+ minute site engagement. Retarget Phase 1 video completers, create lookalikes from current hybrid owners, and conquest competitive SUV intenders.\n\nPHASE 3 - CONVERSION (December 1-31, 2024, $100,000):\nGenerate 500 test drive appointments at $200 per appointment with 70% show rate. Expect 5,000 dealer locator uses. Target 10-mile radius around dealers, focus on weekends and evenings, activate during good weather conditions.\n\nPRIMARY AUDIENCE:\nHouseholds with $75K-150K income, ages 35-55 with families. Environmentally conscious, tech-savvy, safety-focused. Current SUV owners, outdoor enthusiasts with suburban lifestyle. Target in-market SUV shoppers researching EVs/hybrids and environmental content. Conquest shoppers looking at Toyota Highlander and Honda Pilot.\n\nCREATIVE REQUIREMENTS:\nVideo assets: Hero 30s (1920x1080, 16:9, max 50MB), Social 15s (1080x1080, 1:1, max 30MB), Mobile vertical (1080x1920, 9:16, max 40MB). Display: Standard sizes (300x250, 728x90, 320x50) plus HTML5 rich media with 360-degree vehicle view (max 150KB initial load). Include dynamic elements: real-time nearest dealer, available colors/trims, regional lease/finance offers.\n\nMEASUREMENT:\nImplement data-driven attribution with store visit tracking. Run control/exposed brand lift study. Set up geo-experiments in 5 test markets. Track share of voice and consideration versus competitors.\n\nAPPROVAL REQUIREMENTS:\nLegal review needed for MPG and range claims. Brand team approval for creative and placements. Coordinate with dealer network for regional offers.\n\nPRIMARY MARKETS:\nCalifornia (Los Angeles, San Francisco, San Diego), Northeast (New York, Boston, Philadelphia), Pacific Northwest (Seattle, Portland), Texas (Austin, Dallas, Houston)."
}
```

**Why This Works:**
- ✅ **Sophisticated phasing** - Clear progression through purchase funnel
- ✅ **Phase-specific KPIs** - Different metrics for each objective
- ✅ **Detailed technical specs** - Asset requirements clearly defined
- ✅ **Advanced targeting** - Weather triggers, dayparting, geo-radius
- ✅ **Multi-stakeholder needs** - Legal, brand, and dealer coordination
- ✅ **Realistic automotive metrics** - $200 per test drive is achievable

**Publisher Orchestration:**
Publishers will:
- Set up sequential campaign phases with different objectives
- Implement audience pools that flow between phases
- Configure weather-based activation triggers
- Coordinate dealer inventory feeds for dynamic creative
- Establish brand study and incrementality testing
- Manage approval workflows for claims and creative

---

## Industry Quick Reference

### How Different Industries Structure Briefs

#### Financial Services
```json
{
  "brief": "NextGen Banking launching high-yield savings account with 4.5% APY, no minimum balance, no fees. Target mass affluent consumers ($100K+ income, ages 30-60) currently with traditional banks. Need to generate 5,000 funded accounts at $150 CAC. Must include FDIC insurance messaging and comply with FINRA regulations. No credit score or medical condition targeting. Campaign runs January with $400,000 budget."
}
```

#### Healthcare
```json
{
  "brief": "HealthFirst Urgent Care needs to build awareness and drive appointment bookings for our 15 Ohio clinic locations. Target families with children and adults 25-65 within 10-mile radius of each clinic. Goal is 500 online appointments at $30-50 per appointment. Emphasize minimal wait times and online scheduling. Must be HIPAA compliant with no health condition targeting. $20,000 monthly ongoing budget."
}
```

#### Streaming Service
```json
{
  "brief": "StreamPlus Entertainment promoting new streaming service with exclusive original content and live sports during Q4 free trial promotion. Target cord-cutters and streaming enthusiasts aged 25-54 in NFL markets. Drive trial sign-ups at $25 cost per trial with 60% trial-to-paid conversion goal. Need video creative highlighting exclusive content. $2M Q4 2024 budget."
}
```

#### Mobile App
```json
{
  "brief": "FitTrack Fitness App needs 50,000 installs in January 2025 for our AI-powered personal training app. Target fitness enthusiasts and New Year resolution makers. $3.50 target CPI with 30% day-7 retention. Need video demos of app features and before/after testimonials. $175,000 budget. Requires iOS and Android app store links with deep linking support."
}
```

---

## Brief Writing Best Practices

### Structure Your Brief Effectively

1. **Start with the essentials**
   - Who you are (advertiser/brand)
   - What you're promoting
   - Core objective
   - Budget and timing

2. **Add targeting details**
   - Demographics and firmographics
   - Interests and behaviors
   - Intent signals
   - Geographic markets

3. **Specify success metrics**
   - Primary KPIs with targets
   - Secondary metrics
   - Attribution preferences

4. **Include creative requirements**
   - Format preferences
   - Asset specifications
   - Messaging guidelines
   - Dynamic elements

5. **Note compliance needs**
   - Industry regulations
   - Privacy requirements
   - Brand safety
   - Approval workflows

### Natural Language Tips

- **Be specific but conversational** - Write as you would explain to a colleague
- **Group related information** - Keep audience details together, metrics together
- **Use industry-standard terms** - CPM, CPA, ROAS are understood
- **Include context** - Why this campaign, why now
- **Specify what's flexible** - "Prefer video but open to display if performance better"

---

## Brief Evaluation Checklist

Before submitting your brief, ensure it includes:

### Essential Elements
- [ ] Advertiser name and promoted offering
- [ ] Clear business objectives
- [ ] Budget and flight dates
- [ ] Geographic scope (if applicable)

### Recommended Elements
- [ ] Target audience description
- [ ] Success metrics with targets
- [ ] Creative format preferences
- [ ] Brand safety requirements

### Advanced Elements
- [ ] Intent signals to activate
- [ ] Measurement framework
- [ ] Privacy compliance needs
- [ ] Approval workflow requirements

---

## Related Documentation

- [Brief Expectations](./brief-expectations.md) - How publishers process briefs
- [Media Buy Lifecycle](./media-buy-lifecycle.md) - Campaign execution workflow
- [Creative Formats](./creative-formats.md) - Available format specifications
- [Targeting Dimensions](./targeting-dimensions.md) - Audience capabilities