# Broadcast Station Identifiers

**Status**: Draft

## Problem

The protocol has `radio` as a property type and `linear_tv` as a channel, but no identifier types for broadcast stations. Radio and TV stations have no valid way to identify themselves in `adagents.json`.

## Design Principles

1. **Match the protocol's existing pattern** — `domain` identifies web properties as a flat, human-recognizable string. `station_id` does the same for broadcast stations. The protocol doesn't need to parse or validate the value — it just needs a stable string that buyer and seller agents agree on.

2. **Multiple identifiers per property** — a station can have both a `station_id` (the name both sides know) and a `facility_id` (the regulatory reference for precise resolution). The existing `identifiers` array supports this. The catalog aliases them to the same `property_rid`.

3. **Transport-layer identifiers are out of scope** — RadioDNS FQDNs, DVB service triples, and DAB service IDs tell a device how to tune or find a stream. They don't change the station's identity. A buyer targeting BBC Radio 4 doesn't think in DAB multiplex codes. These are catalog/registry concerns, not protocol concerns.

4. **Regulatory lookups are catalog work** — if a signals agent or measurement provider needs to resolve a station to its FCC facility ID behind the scenes, that's their job. The protocol provides `facility_id` as a namespace for this, but doesn't enforce a schema-level authority enum.

## Identifier Types

### `station_id`

The primary broadcast station identifier — a human-recognizable string that both sides of a transaction agree on. This is the call sign, station name, or other locally understood identifier depending on the market.

**Examples by market:**

| Market | station_id | Notes |
|--------|-----------|-------|
| US | `WCBS-FM` | FCC call sign — universal in US broadcast buying |
| Canada | `CFMB-AM` | CRTC call sign |
| France | `France Inter` | Station name — how buyers and measurement systems reference it |
| UK | `BBC Radio 4` | Ofcom service name |
| Australia | `2GB` | ACMA call sign |
| Germany | `Das Erste` | Station name |
| Japan | `JOAK-FM` | MIC call sign |

### `facility_id`

The regulatory facility or license ID from a national broadcast regulator, prefixed with an authority slug. Provides a precise, machine-resolvable secondary identifier for cross-referencing.

**Value format**: `{authority}:{id}` — authority slug followed by the regulator's identifier. Examples:
- `fcc:73953` (WMAQ-DT Chicago)
- `crtc:2019-389` (a CRTC decision reference)
- `ofcom:AL000001` (UK Ofcom license)
- `acma:1234567` (Australian ACMA license)

**Known authority prefixes**: `fcc` (US), `crtc` (Canada), `ift` (Mexico), `ofcom` (UK), `arcom` (France), `bnetza`/`medienanstalt` (Germany), `acma` (Australia), `mic` (Japan), `msit` (South Korea), `anatel` (Brazil), `enacom` (Argentina), `trai` (India). Documented in the `facility_id` enum description — not a separate schema file.

## What We're Not Adding

### `call_sign` as a separate type

Merged into `station_id`. Call signs are the locally recognized identifier in markets that use them (US, Canada, Australia, Japan). In markets that don't use call signs (UK, France, Germany), station names serve the same purpose. One type covers both.

### `radiodns`, `dvb_service`, `dab_service`

Transport/delivery-layer identifiers. They tell devices how to tune or locate a stream, not what station it is. If the catalog needs to link a station to its RadioDNS FQDN or DVB service triple, it can do that in its fact graph — the protocol doesn't need to carry these.

### `facility-authority.json` enum

Over-engineering. The known authority prefixes are documented in the `facility_id` enum description. Adding a separate schema file and validation for a dozen regulatory authority slugs adds complexity without proportional value. The catalog can validate prefixes if needed.

### `nielsen_station_id`

Proprietary, US-centric, not freely redistributable.

### `frequency`, `market`, `dma`

Frequencies are geographic and reusable. Market is a coverage attribute, not an identifier. Both belong in tags or geographic metadata.

## Property Type Changes

### Add `linear_tv`

`linear_tv` exists in `channels.json` but not `property-type.json`. Required for broadcast TV stations to declare themselves as properties.

### Update `radio` and `linear_tv` descriptions

```json
"radio": "Radio station properties, identified by station ID or facility ID"
"linear_tv": "Linear television stations and networks, identified by station ID or facility ID"
```

## Examples

### US FM radio station

```json
{
  "property_type": "radio",
  "name": "WBEZ Chicago",
  "identifiers": [
    { "type": "station_id", "value": "WBEZ-FM" },
    { "type": "facility_id", "value": "fcc:21242" }
  ],
  "tags": ["public_radio", "npr_affiliate"],
  "supported_channels": ["radio"]
}
```

### US TV station

```json
{
  "property_type": "linear_tv",
  "name": "NBC Chicago",
  "identifiers": [
    { "type": "station_id", "value": "WMAQ-DT" },
    { "type": "facility_id", "value": "fcc:73953" }
  ],
  "supported_channels": ["linear_tv"]
}
```

### UK radio station (no call sign)

```json
{
  "property_type": "radio",
  "name": "BBC Radio 4",
  "identifiers": [
    { "type": "station_id", "value": "BBC Radio 4" },
    { "type": "facility_id", "value": "ofcom:AL000001" }
  ],
  "supported_channels": ["radio"]
}
```

### German TV channel

```json
{
  "property_type": "linear_tv",
  "name": "Das Erste",
  "identifiers": [
    { "type": "station_id", "value": "Das Erste" },
    { "type": "facility_id", "value": "medienanstalt:12345" }
  ],
  "supported_channels": ["linear_tv"]
}
```

### Rep firm with both TV and radio (issue #1908 scenario)

```json
{
  "properties": [
    {
      "property_id": "wcbs_tv",
      "property_type": "linear_tv",
      "name": "CBS New York (WCBS-TV)",
      "identifiers": [
        { "type": "station_id", "value": "WCBS-TV" },
        { "type": "facility_id", "value": "fcc:25434" }
      ],
      "supported_channels": ["linear_tv"]
    },
    {
      "property_id": "wcbs_fm",
      "property_type": "radio",
      "name": "WCBS-FM New York",
      "identifiers": [
        { "type": "station_id", "value": "WCBS-FM" },
        { "type": "facility_id", "value": "fcc:9610" }
      ],
      "supported_channels": ["radio"]
    }
  ]
}
```

No ambiguity. Different properties, different property types, different identifiers. The `station_id` is the human-recognizable name; the `facility_id` provides precise regulatory resolution. The catalog links both to the same `property_rid`.

## Property Catalog Integration

The catalog resolves `station_id` and `facility_id` to stable `property_rid`s using its fact graph:

- If a publisher declares `station_id: "CBS FM New York"` and another uses `station_id: "WCBS-FM"` with the same `facility_id: "fcc:9610"`, the catalog links them to the same `property_rid`.
- RadioDNS lookups, DVB-SI scans, and DAB ensemble data can feed the catalog as facts — connecting the human-readable `station_id` to transport-layer identifiers behind the scenes.

### Fact source pipelines

| Pipeline | Facts produced | Confidence |
|----------|---------------|------------|
| FCC ULS/LMS | station_id (call sign), facility_id, licensee, coverage area | authoritative |
| CRTC database | station_id (call sign), facility_id, licensee | authoritative |
| ACMA BSL | station_id (call sign), facility_id, licensee | authoritative |
| RadioDNS resolver | linked FM/DAB/HD technical identifiers | strong |
| DVB-SI scan | service name, linked technical identifiers | strong |

## Schema Changes Summary

### `enums/identifier-types.json`

Add: `station_id`, `facility_id`

### `enums/property-type.json`

Add: `linear_tv`
Update descriptions for: `radio`, `linear_tv`

### `core/property.json`

No structural changes.

## Migration

No breaking changes. All new identifier types are additive.

## Resolved Questions

1. **Why not five identifier types?** Early design had `call_sign`, `facility_id`, `radiodns`, `dvb_service`, `dab_service`. Community feedback (B. Masse) correctly identified that RadioDNS/DVB/DAB are transport-layer identifiers, and that a single `station_id` matches the protocol's existing patterns. The protocol's job is agreement on identity, not regulatory database work.

2. **Why keep `facility_id`?** It provides a namespaced, machine-resolvable secondary identifier. The catalog can alias multiple `station_id` values to the same property when they share a `facility_id`. Same pattern as having both `ios_bundle` and `apple_app_store_id` for the same app.

3. **Satellite radio (SiriusXM)**: Out of scope. Fits as `streaming_audio` with a `network_id`.

4. **ATSC 3.0 BSIDs**: Not included. Transport-layer identifier with no public registry. FCC facility ID covers ATSC 3.0 stations.
