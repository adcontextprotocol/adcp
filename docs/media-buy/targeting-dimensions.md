---
title: Targeting Dimensions by Channel
---

# Targeting Dimensions by Channel

This document specifies which targeting dimensions are available by channel for both targeting overlays (buyer-specified) and AXE signals (publisher-provided context).

## Design Principles

1. **Overlay Targeting**: Limited set of dimensions that buyers can specify in targeting overlays
2. **AXE Signals**: Comprehensive context passed to AXE for advanced decisioning
3. **Channel-Specific**: Each channel has relevant dimensions for its medium

## Common Dimensions (All Channels)

### Overlay Dimensions
These dimensions are available for buyer targeting across all channels:

- **dayparting**: Time-based targeting in user's timezone
- **browser**: Browser type (chrome, firefox, safari, edge, other)
- **device_type**: Device category (desktop, mobile, tablet, connected_tv, smart_speaker)
- **os**: Operating system (windows, macos, ios, android, linux, roku, tvos, other)
- **language**: User's language preference
- **country**: ISO 3166-1 alpha-2 country code
- **region**: State or region within country
- **metro**: Metro area or DMA code
- **city**: City-level targeting
- **user_ids**: Available identity providers

### Additional AXE Dimensions
These are provided to AXE but not available for overlay targeting:

- **timezone**: User's timezone (required for dayparting calculations)
- **postal_code**: Full postal/ZIP code
- **postal_district**: First part of postal code

## Audio Channel

### Overlay Dimensions (Audio-Specific)
- **genre**: Content genre (music, news, sports, talk, comedy, true_crime, business, technology, health)
- **content_rating**: Maturity rating (all, teen, mature)
- **content_duration**: Length of content in seconds
- **station_channel**: Radio station or podcast channel

### AXE Dimensions (Audio-Specific)
- **podcast_episode_id**: Unique episode GUID
- **podcast_show_name**: Name of the podcast show

## Web Channel

### Overlay Dimensions (Web-Specific)
- **content_categories**: IAB content categories
- **keywords**: Page keywords for contextual targeting

### AXE Dimensions (Web-Specific)
- **page_url**: Current page URL (required)
- **referrer_url**: Referring page URL
- **ad_slot_id**: Specific ad slot identifier
- **gpid**: Global Placement ID
- **adjacent_content**: List of content adjacent to ad placement

## Mobile App Channel

### Overlay Dimensions (Mobile-Specific)
- **app_bundle**: Mobile app bundle identifier
- **app_categories**: App store categories

### AXE Dimensions (Mobile-Specific)
- **app_bundle_id**: Current app's bundle identifier (required)
- **app_version**: Current app version
- **content_url**: URL for web-available content within app
- **content_id**: Internal content identifier
- **screen_name**: Current screen or view name

## CTV Channel

### Overlay Dimensions (CTV-Specific)
- **genre**: Video genre (drama, comedy, news, sports, documentary, reality, kids, movies)
- **content_rating**: TV/Movie rating (G, PG, PG-13, TV-Y, TV-Y7, TV-G, TV-PG, TV-14, TV-MA)
- **content_duration**: Length of content in seconds
- **channel_network**: TV channel or streaming service

### AXE Dimensions (CTV-Specific)
- **show_name**: Name of the TV show or movie
- **show_metadata**: Additional show information (season, episode, etc.)
- **content_ids**: Industry-standard content identifiers
- **iris_id**: IRIS.TV content identifier
- **gracenote_id**: Gracenote content identifier

## DOOH Channel

### Overlay Dimensions (DOOH-Specific)
- **venue_type**: Type of venue (transit, retail, office, gym, restaurant, gas_station, airport, mall)
- **screen_size**: Physical screen dimensions

### AXE Dimensions (DOOH-Specific)
- **venue_id**: Unique venue identifier
- **screen_id**: Unique screen identifier
- **venue_metadata**: Additional venue information
- **foot_traffic**: Estimated foot traffic data

## Capability Discovery

Publishers can expose their supported dimensions through the `get_targeting_capabilities` tool:

```json
{
  "channels": ["web", "mobile_app"],
  "include_axe_dimensions": true
}
```

## AXE Requirements Checking

Buyers can verify if required AXE dimensions are available before creating a media buy:

```json
{
  "channel": "ctv",
  "required_dimensions": ["iris_id", "show_name", "content_rating"]
}
```

Response indicates if all dimensions are supported:
```json
{
  "supported": true,
  "missing_dimensions": [],
  "available_dimensions": ["iris_id", "show_name", "content_rating", ...]
}
```

## Implementation Notes

1. **Graceful Degradation**: If a dimension is not available, it should be omitted rather than sending null values
2. **Privacy Compliance**: Publishers must ensure user consent for any PII dimensions
3. **Standardization**: Use industry-standard values where possible (ISO codes, IAB categories, etc.)
4. **Extensibility**: Publishers may provide additional dimensions beyond the minimum set