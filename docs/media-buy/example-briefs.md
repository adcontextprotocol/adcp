---
sidebar_label: Example Briefs
title: Example Campaign Briefs
---

# Example Campaign Briefs

These annotated examples demonstrate how natural language briefs work in AdCP for audience-enabled media buying, showing progression from basic to sophisticated targeting strategies.

## 1. Minimal Brief: Essential Elements

### Local Service Business

```json
{
  "brief": "Mike's Plumbing Services needs to reach homeowners in the Denver metro area who might need emergency plumbing repairs or routine maintenance. We have $8,000 to spend from October 15-31, 2024. Looking to drive phone calls for service appointments."
}
```

**Why This Works:**
- ✅ **Clear advertiser** - Mike's Plumbing Services
- ✅ **Target audience** - Homeowners in Denver metro
- ✅ **Objective** - Drive phone calls
- ✅ **Budget and timing** - $8,000 over 2 weeks
- ⚠️ **Could improve** - Add more audience details (age, income)

**Publisher Interpretation:**
- Geographic targeting: Denver DMA
- Audience: Homeowners (property owners)
- Optimization goal: Phone call conversions
- Budget pacing: ~$500/day

---

## 2. Standard Brief: Clear Audience Definition

### E-commerce Product Launch

```json
{
  "brief": "TechGear Pro is launching new wireless headphones. We need to reach tech enthusiasts and early adopters aged 25-45 with household income over $50K who are interested in premium audio, music, fitness, and travel. Campaign runs November 1-14, 2024 with $25,000 budget. Goal is to drive online sales with target CPA of $45-55."
}
```

**Why This Works:**
- ✅ **Demographic targeting** - Age 25-45, HHI $50K+
- ✅ **Interest targeting** - Tech, audio, music, fitness, travel
- ✅ **Behavioral targeting** - Early adopters, premium buyers
- ✅ **Clear KPIs** - Sales with $45-55 CPA target
- ✅ **Defined flight** - 2-week launch period

**Publisher Interpretation:**
- Build audience segments from demographics and interests
- Optimize toward conversion goals
- Apply frequency caps for launch period
- Use lookalike modeling from converter profiles

---

## 3. Comprehensive Brief: B2B Targeting

### Enterprise Software Campaign

```json
{
  "brief": "CloudSync Solutions needs to reach IT decision makers at mid-market companies (500-5000 employees) in financial services, healthcare, retail, and manufacturing. Target titles include IT Directors, Cloud Architects, CTOs, and DevOps Engineers. Focus on companies showing intent signals around cloud migration, hybrid cloud, and data synchronization. Also target visitors to competitor sites like Informatica, Talend, and MuleSoft. We want to generate 150 qualified leads at $200-250 per lead. Campaign runs October through December 2024 with $90,000 total budget. Primary markets are US and Canada, secondary markets UK and Germany."
}
```

**Why This Works:**
- ✅ **Firmographic targeting** - Company size, industries
- ✅ **Title/persona targeting** - Specific decision makers
- ✅ **Intent signals** - Cloud migration, data sync research
- ✅ **Competitive conquest** - Competitor site visitors
- ✅ **Lead generation focus** - Clear volume and cost targets
- ✅ **Geographic priorities** - Primary and secondary markets

**Publisher Interpretation:**
- Activate B2B data providers for firmographics
- Use intent data for in-market identification
- Apply title-based targeting from professional data
- Set up competitive conquesting campaigns
- Implement lead scoring and quality filters

---

## 4. Advanced Brief: Multi-Segment Strategy

### Automotive Launch Campaign

```json
{
  "brief": "EcoMotion is launching our new hybrid SUV. Primary audience: eco-conscious families with household income $75K-150K, ages 35-55, who currently own SUVs and are interested in environmental topics. Secondary audience: affluent early adopters interested in luxury vehicles and new technology. Conquest audience: people actively shopping for Toyota Highlander, Honda Pilot, or other 3-row SUVs. Also target based on behaviors: outdoor enthusiasts, suburban families with children, and people who've visited EV/hybrid content. Geographic focus on California, Pacific Northwest, and Northeast metros. October through December with $450,000 total budget. Success is measured by test drive appointments and dealer visits."
}
```

**Why This Works:**
- ✅ **Multiple audience segments** - Primary, secondary, conquest
- ✅ **Rich behavioral data** - Current SUV owners, outdoor enthusiasts
- ✅ **Competitive targeting** - Specific model conquest
- ✅ **Interest + intent** - Environmental interest + auto shopping
- ✅ **Geographic strategy** - EV-friendly markets
- ✅ **Clear success metrics** - Test drives and dealer visits

**Publisher Interpretation:**
- Create separate audience segments for testing
- Layer demographics with auto-intender data
- Apply geographic and behavioral targeting
- Use dynamic optimization across segments
- Focus on lower-funnel automotive metrics

---

## Industry-Specific Brief Examples

### Financial Services
```json
{
  "brief": "NextGen Banking wants to reach mass affluent consumers ($100K+ income, ages 30-60) who currently have savings accounts with traditional banks and are researching high-yield savings options. Exclude existing customers. Focus on major metros. January campaign with $400,000 budget targeting 5,000 new account opens."
}
```

### Healthcare
```json
{
  "brief": "HealthFirst Urgent Care needs to reach families with children and adults 25-65 within 10 miles of our 15 Ohio clinic locations. Target people with employer-sponsored health insurance who haven't visited an urgent care in the past year. $20,000 monthly ongoing budget to drive appointment bookings."
}
```

### Streaming Service
```json
{
  "brief": "StreamPlus needs to reach cord-cutters and cord-nevers aged 25-54 who are sports fans, particularly NFL and NBA followers, in markets where we have local broadcast rights. Also target households that subscribe to 2+ streaming services. Q4 campaign with $2M budget to drive free trial sign-ups."
}
```

### Mobile Gaming
```json
{
  "brief": "GameStudio targeting casual mobile gamers aged 25-45 who play puzzle and match-3 games, have made in-app purchases before, and use iOS devices. Focus on users who've played competitor games like Candy Crush or Gardenscapes. January launch with $175,000 budget, goal of 50,000 installs."
}
```

---

## What NOT to Include in Briefs

Briefs should focus on **who** to reach and **what** business outcome to drive. They should NOT include:

### ❌ Creative Specifications
- Asset sizes, formats, or technical specs
- Creative messaging or copy
- Production requirements

### ❌ Technical Implementation
- Attribution models
- Pixel placement
- Analytics integration
- Measurement vendors

### ❌ Media Tactics
- Specific channels or publishers
- Bid strategies
- Frequency caps
- Dayparting rules

These are either handled separately (creative via `sync_creatives`) or determined by the publisher based on their capabilities and optimization strategies.

---

## Brief Writing Best Practices

### Focus on Audience Insights
- **Demographics**: Age, income, gender, education
- **Firmographics**: Company size, industry, revenue (B2B)
- **Interests**: Topics, hobbies, content consumption
- **Behaviors**: Purchase history, website visits, app usage
- **Intent signals**: In-market status, research behavior
- **Geography**: Markets, DMAs, radius targeting

### Specify Business Outcomes
- **Direct response**: Leads, sales, app installs, sign-ups
- **Engagement**: Website visits, content downloads, video views
- **Awareness**: Reach, brand lift, consideration
- **Offline**: Store visits, phone calls, test drives

### Provide Context
- **Campaign purpose**: Launch, promotion, seasonal, always-on
- **Competitive landscape**: Conquest targets, differentiation
- **Budget parameters**: Total, monthly, or daily limits
- **Success definitions**: KPIs, benchmarks, goals

---

## Brief Evaluation Checklist

### Essential Elements
- [ ] Clear advertiser/brand identification
- [ ] Target audience description
- [ ] Business objective or KPI
- [ ] Budget amount
- [ ] Campaign timing

### Audience Definition
- [ ] Demographics or firmographics
- [ ] Interests or behaviors
- [ ] Geographic scope
- [ ] Exclusions (existing customers, etc.)

### Optional Enhancements
- [ ] Intent signals to leverage
- [ ] Competitive conquest targets
- [ ] Multiple audience segments
- [ ] Success metrics/benchmarks

---

## Related Documentation

- [Brief Expectations](./brief-expectations.md) - How publishers process briefs
- [Media Buy Lifecycle](./media-buy-lifecycle.md) - Campaign execution workflow
- [Targeting Dimensions](./targeting-dimensions.md) - Available audience capabilities
- [Product Discovery](./product-discovery.md) - How briefs influence product selection