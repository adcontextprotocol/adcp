-- Perspective: Why adagents.json is more expressive than ads.txt

INSERT INTO perspectives (
  slug,
  content_type,
  title,
  subtitle,
  category,
  excerpt,
  content,
  author_name,
  featured_image_url,
  status,
  published_at,
  display_order,
  tags
) VALUES (
  'adagents-json-vs-ads-txt',
  'article',
  'Why adagents.json is more expressive than ads.txt',
  'A better way to represent modern publisher authorization',
  'Perspective',
  'ads.txt made supply-chain transparency possible, but it was built for a flatter world. adagents.json can describe the actual commercial shape of modern media: direct paths, delegated paths, placements, collections, countries, time windows, and governed inventory groupings.',
  $article$
The recent [AdExchanger piece on connected TV and ads.txt](https://www.adexchanger.com/on-tv-and-video/why-ads-txt-needs-to-evolve-for-connected-tv/) is directionally right about the problem. Premium media and CTV do not suffer from too much complexity. They suffer from too little vocabulary for representing that complexity.

`ads.txt` was a necessary step. It gave the industry a simple way to answer a simple question: is this seller present on the publisher''s list? That was a major improvement over a world where buyers often had no publisher-declared source of truth at all.

But modern publisher monetization is not a flat seller list.

- A publisher may have one direct path for premium homepage video.
- Another path may be delegated to a programmatic sales channel for banners and native units.
- A third path may be valid only in certain countries or during a specific rights window.
- A fourth path may represent a distinct network-managed slot on the same page.

Those are not edge cases. They are normal commercial conditions.

## What `ads.txt` does well

`ads.txt` is intentionally simple:

```text
ssp.pinnacle.example, pub-123, DIRECT
novaexchange.example, acct-456, RESELLER
riverline.example, acct-789, RESELLER
```

That format is useful for answering:

- Is a seller declared at all?
- Is the relationship labeled direct or reseller?

But it does not answer cleanly or explicitly:

- Which property?
- Which collection or content program?
- Which placement?
- Which country?
- Which dates?
- Which delegated commercial path?
- Is the network slot at the bottom of the page the same thing as the publisher''s premium video placement?

That missing context is exactly where trust breaks down.

Some of these distinctions can be approximated today through combinations of `ads.txt`, `sellers.json`, manager-domain conventions, and platform-specific interpretation. But those are still partial signals spread across multiple layers. They do not give the publisher a clean, structured way to declare: this specific placement on this specific property is available through this delegated path, in these countries, during this window, and not through that other path.

## What `adagents.json` can say instead

`adagents.json` starts from a different premise. A publisher should be able to describe not just who is present, but what each path is authorized to make available.

That is why the recent additions matter:

- `delegation_type` distinguishes `direct`, `delegated`, and `ad_network`
- `collections` let publishers scope authorization to recurring content programs
- `placements` create a publisher-governed inventory namespace with stable `placement_id` values
- `placement_tags` let publishers define commercial groupings like `programmatic`, `direct_only`, or `managed_by_riverline`
- `countries` and `effective_from` / `effective_until` let authorization match real commercial terms
- `exclusive` lets publishers signal when a path is sole versus concurrent
- `signing_keys` give buyers a publisher-attested trust anchor for signed agent responses

This moves the model from flat presence to scoped authorization.

## Side by side

Here is the same commercial reality expressed in both systems.

### `ads.txt`

```text
ssp.pinnacle.example, pub-123, DIRECT
novaexchange.example, acct-456, RESELLER
riverline.example, acct-789, RESELLER
```

That tells a buyer very little about the shape of the inventory unless they combine it with other files, conventions, and platform-specific assumptions.

### `adagents.json`

```json
{
  "properties": [
    {
      "property_id": "pinnacle_news",
      "name": "Pinnacle News",
      "publisher_domain": "example.com"
    }
  ],
  "placements": [
    {
      "placement_id": "hero_video",
      "name": "Hero video",
      "property_ids": ["pinnacle_news"],
      "tags": ["direct_only", "premium_video"]
    },
    {
      "placement_id": "article_banner",
      "name": "Article banner",
      "property_ids": ["pinnacle_news"],
      "tags": ["programmatic"]
    },
    {
      "placement_id": "riverline_feed",
      "name": "Bottom recirculation feed",
      "property_ids": ["pinnacle_news"],
      "tags": ["managed_by_riverline"]
    }
  ],
  "placement_tags": {
    "programmatic": {
      "name": "Programmatic",
      "description": "Placements available through programmatic sales agents"
    },
    "direct_only": {
      "name": "Direct only",
      "description": "Placements sold only through the publisher''s direct path"
    },
    "managed_by_riverline": {
      "name": "Managed by Riverline",
      "description": "Placements available only through the Riverline path"
    }
  },
  "authorized_agents": [
    {
      "url": "https://sales.pinnacle.example",
      "authorized_for": "Publisher direct sales path",
      "authorization_type": "property_ids",
      "property_ids": ["pinnacle_news"],
      "delegation_type": "direct"
    },
    {
      "url": "https://ssp.novaexchange.example",
      "authorized_for": "Programmatic supply",
      "authorization_type": "property_ids",
      "property_ids": ["pinnacle_news"],
      "placement_tags": ["programmatic"],
      "delegation_type": "delegated",
      "countries": ["US", "CA"]
    },
    {
      "url": "https://riverline.example",
      "authorized_for": "Bottom-of-page recirculation inventory",
      "authorization_type": "property_ids",
      "property_ids": ["pinnacle_news"],
      "placement_ids": ["riverline_feed"],
      "delegation_type": "ad_network"
    }
  ]
}
```

That tells a buyer something much closer to commercial reality:

| Placement | Direct path | Programmatic path | Network path |
|---|---|---|---|
| `hero_video` | Yes | No | No |
| `article_banner` | Yes | Yes | No |
| `riverline_feed` | No | No | Yes |

## Why this is better than evolving `ads.txt` by accretion

The risk with any transparency standard is that it accumulates vague labels faster than it accumulates clarity. That is how systems become technically richer while becoming harder to interpret.

The better path is to separate concerns:

- property identity
- placement identity
- delegation type
- authorization scope
- publisher-defined grouping tags
- time and geography qualifiers

Each of those tells the buyer something different. None of them needs to be inferred from one overloaded field.

That is what makes `adagents.json` more powerful. It does not reduce everything to a seller list and force the buyer to guess the rest.

## The real opportunity

The future of supply-chain transparency is not a slightly longer text file. It is a publisher-declared model that reflects how inventory is actually sold.

Publishers need to be able to say:

- this path is direct
- this path is delegated
- this path is a network-mediated slot
- these placements are available programmatically
- these placements are direct-only
- this authorization is country-limited
- this authorization expires at the end of the quarter

Those are ordinary business facts. A modern transparency layer should represent them directly.

That is the opportunity for `adagents.json`: not to become a clone of `ads.txt`, but to become a better expression of publisher truth.
$article$,
  'Brian O''Kelley',
  'https://agenticadvertising.org/api/perspectives/adagents-json-vs-ads-txt/card.png',
  'published',
  '2026-03-30 00:00:00+00',
  0,
  ARRAY['perspective', 'adagents.json', 'ads.txt', 'supply-chain', 'ctv']
) ON CONFLICT (slug) DO NOTHING;
