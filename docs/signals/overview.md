---
sidebar_position: 1
title: Overview
---

# Signals Activation Protocol Overview

The Signals Activation Protocol enables AI assistants to discover, activate, and manage data signals through natural language—solving the impossible problem of navigating hundreds of thousands of opaque segments.

## The Problem: 500,000 Segments, Zero Transparency

Today's data platforms offer hundreds of thousands of pre-built segments. But humans can't effectively navigate them:
- **No provenance**: Where did this data come from? How fresh is it?
- **No quality metrics**: Is this segment accurate? How does it perform?
- **No comprehension**: What does "Luxury Auto Intenders v3_final_FINAL" actually mean?
- **Arbitrary choices**: Decisions influenced by sales teams, not data quality
- **Static catalogs**: Can't get exactly what you need, only "close enough"

## The Solution: AI That Understands Data

### Traditional Model (Broken)
```
Human → Browses 500K segments → Picks blindly → Hope it works
```
- **Result**: Poor performance, wasted spend, frustrated users

### AdCP Model (Revolutionary)
```
Human describes need → AI analyzes metadata → Provider creates perfect segment → Instant activation
```
- **Result**: Exact audiences, transparent quality, optimal performance

## How AI Changes Everything

### AI Can Analyze What Humans Can't
```
Human: I need people likely to buy luxury cars in the next 30 days

AI: Analyzing 487 automotive segments across 3 providers...

Best match: DataVault's "Premium Auto Purchase Intent"
- Provenance: Dealer data + finance searches + config tools
- Freshness: Updated daily, 89% still in-market after 30 days
- Accuracy: 73% precision based on 6-month validation
- Size: 2.3M individuals (RampID, UID2, MAIDs)
- Performance: 4.2x lift vs. general auto intenders
- Price: $8 CPM

Alternatives with trade-offs:
- MotorSignals: Higher precision (81%) but smaller scale (890K)
- AutoData: Lower cost ($5 CPM) but monthly refresh only
```

### Providers Create Exactly What You Need
```
Human: I need business travelers who fly monthly but haven't 
        booked hotels through our platform

AI to DataVault: Creating custom segment from your requirements...

DataVault's AI: 
- Analyzing travel graph for monthly flyers
- Cross-referencing with your CRM (secure match)
- Excluding recent hotel bookers
- Building segment in real-time...

Created: "Your Brand - High-Frequency Flyers Without Hotel Bookings"
- Size: 147K matched individuals  
- Available on: RampID, UID2, MAIDs
- Exclusive to your account
- Refreshes daily from your CRM
```

No more browsing catalogs. No more "close enough." Just exactly what you need, created on demand.

## From Static Catalogs to Dynamic Intelligence

### The Old World: Pre-Built Everything
- 500,000 segments gathering dust
- No way to evaluate quality or relevance
- Months to create new segments
- "Close enough" is the best you can get
- Black box decision making

### The New World: AI-Powered Discovery & Creation
```
Human: Find affluent parents interested in EVs but exclude Tesla owners

AI: Found 3 approaches:

1. Existing segment: FamilyData's "EV-Curious Affluent Parents"
   - Ready now, 340K individuals, $7 CPM
   - Note: Includes ~15% Tesla owners

2. Custom creation: DataVault can build exactly this
   - Combining: Affluent parents + EV interest - Tesla registration
   - 48-hour creation, 290K individuals, $9 CPM
   - 100% match to your criteria

3. Campaign combination: Use multiple signals
   - FamilyData's segment + negative targeting for Tesla
   - Immediate activation, handled at DSP level

Which approach works best for your campaign?
```

## Universal Signal Keys

AdCP supports every major identity and targeting methodology:

### Identity Signals
- **RampID**: LiveRamp's universal identifier
- **UID2**: The Trade Desk's open-source ID
- **Publisher IDs**: First-party authenticated users
- **Hashed emails**: SHA256 email matching

### Device Identifiers
- **MAIDs**: Mobile advertising IDs (IDFA/GAID)
- **Connected TV IDs**: Roku ID, Samsung ID, etc.
- **Cookie IDs**: Platform-specific cookies
- **IP addresses**: Household-level targeting

### Geographic Signals
- **Lat/Long**: Precise location polygons
- **Postal codes**: ZIP, ZIP+4, international formats
- **DMA**: Designated Market Areas
- **Custom geofences**: Store radii, event venues

### Multi-Dimensional Signals
- **Domain × Time**: "wsj.com visitors on weekday mornings"
- **Weather × Location**: "Cold fronts approaching major metros"
- **Content × Sentiment**: "Reading positive EV articles"
- **Behavior × Frequency**: "Daily coffee shop visitors"

### Temporal Signals
- **Real-time triggers**: "Temperature exceeds 85°F"
- **Time windows**: "Business hours in local timezone"
- **Recency**: "Visited site in last 24 hours"
- **Predictive**: "Likely to purchase in next 7 days"

## Revolutionary Use Cases

### 💡 Dynamic Weather-Based Activation

```
Human: Activate ice cream ads when tomorrow's weather will drive demand

AI: Creating dynamic weather signal:
- Monitoring 150 metro areas
- Trigger: Tomorrow's forecast > 85°F + sunny
- Currently qualifying: Miami, Phoenix, San Diego
- Will auto-activate/deactivate based on forecasts
- Refreshes every 6 hours

Signal is now live across all platforms.
```

### 🎯 Multi-Signal Campaign Orchestration

```
Human: I want to target crypto investors who also collect wine 
        and live in high-income neighborhoods

AI: Found complementary signals for your campaign:

FinanceSignals: "Active Crypto Traders"
- Available on: UID2, RampID, MAIDs
- Size: 1.8M individuals
- Price: $5 CPM

LuxuryData: "Wine Collectors" 
- Available on: RampID, hashed emails
- Size: 450K individuals
- Price: $6 CPM

CensusPlus: "HHI > $250K by Postal"
- Geographic signal: ZIP+4 level
- Coverage: All US metros
- Price: $4 CPM

Activating all three on DSP Platform X (using RampID).
Platform will handle audience intersection.
Total signal cost: $15 CPM combined
```

### 🔬 Real-Time Contextual Activation

```
Human: Target users reading about EVs right now on premium news sites

AI: Activating real-time contextual signal:
- Monitoring: WSJ, FT, Bloomberg, Reuters
- Content match: Electric vehicle articles
- Sentiment: Positive/neutral only
- Viewability: > 70%
- Updates: Every 5 minutes

Current inventory: 2.3M impressions/day
Activating on all connected SSPs...
```

### 📊 Custom Signal Creation from Your Data

```
Human: Can DataVault create a custom signal from our CRM data 
        for high-value customers who haven't purchased recently?

AI: DataVault can create a custom signal using your data:

"Your Brand - Lapsed High-Value Customers"
- Input: Your CRM list (hashed emails)
- Match against DataVault's identity graph
- Output formats: RampID, UID2, MAIDs
- Expected match rate: 60-70%

Signal characteristics:
- Size: ~127K matched individuals
- Refresh: Daily from your CRM
- Exclusive to your account
- Price: $8 CPM

DataVault will score recency and value, making it
available across all your connected platforms.

Proceed with signal creation?
```

## Multi-Platform Intelligence

See your entire signal ecosystem in one view:

```
Human: Show me all my travel signals across platforms

AI: Your travel signals deployment status:

**"Luxury Travel Intenders" (450K users)**
✅ The Trade Desk: ttd_lux_travel_q4 (RampID)
✅ Amazon DSP: amzn_travel_lux_2024 (UID2)
✅ Google DV360: dbm_luxury_travel (Cookie ID)
⏳ Yahoo DSP: Activating... (2 hours)

**"Last-Minute Bookers" (1.2M users)**
✅ All platforms active
Using: RampID, UID2, and MAIDs

**"Business Travelers" (890K users)**
Custom segment you created last week
Now used by 47 campaigns
Generating $12K/day in signal revenue
```

## Core Tasks

The Signals Activation Protocol supports two primary tasks:

### 1. [get_signals](./tasks/get_signals)
Discover signals across providers using natural language, with visibility into available identity keys.

### 2. [activate_signal](./tasks/activate_signal)  
Deploy signals to platforms with automatic identity resolution.

## How It Works

```mermaid
flowchart LR
    A[Natural Language Request] --> B[AI Understands Intent]
    B --> C[Search Across Providers]
    C --> D{Signal Exists?}
    D -->|No| E[Provider Creates Custom]
    D -->|Yes| F[Analyze Quality & Metadata]
    E --> G[Match Identity Keys]
    F --> G
    G --> H[Activate on Platforms]
    H --> I[Campaign Uses Signals]
    I --> J[Monitor & Optimize]
```

## The Bottom Line Impact

**For Signal Providers:**
- 📈 **Revenue**: 10-15x increase through better discovery
- ⚡ **Speed**: Create custom signals in hours, not months
- 🎯 **Precision**: Build exactly what buyers need
- 🌍 **Reach**: Available on every identity type

**For Advertisers:**
- 🔍 **Transparency**: See provenance, quality, and performance
- 🎨 **Custom Audiences**: Get exactly what you need
- 🤖 **AI Analysis**: Make data-driven segment choices
- 🚀 **Instant Deployment**: Minutes not weeks

## Next Steps

- 📖 **Technical Teams**: Review the [Protocol Specification](./specification)
- 💻 **Developers**: Explore the [Reference Implementation](https://github.com/adcontextprotocol/signals-agent)
- 🏗️ **Platform Providers**: See [Integration Guide](./tasks/get_signals)
- 💬 **Everyone**: Join the [Community](https://github.com/adcontextprotocol/adcp/discussions)

---

*The Signals Activation Protocol is part of the broader [AdCP ecosystem](../intro#the-adcp-ecosystem-layers), transforming how advertising technology works together.*