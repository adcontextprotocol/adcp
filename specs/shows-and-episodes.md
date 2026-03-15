# Shows and Episodes

## Problem

AdCP models advertising inventory through **properties** (technical surfaces like websites, apps, podcast feeds) and **products** (packages of inventory for sale). This works for legacy media where the property IS the thing audiences care about (a news site, a newspaper).

But modern media doesn't work this way. Audiences follow **shows** — Pinnacle Games, Signal & Noise Podcast, Championship League Live, The Ember. Shows are:

- Distributed across multiple properties (Rex Valor is on YouTube AND a streaming service)
- The actual unit buyers want to target ("I want to buy Pinnacle Games", not "I want to buy youtube.com")
- Where brand safety lives (an explicit episode vs. a clean one)
- Where audience identity comes from (people follow shows, not platforms)
- Persistent — they outlive any single episode or property relationship

Without shows, AdCP is stuck in a property-centric model that can't represent how media and advertising actually work. This gets worse as generative surfaces emerge — an AI persona of Rex Valor selling Valor Snacks has no "property" at all.

Companies that rep YouTube channels, podcast networks, and other episodic content need this to accurately describe their inventory. Without it, a product for "Rex Valor pre-roll" has no structured way to say which show, which episodes, or what the content is like.

## Product Dimensions

A product describes inventory along three independent axes:

```
Product
  ├── publisher_properties   (WHERE the ad runs — youtube.com, spotify.com)
  ├── show / episodes        (WHAT CONTENT the ad runs in/around — Pinnacle Games S1E3)
  └── placements             (WHAT POSITION the ad appears in — pre-roll, mid-roll)
```

Shows and placements are parallel, not hierarchical. "Pre-roll" is a position. "Pinnacle Games" is content. A product combines them: "pre-roll on Pinnacle Games on Titan Streaming."

Properties remain the technical advertising surface — the thing with an adagents.json, the thing that serves ads. Shows are the content that makes the inventory valuable.

## Design Principles

1. **Shows are persistent, not ephemeral.** Pinnacle Games exists as a durable thing with an identity, a host, a production history. It produces content (episodes) over time.

2. **Episodes are installments of a show.** They have specific dates, guests, ratings, and brand safety characteristics that may differ from the show's baseline. Many episodes won't be known in advance.

3. **Shows work like properties.** They're reusable objects that products can optionally reference — not inline blobs repeated on every product. A seller declares their shows once, and multiple products can reference the same show by `show_id`. Shows and episodes are returned alongside products in `get_products` responses, not hosted at external URLs.

4. **Properties carry shows.** Many-to-many. A show can be on multiple properties (syndication). A property carries many shows. The property controls the ad inventory; the show is what makes that inventory valuable.

5. **Brand safety lives on shows and episodes.** A show has a baseline content profile (genre, typical rating). Individual episodes may deviate. Buyers evaluate both levels.

6. **Talent is connectable.** Hosts and guests may have brand.json entries. Buyer agents can evaluate the people involved, not just the content category.

## The Show Object

A show represents a persistent content program that produces episodes over time. Shows work like properties — they're reusable objects that products reference by ID. The seller declares shows in `get_products` responses, and multiple products can reference the same show.

```json
{
  "show_id": "pinnacle_games",
  "name": "Pinnacle Games",
  "description": "Competition reality show hosted by Rex Valor with extreme challenges and massive prizes",

  "genre": ["IAB1", "IAB1-6"],
  "genre_taxonomy": "iab_content_3.0",
  "language": "en",
  "content_rating": {
    "system": "tv_parental",
    "rating": "TV-PG"
  },
  "cadence": "weekly",
  "status": "active",

  "talent": [
    {
      "role": "host",
      "name": "Rex Valor",
      "brand_url": "https://rexvalor.example.com/brand.json"
    }
  ],

  "distribution": [
    {
      "publisher_domain": "youtube.com",
      "identifiers": [
        { "type": "youtube_channel_id", "value": "UCX6OQ3DkcsbYNE6H8uQQuVA" }
      ]
    },
    {
      "publisher_domain": "titanstreaming.example.com",
      "identifiers": [
        { "type": "amazon_title_id", "value": "B0DFBT5GBP" }
      ]
    }
  ]
}
```

### Key Fields

| Field | Type | Description |
|-------|------|-------------|
| `show_id` | string | Seller-assigned identifier for the show. Unique within a single get_products response but not globally — use distribution identifiers for cross-seller matching. |
| `name` | string | Human-readable show name |
| `description` | string | What the show is about |
| `genre` | string[] | Genre tags. When `genre_taxonomy` is present, values are taxonomy IDs (e.g., IAB Content Taxonomy 3.0). Otherwise free-form. |
| `genre_taxonomy` | string | Taxonomy system for genre values (e.g., `iab_content_3.0`). When present, genre values should be valid taxonomy IDs. Recommended for machine-readable brand safety evaluation. |
| `language` | string | Primary language (BCP 47) |
| `content_rating` | object | Baseline rating — system + rating value |
| `cadence` | string | `daily`, `weekly`, `seasonal`, `event`, `irregular` |
| `season` | string | Current or most recent season identifier (e.g., `"3"`, `"2026"`) |
| `status` | string | `active`, `hiatus`, `ended`, `upcoming` |
| `production_quality` | string | `professional`, `prosumer`, `ugc`. Seller-declared. Maps to OpenRTB `content.prodq`. |
| `talent` | array | Hosts, recurring cast, creators — with optional brand.json references |
| `distribution` | array | Where this show is distributed — publisher domains with platform-specific identifiers |
| `related_shows` | array | Relationships to other shows (`spinoff`, `companion`, `sequel`, `prequel`, `crossover`) |

### Distribution Identifiers

Distribution identifiers map a show to its presence on specific properties, similar to how property identifiers map a property to a platform. This enables:

- **Cross-seller matching**: YouTube's agent and Rex Valor's own agent both return products for Pinnacle Games. The buyer matches them via the same `youtube_channel_id`.
- **Multiple sellers, same content**: Rex Valor's team reps their own inventory (host reads, custom integrations) while YouTube separately sells programmatic pre-roll. Different sellers, different products, same show.
- **Syndication tracking**: A show distributed across YouTube, a streaming service, and a podcast feed has a distribution entry for each.

```json
"distribution": [
  {
    "publisher_domain": "youtube.com",
    "identifiers": [
      { "type": "youtube_channel_id", "value": "UCX6OQ3DkcsbYNE6H8uQQuVA" }
    ]
  },
  {
    "publisher_domain": "titanstreaming.example.com",
    "identifiers": [
      { "type": "amazon_title_id", "value": "B0DFBT5GBP" }
    ]
  },
  {
    "publisher_domain": "spotify.com",
    "identifiers": [
      { "type": "spotify_show_id", "value": "4rOoJ6Egrf8K2IrywzwOMk" }
    ]
  }
]
```

### Distribution Identifier Types

Distribution identifiers use the same structure as property identifiers (`type` + `value`). Some types overlap with property identifiers (a podcast's `rss_url` or `apple_podcast_id` identifies both the property and the show's distribution). Others are show-specific.

**Podcast distribution:**

| Type | Example | Notes |
|------|---------|-------|
| `apple_podcast_id` | `1234567890` | Apple Podcasts show ID |
| `spotify_show_id` | `4rOoJ6Egrf8K2IrywzwOMk` | Spotify show URI |
| `rss_url` | `https://feeds.example.com/show` | Canonical RSS feed |
| `podcast_guid` | `a1b2c3d4-...` | Podcasting 2.0 GUID |
| `amazon_music_id` | `B08xyz` | Amazon Music / Audible |
| `iheart_id` | `12345` | iHeartRadio |
| `podcast_index_id` | `920666` | PodcastIndex.org ID |

**Video/CTV distribution:**

| Type | Example | Notes |
|------|---------|-------|
| `youtube_channel_id` | `UCX6OQ3DkcsbYNE6H8uQQuVA` | YouTube channel |
| `youtube_playlist_id` | `PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf` | YouTube playlist (for series within a channel) |
| `amazon_title_id` | `B0DFBT5GBP` | Amazon Prime Video title |
| `roku_channel_id` | `abc123` | Roku Channel |
| `pluto_channel_id` | `abc123` | Pluto TV |
| `tubi_id` | `abc123` | Tubi |
| `peacock_id` | `abc123` | Peacock |
| `tiktok_id` | `@rexvalor` | TikTok account |
| `twitch_channel` | `rexvalor` | Twitch channel |

**Cross-platform / reference:**

| Type | Example | Notes |
|------|---------|-------|
| `imdb_id` | `tt1234567` | IMDb title — universal cross-platform reference |
| `gracenote_id` | `EP012345678` | Gracenote TMS ID — industry standard for TV metadata |
| `eidr_id` | `10.5240/XXXX-XXXX-XXXX-XXXX-XXXX-C` | EIDR (Entertainment Identifier Registry) — ISO 10528, used by major streaming services and studios |
| `domain` | `wonderstruck.fm` | Show's own website |
| `substack_id` | `wonderstruck` | Substack publication |

This is an open enum — new platform types can be added as distribution channels emerge. Platform-independent identifiers (`imdb_id`, `gracenote_id`, `eidr_id`) are the most reliable for cross-seller matching. Shows SHOULD include at least one platform-independent identifier when available to enable buyer agents to deduplicate the same show from different sellers.

### Content Rating Systems

Shows declare which rating system applies:

| System | Values | Used by |
|--------|--------|---------|
| `tv_parental` | TV-Y, TV-Y7, TV-G, TV-PG, TV-14, TV-MA | US broadcast, streaming |
| `mpaa` | G, PG, PG-13, R, NC-17 | Film |
| `podcast` | clean, explicit | Apple Podcasts, Spotify |
| `esrb` | E, E10+, T, M, AO | Games |
| `bbfc` | U, PG, 12A, 12, 15, 18, R18 | UK film/video |
| `fsk` | 0, 6, 12, 16, 18 | German film/video |
| `acb` | G, PG, M, MA15+, R18+ | Australian Classification Board |
| `custom` | (free-form) | Publisher-defined |

Individual episodes can override the show's baseline rating.

## The Episode Object

An episode is a specific installment of a show. Not all episodes will be known in advance — a weekly podcast might only have next week's episode scheduled. Some episodes may be tentative (playoff Game 7 depends on Game 6).

```json
{
  "episode_id": "s1e03_final_challenge",
  "show_id": "pinnacle_games",
  "name": "The Final Challenge",
  "season": "1",
  "episode_number": "3",

  "scheduled_at": "2026-04-07T20:00:00Z",
  "status": "scheduled",
  "duration_seconds": 3600,
  "flexible_end": false,
  "valid_until": "2026-04-06T20:00:00Z",

  "content_rating": {
    "system": "tv_parental",
    "rating": "TV-14"
  },

  "topics": ["IAB17-18"],

  "guest_talent": [
    {
      "role": "guest",
      "name": "Samira Okafor",
      "brand_url": "https://samiraokafor.example.com/brand.json"
    }
  ],

  "ad_inventory": {
    "expected_breaks": 4,
    "total_ad_seconds": 480,
    "max_ad_duration_seconds": 120,
    "unplanned_breaks": false,
    "supported_formats": ["video", "audio"]
  }
}
```

### Key Fields

| Field | Type | Description |
|-------|------|-------------|
| `episode_id` | string | Unique identifier within the show |
| `show_id` | string | Parent show reference. Required when the product spans multiple shows (has multiple entries in `show_ids`). |
| `name` | string | Episode title |
| `season` / `episode_number` | string | Season and episode identifiers |
| `scheduled_at` | datetime | When the episode airs/publishes |
| `status` | string | `scheduled`, `tentative`, `live`, `postponed`, `cancelled`, `aired`, `published` |
| `duration_seconds` | integer | Expected duration |
| `flexible_end` | boolean | Whether end time is approximate (live events) |
| `valid_until` | datetime | When this episode data expires and should be re-queried. Agents should re-query before committing budget to products with `tentative` episodes. |
| `content_rating` | object | Episode-specific rating (overrides show baseline if present) |
| `topics` | string[] | Content topics for this episode. Uses the same taxonomy as the show's `genre_taxonomy` when present. Enables episode-level brand safety evaluation beyond what `content_rating` alone provides. |
| `guest_talent` | array | Episode-specific guests with optional brand.json references |
| `ad_inventory` | object | Break-based ad inventory: expected breaks, total/max ad seconds, format types. For non-break formats (host reads, integrations, sponsorships), use product placements instead. |
| `derivative_of` | object | When this episode is a clip, highlight, or recap derived from a full episode. Has `episode_id` (source) + `type` (`clip`, `highlight`, `recap`, `trailer`, `bonus`). |

### Episode Status (aligned with LEAP concepts)

- **scheduled**: Confirmed, will happen
- **tentative**: May not happen (e.g., playoff Game 7 depends on Game 6 result)
- **live**: Currently airing or streaming right now
- **postponed**: Was scheduled but delayed to a future date
- **cancelled**: Will not happen
- **aired** / **published**: Already happened — included for back-catalog evaluation and catch-up inventory (e.g., a podcast episode still available on-demand, a TV episode available for replay ads)

### Inheritance Semantics

Episodes inherit show-level fields they don't override. Specifically:

- `content_rating`: Episode overrides show baseline when present. When absent, the show's `content_rating` applies.
- `talent`: Episode `guest_talent` is additive — it adds to the show's recurring `talent`, it doesn't replace it.
- `genre` / `topics`: Episode `topics` are additive context for brand safety, not a replacement for the show's `genre`.

Buyer agents evaluate both levels: the show baseline provides the default safety profile, and episode-level fields refine it for specific installments.

### Unplanned Breaks (from LEAP)

The `unplanned_breaks` flag signals whether ad breaks are dynamic:
- `false`: All breaks pre-defined (scripted shows, fixed sponsorships)
- `true`: Breaks driven by live conditions (sports timeouts, election coverage)

This matters for forecasting accuracy and creative readiness.

## How Shows Connect to Products

Shows work like properties — products reference them by ID. The `get_products` response includes a top-level `shows` array with full show objects, and products reference shows via `show_ids` (an array, since a product can span multiple shows — e.g., a network bundle). Episodes are listed per-product since different products may scope to different episodes of the same show.

The response's `shows` array MUST only include shows referenced by the returned products. Under pagination, each page includes all show objects needed for that page's products.

### get_products Response Structure

```json
{
  "shows": [
    {
      "show_id": "pinnacle_games",
      "name": "Pinnacle Games",
      "genre": ["entertainment", "competition"],
      "content_rating": { "system": "tv_parental", "rating": "TV-PG" },
      "cadence": "weekly",
      "status": "active",
      "talent": [
        { "role": "host", "name": "Rex Valor", "brand_url": "https://rexvalor.example.com/brand.json" }
      ],
      "distribution": [
        {
          "publisher_domain": "youtube.com",
          "identifiers": [{ "type": "youtube_channel_id", "value": "UCX6OQ3DkcsbYNE6H8uQQuVA" }]
        },
        {
          "publisher_domain": "titanstreaming.example.com",
          "identifiers": [{ "type": "amazon_title_id", "value": "B0DFBT5GBP" }]
        }
      ]
    }
  ],

  "products": [
    {
      "product_id": "pinnacle_games_april_bundle",
      "name": "Pinnacle Games April Sponsorship",
      "publisher_properties": [{
        "publisher_domain": "titanstreaming.example.com",
        "selection_type": "by_id",
        "property_ids": ["titan_streaming"]
      }],

      "show_ids": ["pinnacle_games"],
      "episodes": [
        {
          "episode_id": "s1e03",
          "name": "The Final Challenge",
          "scheduled_at": "2026-04-07T20:00:00Z",
          "status": "scheduled",
          "content_rating": { "system": "tv_parental", "rating": "TV-14" },
          "guest_talent": [{ "role": "guest", "name": "Samira Okafor" }],
          "valid_until": "2026-04-06T20:00:00Z"
        },
        {
          "episode_id": "s1e04",
          "name": "TBD",
          "scheduled_at": "2026-04-14T20:00:00Z",
          "status": "tentative",
          "valid_until": "2026-04-07T20:00:00Z"
        }
      ],

      "placements": [
        { "placement_id": "pre_roll", "name": "Pre-roll", "format_ids": ["..."] },
        { "placement_id": "mid_roll", "name": "Mid-roll", "format_ids": ["..."] }
      ],

      "delivery_type": "guaranteed",
      "pricing_options": [
        { "pricing_option_id": "flat", "pricing_model": "flat_rate", "fixed_price": 500000, "currency": "USD" }
      ],
      "forecast": { "..." : "..." }
    }
  ]
}
```

The show is defined once in `shows` and referenced by `show_ids` on the product. If multiple products reference the same show (e.g., a bundle product and individual episode products), the show object isn't duplicated. `show_ids` is an array because a single product can span multiple shows — for example, a podcast network selling "all our tech podcasts in April."

Episode S1E04 is tentative and doesn't have a name yet. That's fine — episodes get filled in as production progresses.

### Products Without Episodes

A product can reference a show without listing specific episodes. This means "inventory across this show, whatever episodes air during the product's flight dates":

```json
{
  "product_id": "pinnacle_games_run_of_show",
  "name": "Pinnacle Games Run of Show",
  "show_ids": ["pinnacle_games"],
  "placements": [
    { "placement_id": "pre_roll", "name": "Pre-roll" }
  ],
  "delivery_type": "non_guaranteed",
  "pricing_options": [
    { "pricing_option_id": "cpm", "pricing_model": "cpm", "floor_price": 25.00, "currency": "USD" }
  ]
}
```

### Products With Specific Episodes

For premium/guaranteed buys, the seller can scope to specific episodes:

```json
{
  "product_id": "pinnacle_games_finale_sponsorship",
  "name": "Pinnacle Games Season Finale Exclusive Sponsorship",
  "show_ids": ["pinnacle_games"],
  "episodes": [
    {
      "episode_id": "s1e10_finale",
      "name": "The Grand Finale",
      "scheduled_at": "2026-06-02T20:00:00Z",
      "status": "scheduled",
      "ad_inventory": {
        "expected_breaks": 6,
        "total_ad_seconds": 720,
        "unplanned_breaks": false
      }
    }
  ],
  "delivery_type": "guaranteed",
  "pricing_options": [
    { "pricing_option_id": "flat", "pricing_model": "flat_rate", "fixed_price": 2000000, "currency": "USD" }
  ]
}
```

### Multi-Show Bundle

A podcast network or YouTube MCN can sell a bundle product spanning multiple shows. Each episode references its parent show via `show_id`:

```json
{
  "shows": [
    { "show_id": "tech_weekly", "name": "Tech Weekly", "genre": ["IAB19"], "status": "active" },
    { "show_id": "startup_hour", "name": "The Startup Hour", "genre": ["IAB3"], "status": "active" }
  ],

  "products": [
    {
      "product_id": "technet_april_bundle",
      "name": "TechNet Podcast Bundle - April",
      "show_ids": ["tech_weekly", "startup_hour"],
      "episodes": [
        { "episode_id": "tw_ep12", "show_id": "tech_weekly", "scheduled_at": "2026-04-07T10:00:00Z", "status": "scheduled" },
        { "episode_id": "tw_ep13", "show_id": "tech_weekly", "scheduled_at": "2026-04-14T10:00:00Z", "status": "tentative" },
        { "episode_id": "sh_ep30", "show_id": "startup_hour", "scheduled_at": "2026-04-09T14:00:00Z", "status": "scheduled" },
        { "episode_id": "sh_ep31", "show_id": "startup_hour", "scheduled_at": "2026-04-16T14:00:00Z", "status": "tentative" }
      ],
      "delivery_type": "guaranteed",
      "pricing_options": [
        { "pricing_option_id": "bundle", "pricing_model": "flat_rate", "fixed_price": 25000, "currency": "USD" }
      ]
    }
  ]
}
```

Each episode includes `show_id` because the product spans multiple shows — the buyer agent needs to know which show each episode belongs to.

### The Conflict Case

"Buy all Pinnacle Games episodes in April" vs. "Buy Pinnacle Games S1E3":

- Both products reference the same show, with overlapping scope
- The seller manages this operationally — when the bundle sells, individual episode products disappear from `get_products` results or get updated forecasts
- The protocol doesn't model the constraint graph; it represents what's currently available
- This is the same pattern as property targeting: if a buyer purchases all inventory on a property, products scoping to subsets become unavailable

## How Buyers Discover Shows

### Via get_products

Buyers already use `get_products` to discover inventory. Show-aware products appear naturally:

```json
{
  "buying_mode": "brief",
  "brief": "Looking for competition reality shows reaching 18-34 males in April",
  "filters": {
    "channels": ["ctv"],
    "start_date": "2026-04-01",
    "end_date": "2026-04-30"
  }
}
```

The seller returns products referencing shows from the top-level `shows` array. The buyer agent can evaluate the show's genre, rating, talent, and upcoming episodes without additional lookups.

### Podcast Example

A podcast network like Wonderstruck distributes across Spotify, Apple Podcasts, YouTube, its own website, and Substack. The show object captures this distribution footprint, and the product references the show by ID.

```json
{
  "shows": [
    {
      "show_id": "signal_noise",
      "name": "Signal & Noise",
      "genre": ["technology", "business"],
      "content_rating": { "system": "podcast", "rating": "explicit" },
      "cadence": "weekly",
      "status": "active",
      "talent": [
        { "role": "host", "name": "Maren Solberg", "brand_url": "https://marensolberg.example.com/brand.json" }
      ],
      "distribution": [
        {
          "publisher_domain": "spotify.com",
          "identifiers": [{ "type": "spotify_show_id", "value": "4rOoJ6Egrf8K2IrywzwOMk" }]
        },
        {
          "publisher_domain": "apple.com",
          "identifiers": [{ "type": "apple_podcast_id", "value": "1234567890" }]
        },
        {
          "publisher_domain": "youtube.com",
          "identifiers": [{ "type": "youtube_channel_id", "value": "UC_example" }]
        },
        {
          "publisher_domain": "signalnoise.com",
          "identifiers": [{ "type": "domain", "value": "signalnoise.com" }]
        },
        {
          "publisher_domain": "substack.com",
          "identifiers": [{ "type": "substack_id", "value": "signalnoise" }]
        }
      ]
    }
  ],

  "products": [
    {
      "product_id": "signalnoise_april",
      "name": "Signal & Noise Podcast - April Episodes",
      "publisher_properties": [{
        "publisher_domain": "spotify.com",
        "selection_type": "by_id",
        "property_ids": ["signalnoise_feed"]
      }],

      "show_ids": ["signal_noise"],
      "episodes": [
        {
          "episode_id": "ep47",
          "name": "The Future of Programmatic with Samira Okafor",
          "scheduled_at": "2026-04-07T10:00:00Z",
          "status": "scheduled",
          "guest_talent": [
            { "role": "guest", "name": "Samira Okafor", "brand_url": "https://samiraokafor.example.com/brand.json" }
          ]
        },
        {
          "episode_id": "ep48",
          "scheduled_at": "2026-04-14T10:00:00Z",
          "status": "tentative"
        },
        {
          "episode_id": "ep49",
          "scheduled_at": "2026-04-21T10:00:00Z",
          "status": "tentative"
        },
        {
          "episode_id": "ep50",
          "scheduled_at": "2026-04-28T10:00:00Z",
          "status": "tentative"
        }
      ],

      "placements": [
        { "placement_id": "pre_roll", "name": "Pre-roll (30s)", "format_ids": ["..."] },
        { "placement_id": "mid_roll", "name": "Mid-roll (60s)", "format_ids": ["..."] }
      ],

      "delivery_type": "guaranteed",
      "pricing_options": [
        { "pricing_option_id": "flat_monthly", "pricing_model": "flat_rate", "fixed_price": 15000, "currency": "USD" },
        { "pricing_option_id": "per_episode", "pricing_model": "flat_rate", "fixed_price": 5000, "currency": "USD" }
      ]
    }
  ]
}
```

Note: ep48-50 are tentative with no names or guest info — they haven't been produced yet. The buyer evaluates based on the show's baseline profile (explicit tech/business podcast, hosted by Maren Solberg) and the known details of ep47.

## Brand Safety

### Show-Level Safety

A show's baseline brand safety profile comes from:
- `content_rating`: The show's declared rating system and value
- `genre`: Content categories
- `talent`: The people involved (buyer agents can look up their brand.json)

This is what buyers evaluate when individual episode content isn't known. "I'll advertise on Pinnacle Games because it's TV-PG competition entertainment hosted by Rex Valor, whose brand.json shows he's family-friendly."

### Episode-Level Safety

When episode details are known, they can override the show baseline:
- Episode-specific `content_rating` (this week is TV-14 instead of the usual TV-PG)
- Episode-specific `guest_talent` (a controversial guest changes the safety profile)
- Episode-specific topic/theme metadata

### What We Don't Model

We don't predict content safety for unknown future episodes. A buyer who commits to "all April episodes" is buying based on the show's baseline profile, accepting variation. The seller's content standards and the show's track record are the buyer's basis for that decision.

## Relationship to LEAP

IAB Tech Lab's LEAP Forecasting API (in public comment through March 20, 2026) solves a similar problem for live streaming: publishers exposing upcoming events with audience forecasts and ad inventory configuration.

### Concepts adopted from LEAP

| LEAP Concept | AdCP Equivalent |
|-------------|----------------|
| UpcomingEvent | Episode (with `scheduled_at` and `status`) |
| Content (AdCOM 1.0) | Show metadata (genre, rating, talent) |
| StreamsData (peak viewers by country) | Product forecast (delivery estimates by budget) |
| AdInventoryConfiguration | Episode `ad_inventory` + product placements |
| Event status (scheduled/tentative/cancelled) | Episode `status` |
| Unplanned breaks | Episode `ad_inventory.unplanned_breaks` |
| Flexible end time | Episode `flexible_end` |

### What we don't adopt

- LEAP's Concurrent Streams API — real-time viewer counts are an infrastructure concern below AdCP's layer
- LEAP's specific data formats (Unix timestamps, AdCOM object references) — we use our own conventions
- LEAP's push/pull architecture — AdCP uses MCP tasks

LEAP validates the industry need. Their model is designed for SSP-to-DSP plumbing. Ours operates at the agent-to-agent negotiation layer where buying decisions happen.

## Relationship to Existing Concepts

### Properties

Properties remain the technical advertising surface. Shows are carried BY properties. A product's `publisher_properties` says where the ad runs; its `show` says what content it runs in.

### Placements

Placements remain ad positions within a product (pre-roll, mid-roll, sidebar). Shows and placements are parallel dimensions on a product, not hierarchical.

### Artifacts

The existing artifact schema in content-standards is a brand-safety evaluation primitive — it represents a specific piece of content for safety scoring. An episode might produce one or more artifacts for safety evaluation, but shows and episodes exist for buying decisions, not safety scanning. These are complementary: shows are for inventory discovery, artifacts are for content analysis.

### brand.json

Talent on shows can reference brand.json entries. This connects shows to the broader identity graph. A host's brand.json tells the buyer agent who this person is and what they represent. A guest's brand.json does the same for episode-level evaluation.

## Virtual Product Placements

Shows and episodes enable virtual product placement:

1. **Identify the content**: Episode S1E3 of Pinnacle Games
2. **Identify the placement**: A virtual placement within that episode
3. **Assign the creative**: The brand's product composited into the scene

Without shows/episodes, there's no structured way to reference which piece of content a virtual placement appears in.

## Open Questions

1. **Live events vs. series**: Are one-time live events (a championship final, a global ceremony) shows with one episode? The model works mechanically (status: scheduled, flexible_end: true, unplanned_breaks: true). A major annual sporting event is arguably a recurring show — it happens every year with episodes (each game). A multi-week event is definitely a show with many episodes (each competition). Probably fine as-is.

2. **Generative surfaces**: When an AI persona is the advertising surface, what's the show? The persona? The conversation? This may be a future concern but worth noting as the model evolves.

3. **Show-level filtering**: Should `get_products` filters include show attributes (genre, rating, talent)? Or is brief-mode intelligence sufficient for now?

4. **Episode granularity in packages**: When a buyer purchases a product with multiple episodes, can they later target specific episodes in their package's `targeting_overlay`? Or is episode scoping only at the product level?

## Resolved Questions

- **Cross-seller show identity**: Solved by distribution identifiers. Buyer agents match shows across sellers via shared platform identifiers (same youtube_channel_id = same show). Platform-independent identifiers like `imdb_id` and `gracenote_id` help for TV/film content.
- **Where do shows live?**: Top-level objects in `get_products` responses, referenced by `show_id` on products. Same pattern as properties — declared by the seller, no external hosting.
- **Naming**: "Show" — universally understood across media types, not overloaded in tech.
- **Distribution identifier types**: Open enum covering podcast platforms (apple_podcast_id, spotify_show_id, podcast_guid, rss_url, amazon_music_id, iheart_id, podcast_index_id), video/CTV (youtube_channel_id, youtube_playlist_id, amazon_title_id, roku_channel_id, peacock_id, pluto_channel_id, tubi_id, tiktok_id, twitch_channel), and cross-platform references (imdb_id, gracenote_id, eidr_id, domain, substack_id). New types added as distribution channels emerge. Shows SHOULD include at least one platform-independent identifier.
