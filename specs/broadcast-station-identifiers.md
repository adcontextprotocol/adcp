# Broadcast Station Identifiers

**Status**: Draft

## Problem

The protocol has `radio` as a property type and `linear_tv` as a channel, but no identifier types for broadcast stations. The docs show `call_sign` in examples, but it doesn't exist in the `identifier-types.json` enum. Radio properties today have no valid way to identify themselves.

Call signs are the obvious starting point, but they're a North American concept. Most of Europe, India, and parts of Asia don't use call signs for broadcasting at all. A protocol claiming global scope can't assume call signs exist everywhere.

Meanwhile, several well-established identifier systems do exist — FCC facility IDs, RadioDNS FQDNs, DVB service triples, DAB service IDs — but none of them is universal. Every market uses a different combination.

## Design Principles

1. **Property type provides the medium** — a `call_sign` on a `radio` property is a radio call sign. We don't need `radio_call_sign` vs `broadcast_call_sign`. This is how every other identifier type works (`bundle_id` means different things on `ctv_app` vs `mobile_app`).

2. **Multiple identifiers per property** — stations have many identifiers simultaneously (call sign, facility ID, RadioDNS FQDN, Nielsen code). The existing `identifiers` array already supports this.

3. **No single identifier is universal** — the spec must support the identifier systems that actually exist in each market without privileging one over another.

4. **Authority-namespaced where needed** — some identifiers only make sense within the context of a specific regulatory body or system. Rather than creating dozens of identifier types, use a namespace pattern for regulatory IDs.

## Identifier Types to Add

### `call_sign`

The station's regulatory call sign as assigned by the national authority (FCC, CRTC, ACMA, etc.).

**Where it exists**: US, Canada, Mexico, Australia, Japan, South Korea, Argentina. Does not exist in most of Europe, India, or Brazil.

**Value format**: The full call sign including suffix. Examples:
- `WCBS-FM` (US FM radio)
- `WMAQ-DT` (US digital TV)
- `CFTO-DT` (Canadian TV)
- `XHRED-FM` (Mexican FM radio)
- `2GB` (Australian AM radio)
- `JOAK-FM` (Japanese FM radio)

**Validation guidance** (non-normative):
- On `radio` properties: expect suffixes like `-FM`, `-AM`, `-HD`, or no suffix (AM stations often omit `-AM`)
- On `linear_tv` properties: expect suffixes like `-TV`, `-DT`, `-LP`, `-LD`, `-CD`
- Cross-medium mismatch (e.g., `-FM` on a `linear_tv` property) should be flagged as a warning, not a hard error, because suffix conventions vary by country

### `facility_id`

The numeric identifier assigned by a national broadcast regulator to a specific licensed station.

**Where it exists**: US (FCC facility ID), Canada (CRTC decision number), and other countries with numeric license registries.

**Value format**: The numeric ID as a string, prefixed with the regulatory authority. Examples:
- `fcc:73953` (WMAQ-DT Chicago)
- `crtc:2019-389` (a CRTC decision reference)
- `acma:1234567` (Australian ACMA license)
- `ofcom:AL000001` (UK Ofcom license)

The `authority:id` format lets us support every national regulator without creating a separate identifier type for each one. The authority prefix is a lowercase slug of the regulatory body.

**Known authority prefixes** (defined in `enums/facility-authority.json`):

| Prefix | Authority | Jurisdiction |
|--------|-----------|-------------|
| `fcc` | Federal Communications Commission | United States |
| `crtc` | Canadian Radio-television and Telecommunications Commission | Canada |
| `ift` | Instituto Federal de Telecomunicaciones | Mexico |
| `ofcom` | Office of Communications | United Kingdom |
| `arcom` | Autorité de régulation de la communication audiovisuelle et numérique | France |
| `bnetza` | Bundesnetzagentur | Germany |
| `medienanstalt` | Landesmedienanstalten (state media authorities) | Germany |
| `acma` | Australian Communications and Media Authority | Australia |
| `mic` | Ministry of Internal Affairs and Communications | Japan |
| `msit` | Ministry of Science and ICT | South Korea |
| `anatel` | Agência Nacional de Telecomunicações | Brazil |
| `enacom` | Ente Nacional de Comunicaciones | Argentina |
| `trai` | Telecom Regulatory Authority of India | India |

This is a closed enum. New authorities are added via spec revision as markets adopt AdCP.

### `radiodns`

The RadioDNS FQDN for the station, as defined by the RadioDNS specification.

**Where it exists**: Primarily Europe (BBC, EBU members, Global, Bauer). Growing adoption but not universal.

**Why it matters**: RadioDNS is the closest thing to a universal, machine-readable radio station identifier. It maps broadcast signals (FM frequency + RDS PI code, DAB ensemble + service ID, HD Radio station ID) to DNS-based identifiers that resolve to station metadata.

**Recommendation**: RadioDNS is the preferred identifier for European radio properties. Stations outside Europe are encouraged to register but not required to. Properties should include a RadioDNS identifier when one exists.

**Value format**: The RadioDNS FQDN. Examples:
- `09580.09580.fm.radiodns.org` (an FM station via PI code + frequency)
- `0.c224.ce15.ce1.dab.radiodns.org` (a DAB station)

### `dvb_service`

The DVB-SI service identifier triple for a digital television service.

**Where it exists**: Most of the world's digital TV markets outside North America and Japan/Brazil (i.e., DVB markets: Europe, parts of Asia, Africa, Middle East, Oceania).

**Value format**: `{onid}.{tsid}.{sid}` — three dot-separated 16-bit integers representing Original Network ID, Transport Stream ID, and Service ID. Example:
- `8468.8199.28106` (a DVB service)

### `dab_service`

The DAB/DAB+ service identifier for a digital radio station.

**Where it exists**: Europe (UK, Germany, Norway, Denmark, Switzerland), Australia, South Korea.

**Value format**: `{gcc}.{eid}.{sid}` — Global Country Code, Ensemble ID, and Service ID. Example:
- `ce1.ce15.c224`

## What We're Not Adding

### `nielsen_station_id`

Nielsen codes are proprietary, US-centric, and not freely redistributable. Stations that need Nielsen integration can use tags or a custom identifier in `additionalProperties` (which the property schema already allows). If Nielsen adoption in adagents.json becomes significant, we can reconsider.

### Medium-specific call sign types (`radio_call_sign`, `broadcast_call_sign`)

The property type already disambiguates medium. Adding medium to the identifier type is redundant and doesn't scale.

### `call_sign` with a `medium` sub-field

Breaks the clean `{type, value}` pair structure that every other identifier uses. One-off structural exception for no clear gain.

### `frequency`

Frequencies are geographic and can be reused across markets. A frequency alone doesn't identify a station. Where frequency matters (RadioDNS), it's encoded in the RadioDNS FQDN.

### `market` or `dma`

Market is a property of the station's coverage area, not an identifier. It belongs in tags or a future geographic metadata field, not in `identifiers`.

## Property Type Changes

### Add `linear_tv`

`linear_tv` already exists in the `channels.json` enum but not in `property-type.json`. Add it:

```json
"linear_tv": "Linear television stations and networks, identified by call signs, facility IDs, or DVB service identifiers"
```

This is required for broadcast TV stations to declare themselves as properties in `adagents.json`.

### Update `radio` description

```json
"radio": "Radio station properties, identified by call signs, facility IDs, RadioDNS FQDNs, or DAB service identifiers"
```

## Examples

### US FM radio station

```json
{
  "property_type": "radio",
  "name": "WBEZ Chicago",
  "identifiers": [
    { "type": "call_sign", "value": "WBEZ-FM" },
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
    { "type": "call_sign", "value": "WMAQ-DT" },
    { "type": "facility_id", "value": "fcc:73953" }
  ],
  "supported_channels": ["linear_tv"]
}
```

### UK DAB radio station (no call sign)

```json
{
  "property_type": "radio",
  "name": "BBC Radio 4",
  "identifiers": [
    { "type": "radiodns", "value": "0.c224.ce15.ce1.dab.radiodns.org" },
    { "type": "dab_service", "value": "ce1.ce15.c224" },
    { "type": "facility_id", "value": "ofcom:AL000001" }
  ],
  "supported_channels": ["radio"]
}
```

### German TV channel (DVB, no call sign)

```json
{
  "property_type": "linear_tv",
  "name": "Das Erste",
  "identifiers": [
    { "type": "dvb_service", "value": "8468.8199.28106" },
    { "type": "facility_id", "value": "medienanstalt:12345" }
  ],
  "supported_channels": ["linear_tv"]
}
```

### Australian AM radio station

```json
{
  "property_type": "radio",
  "name": "2GB Sydney",
  "identifiers": [
    { "type": "call_sign", "value": "2GB" }
  ],
  "supported_channels": ["radio"]
}
```

### Rep firm with both TV and radio (the issue #1908 scenario)

```json
{
  "properties": [
    {
      "property_id": "wcbs_tv",
      "property_type": "linear_tv",
      "name": "CBS New York (WCBS-TV)",
      "identifiers": [
        { "type": "call_sign", "value": "WCBS-TV" },
        { "type": "facility_id", "value": "fcc:25434" }
      ],
      "supported_channels": ["linear_tv"]
    },
    {
      "property_id": "wcbs_fm",
      "property_type": "radio",
      "name": "WCBS-FM New York",
      "identifiers": [
        { "type": "call_sign", "value": "WCBS-FM" },
        { "type": "facility_id", "value": "fcc:9610" }
      ],
      "supported_channels": ["radio"]
    }
  ]
}
```

No ambiguity. Different properties, different property types, different identifiers. A buyer agent matching on property type will never accidentally cross media boundaries.

## Property Catalog Integration

The property catalog (see `specs/property-registry-catalog.md`) can ingest broadcast station data as facts:

- **FCC/CRTC/ACMA databases** as fact sources (confidence: authoritative for their jurisdiction)
- **RadioDNS lookups** as linking facts (connecting FM frequency to DAB service to streaming URL)
- **DVB-SI scan data** for TV station identification in DVB markets

The catalog's fact-graph model is well-suited to broadcast: a single station has multiple identifiers across systems, and the catalog can link them under one `property_rid` using evidence from multiple sources.

### New fact source pipelines

| Pipeline | Facts produced | Confidence |
|----------|---------------|------------|
| FCC ULS/LMS | call_sign, facility_id, licensee, coverage area | authoritative |
| CRTC database | call_sign, facility_id, licensee | authoritative |
| ACMA BSL | call_sign, facility_id, licensee | authoritative |
| RadioDNS resolver | radiodns FQDN, linked FM/DAB/HD identifiers | strong |
| DVB-SI scan | dvb_service triple, service name | strong |
| DAB ensemble scan | dab_service, ensemble metadata | strong |

## Schema Changes Summary

### `enums/identifier-types.json`

Add: `call_sign`, `facility_id`, `radiodns`, `dvb_service`, `dab_service`

### `enums/property-type.json`

Add: `linear_tv`
Update description for: `radio`

### `core/property.json`

No structural changes. The existing `{type, value}` pair with `additionalProperties: true` handles everything.

## Migration

No breaking changes. All new identifier types are additive. Existing properties are unaffected.

The docs example in `governance/property/authorized-properties.mdx` that uses `call_sign` and `market` will become partially valid (call_sign will exist; market should be removed and replaced with tags).

## Resolved Questions

1. **`facility_id` authority prefixes**: Closed enum of known authorities. Broadcast regulators are a fixed universe — new entries added via spec revision. See the authority table above.

2. **RadioDNS**: Recommended but not required. It's the best machine-readable identifier for radio stations, but requiring it would exclude stations that haven't registered — especially smaller and non-European ones. The spec should note it as the preferred identifier for European radio properties and encourage adoption elsewhere.

3. **Satellite radio (SiriusXM)**: Out of scope. SiriusXM is a nationally licensed streaming service, not station-by-station broadcasting. It fits as `streaming_audio` with a `network_id`. No special handling needed.

4. **ATSC 3.0 BSIDs**: Not included. The BSID format is stable (uint16, defined in ATSC A/331) but it's a transport-layer identifier, not a business identifier. BSIDs are self-assigned by broadcasters with local market coordination — no public registry exists, and they're only unique within a market, not globally. The FCC facility ID already covers ATSC 3.0 stations (same station keeps its facility ID across the 1.0→3.0 transition), so there's no gap to fill.
