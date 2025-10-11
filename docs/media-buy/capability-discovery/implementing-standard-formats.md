---
title: Implementing Standard Format Support
---

# Implementing Standard Format Support

This guide is for **sales agents** implementing creative format support. Rather than requiring every sales agent to replicate IAB format definitions, AdCP provides a **reference creative agent** that centrally hosts standard formats.

## The Reference Creative Agent

**URL:** `https://creative.adcontextprotocol.org`

The reference creative agent provides authoritative definitions for industry-standard creative formats based on IAB specifications and common advertising practices. Sales agents can reference these formats instead of replicating them.

## Why Use Standard Formats?

### For Sales Agents
- **No maintenance burden**: Don't replicate IAB standard format definitions
- **Ecosystem consistency**: Everyone uses the same format specifications
- **Focus on differentiation**: Spend time on custom formats unique to your inventory

### For Buyers
- **Portability**: One creative works across multiple publishers
- **Predictability**: Format requirements are consistent
- **Faster launches**: No custom creative production per publisher

## How Sales Agents Reference Standard Formats

When implementing `list_creative_formats`, sales agents can reference the standard formats by including the reference creative agent in their response:

### Option 1: Reference Only Standard Formats

If you only support standard IAB formats with no custom requirements:

```json
{
  "formats": [],
  "creative_agents": [
    "https://creative.adcontextprotocol.org"
  ]
}
```

Buyers will query the reference agent to discover all standard formats you support.

### Option 2: Custom + Standard Formats

If you have custom formats plus standard format support:

```json
{
  "formats": [
    {
      "format_id": "publisher_takeover",
      "name": "Homepage Takeover",
      "agent_url": "https://youragent.com",
      "type": "rich_media",
      "assets_required": [...]
    }
  ],
  "creative_agents": [
    "https://creative.adcontextprotocol.org"
  ]
}
```

### Option 3: Standard Formats with Customization

If you support standard formats but need to validate or customize delivery:

```json
{
  "formats": [
    {
      "format_id": "display_300x250",
      "name": "Medium Rectangle",
      "agent_url": "https://youragent.com",
      "type": "display",
      "assets_required": [...]
    }
  ]
}
```

Use your own `agent_url` when you need format-specific validation, preview, or assembly logic beyond the standard spec.

## What Standard Formats Are Included?

The reference creative agent provides formats across all major channels:

- **[Display Formats](../../creative/channels/display.md)** - IAB standard banner sizes (300x250, 728x90, 320x50, etc.)
- **[Video Formats](../../creative/channels/video.md)** - Standard video ad specifications (15s, 30s, vertical, CTV)
- **[Audio Formats](../../creative/channels/audio.md)** - Streaming audio and podcast insertion formats
- **[DOOH Formats](../../creative/channels/dooh.md)** - Digital out-of-home billboard and transit specs
- **[Carousel Formats](../../creative/channels/carousels.md)** - Multi-product and slideshow formats

Each format includes:
- Precise technical requirements (dimensions, duration, file types)
- Required and optional assets with specifications
- Universal macro support
- Preview and validation capabilities

## Format Discovery Flow

When buyers discover formats from your sales agent:

1. **Buyer calls** `list_creative_formats` on your sales agent
2. **Your response includes** custom formats plus `creative_agents: ["https://creative.adcontextprotocol.org"]`
3. **Buyer recursively queries** the reference agent to discover standard formats
4. **Buyer sees combined list** of your custom formats plus all standard formats

The buyer tracks which URLs they've queried to avoid infinite loops.

## Best Practices for Sales Agents

### ✅ DO Reference Standard Formats

```json
{
  "creative_agents": [
    "https://creative.adcontextprotocol.org"
  ]
}
```

**When:** Your inventory accepts standard IAB sizes with no special requirements

**Why:** Reduces maintenance, ensures consistency, buyers already have compatible creatives

### ✅ DO Define Custom Formats

```json
{
  "formats": [
    {
      "format_id": "native_feed_card",
      "agent_url": "https://youragent.com",
      "type": "native"
    }
  ]
}
```

**When:** You have unique inventory experiences or specific technical requirements

**Why:** Enables differentiation and premium inventory

### ❌ DON'T Replicate Standard Formats

```json
{
  "formats": [
    {"format_id": "display_300x250", "agent_url": "https://youragent.com"},
    {"format_id": "display_728x90", "agent_url": "https://youragent.com"},
    {"format_id": "display_320x50", "agent_url": "https://youragent.com"},
    // ... copying 50+ standard formats
  ]
}
```

**Why not:** Maintenance burden, version drift, inconsistency across ecosystem

**Exception:** You need custom validation/preview logic for these formats

### ✅ DO Use Both When Appropriate

```json
{
  "formats": [
    // Your differentiating formats
  ],
  "creative_agents": [
    "https://creative.adcontextprotocol.org"
  ]
}
```

**Result:** Buyers see your custom formats plus all standard formats

## Format ID Namespacing

To prevent conflicts when multiple agents define formats, AdCP uses a **namespace pattern** for format identifiers.

### Namespace Pattern: `{domain}:{format_id}`

**Structure:**
```
domain:format_id
```

**Examples:**
- `creative.adcontextprotocol.org:display_300x250`
- `creative.adcontextprotocol.org:video_30s_hosted`
- `youragent.com:homepage_takeover_2024`
- `publisher.example:native_feed_card`

### Domain Requirements

**The domain in a namespaced format_id MUST:**

1. **Host a valid agent card** at `{domain}/.well-known/adagents.json`
2. **Declare MCP endpoint** in the agent card extension
3. **Declare A2A endpoint** in the standard agent card section

**Example agent card at** `https://youragent.com/.well-known/adagents.json`:

```json
{
  "agents": [
    {
      "agent_url": "https://youragent.com",
      "agent_name": "Your Creative Agent",
      "protocols": ["mcp", "a2a"],
      "mcp_endpoint": "https://youragent.com/mcp",
      "a2a_endpoint": "https://youragent.com/a2a",
      "capabilities": ["list_creative_formats", "preview_creative"]
    }
  ]
}
```

This ensures the domain in the namespace is a valid, discoverable agent that can provide format specifications and validation.

### When to Use Namespaces

**Always use namespaced format_ids** when defining formats:

```json
{
  "formats": [
    {
      "format_id": "youragent.com:homepage_takeover",
      "agent_url": "https://youragent.com",
      "name": "Homepage Takeover",
      "type": "rich_media"
    }
  ]
}
```

**Benefits:**
- **No collisions** - Each agent owns its namespace
- **Clear ownership** - Domain identifies the authoritative agent
- **Discoverable** - Buyers can query the domain's agent card
- **Verifiable** - Domain must prove ownership via agent card

### Namespace Examples by Agent Type

**Reference Creative Agent:**
```json
{
  "format_id": "creative.adcontextprotocol.org:display_300x250",
  "agent_url": "https://creative.adcontextprotocol.org"
}
```

**Publisher Sales Agent:**
```json
{
  "format_id": "youragent.com:custom_format",
  "agent_url": "https://youragent.com"
}
```

**DCO Platform:**
```json
{
  "format_id": "dco.example:dynamic_creative_v2",
  "agent_url": "https://dco.example"
}
```

### Conflict Resolution

With namespaced format_ids, conflicts **cannot occur** - each domain controls its own namespace.

**No conflict:**
```json
// Two different formats, both valid
{
  "format_id": "publisher-a.com:video_30s",
  "agent_url": "https://publisher-a.com"
}
{
  "format_id": "publisher-b.com:video_30s",
  "agent_url": "https://publisher-b.com"
}
```

If a buyer encounters the same namespaced format_id from multiple sources, they are **the same format** - the namespace guarantees identity.

### Validation Rules

1. **Domain MUST match agent_url domain:**
   ```json
   // ✅ Valid - domain matches
   {
     "format_id": "youragent.com:format_x",
     "agent_url": "https://youragent.com"
   }

   // ❌ Invalid - domain mismatch
   {
     "format_id": "otheragent.com:format_x",
     "agent_url": "https://youragent.com"
   }
   ```

2. **Domain MUST have valid agent card:**
   - Agent card must exist at `{domain}/.well-known/adagents.json`
   - Must declare MCP and/or A2A endpoints
   - Endpoints must be functional

3. **Format_id MUST follow pattern:**
   - `{domain}:{format_id}` structure
   - Domain is valid DNS hostname
   - Format_id is alphanumeric with underscores/hyphens

### Migration from Unnamespaced IDs

If you previously used simple IDs like `display_300x250`, migrate to namespaced versions:

**Before:**
```json
{
  "format_id": "display_300x250",
  "agent_url": "https://youragent.com"
}
```

**After:**
```json
{
  "format_id": "youragent.com:display_300x250",
  "agent_url": "https://youragent.com"
}
```

Support both during transition if needed, but new implementations should use namespaced IDs from the start.

## Reference Agent as Format Authority

Each format includes an `agent_url` field indicating its authoritative source:

```json
{
  "format_id": "creative.adcontextprotocol.org:display_300x250",
  "agent_url": "https://creative.adcontextprotocol.org",
  "name": "Medium Rectangle",
  "type": "display"
}
```

The creative agent at that URL is the definitive source for:
- Complete format specifications
- Asset requirements and validation rules
- Preview generation
- Rendering instructions

## When NOT to Use Standard Formats

Define your own formats when:

1. **Unique technical requirements** - Your platform needs different specs than IAB standards
2. **Custom validation** - You require additional creative review or approval
3. **Proprietary assembly** - Your rendering pipeline has special requirements
4. **Premium experiences** - Differentiated ad products not covered by standard formats

Even in these cases, you can reference standard formats for basic inventory while defining custom formats for premium placements.

## Implementation Notes

### Format Authority Pattern

The `agent_url` field enables a **distributed format authority** model:
- Reference agent is authoritative for IAB standards
- Each publisher is authoritative for their custom formats
- Buyers can discover and validate against the correct authority

### Version Management

The reference creative agent maintains format versions and compatibility:
- Format definitions evolve with industry standards
- Backward compatibility is maintained
- Buyers can rely on stable format_id values

### What Makes a Format "Standard"

**Standard formats** are those defined by the reference creative agent at `https://creative.adcontextprotocol.org` based on:

1. **Industry specifications** - IAB standards, VAST/VPAID specs, common ad unit sizes
2. **Cross-platform compatibility** - Work across multiple publishers without customization
3. **Stable definitions** - Versioned and maintained for consistency across the ecosystem

**Protocol perspective:** At the protocol level, standard formats are just formats like any other - there's no special API treatment. The `agent_url` field identifies the reference agent as the authoritative source, just as it would for any custom format.

**Ecosystem perspective:** Standard formats enable portability. A buyer can build one creative and use it across many publishers who reference the same format definitions.

## Related Documentation

- [Creative Protocol Overview](../../creative/index.md) - How formats, manifests, and agents work together
- [Creative Formats](../../creative/formats.md) - Understanding format specifications and discovery
- [Channel Guides](../../creative/channels/video.md) - Detailed format documentation by media type
- [list_creative_formats Task](../task-reference/list_creative_formats.md) - API reference for format discovery
