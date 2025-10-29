# Standard Formats - Reference Documentation

## Purpose

These schemas are **reference documentation** showing the format specifications provided by the AdCP Reference Creative Agent at `https://creative.adcontextprotocol.org`.

## For Implementers

**DO NOT** use these schemas directly as if they are the source of truth. Instead:

1. **Sales agents**: Reference `https://creative.adcontextprotocol.org` in your `list_creative_formats` response
2. **Buyers**: Query the reference creative agent directly via `list_creative_formats` to get current format definitions
3. **Everyone**: Treat the reference creative agent URL as the authoritative source, not these local JSON files

## What's in Here

These schemas document what the reference creative agent provides:
- **Display formats**: IAB standard banner sizes (300x250, 728x90, etc.)
- **Video formats**: Standard video specifications (15s, 30s, vertical, etc.)
- **Native formats**: Responsive native ad formats
- **DOOH formats**: Digital out-of-home specifications
- **Carousel formats**: Multi-product and slideshow formats

## Why Are These Here?

These schemas serve as:
- **Documentation**: Help developers understand what standard formats look like
- **Reference**: Show the structure and requirements of IAB standard formats
- **Examples**: Illustrate best practices for format definitions

## The Reference Creative Agent

The AdCP Reference Creative Agent (`https://creative.adcontextprotocol.org`) is a production service that:
- Hosts authoritative definitions for all IAB standard formats
- Validates creatives against format specifications
- Generates previews for standard formats
- Provides a stable, maintained reference implementation

Sales agents should reference this URL rather than replicating format definitions. See [Implementing Standard Format Support](https://docs.adcontextprotocol.org/docs/media-buy/capability-discovery/implementing-standard-formats) for guidance.

## Keeping in Sync

These reference schemas may lag behind the production creative agent. When in doubt, query `https://creative.adcontextprotocol.org` directly using the `list_creative_formats` task for the most current specifications.
