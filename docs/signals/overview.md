---
sidebar_position: 1
title: Overview
---

# Signals Activation Protocol Overview

The Signals Activation Protocol enables AI assistants to discover, activate, and manage data signals through natural language—transforming static catalogs into dynamic, AI-optimized audiences.

## The Network Effect That Changes Everything

### Traditional Model (Broken)
```
1 Provider → Custom Integration → 1 Platform → Manual Discovery → Few Buyers
```
- **Result**: High cost, low usage, value trapped in static catalogs

### AdCP Model (Revolutionary)
```
1 Provider → AdCP Protocol → All Platforms → AI Discovery → Every Buyer
```
- **Result**: Zero marginal cost, unlimited usage, dynamic value creation

When signals become instantly discoverable and activatable:
1. **Discovery increases 100x** → More signals get used
2. **Activation friction drops to zero** → Long-tail signals become viable
3. **Small providers can compete** → Innovation explodes
4. **AI orchestrates multiple signals** → Performance improves dramatically
5. **Network effects kick in** → Every new signal makes all others more valuable

## From Static Catalogs to Dynamic Intelligence

### The Old World: Pre-Built Segments
- Fixed catalogs with 1,000s of segments
- Only the top 50 ever get used
- New segments take months to productize
- Manual effort to use signals from multiple providers
- One-size-fits-all approach

### The New World: AI-Orchestrated Signals
```
Human: I need high-value customers who are both interested in luxury travel 
        AND actively researching electric vehicles, but only in California

AI: Found matching signals from multiple providers:

DataVault's "Luxury Travel Intenders"
- Available on: RampID, UID2, MAIDs
- Size: 2.3M individuals nationwide
- California subset: 340K individuals

AutoSignals' "EV Researchers"
- Available on: UID2, hashed emails, cookies
- Size: 890K individuals nationwide  
- California subset: 125K individuals

For your campaign, I can:
1. Activate both signals on The Trade Desk (using UID2)
2. Layer California geo-fencing at campaign level
3. Estimated overlapping audience: 47K individuals

Deploy these signals together?
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
    D -->|Yes| F[Use Catalog Signal]
    E --> G[Match Identity Keys]
    F --> G
    G --> H[Activate on Platforms]
    H --> I[Campaign Uses Signals]
    I --> J[Monitor & Optimize]
```

## The Bottom Line Impact

**For Signal Providers:**
- 📈 **Revenue**: 10-15x increase through better discovery
- ⚡ **Speed**: Instant custom signals from your data
- 🎯 **Precision**: Create exact segments on demand
- 🌍 **Reach**: Available on every identity type

**For Advertisers:**
- 🎨 **Custom Audiences**: Build exactly what you need
- 🔄 **Dynamic Refresh**: Signals that adapt in real-time
- 💰 **Pay for Performance**: Only activated when used
- 🚀 **Instant Deployment**: Minutes not weeks

## Next Steps

- 📖 **Technical Teams**: Review the [Protocol Specification](./specification)
- 💻 **Developers**: Explore the [Reference Implementation](https://github.com/adcontextprotocol/signals-agent)
- 🏗️ **Platform Providers**: See [Integration Guide](./tasks/get_signals)
- 💬 **Everyone**: Join the [Community](https://github.com/adcontextprotocol/adcp/discussions)

---

*The Signals Activation Protocol is part of the broader [AdCP ecosystem](../intro#the-adcp-ecosystem-layers), transforming how advertising technology works together.*