-- Seed adcontextprotocol.org as a discovered sub-brand of agenticadvertising.org.
-- This makes the brand viewer work for adcontextprotocol.org and ensures
-- the agenticadvertising.org brand card shows the correct sub-brand count.
INSERT INTO discovered_brands (
  domain,
  brand_name,
  source_type,
  has_brand_manifest,
  keller_type,
  house_domain,
  brand_manifest,
  review_status
) VALUES (
  'adcontextprotocol.org',
  'AdCP',
  'enriched',
  true,
  'sub_brand',
  'agenticadvertising.org',
  '{
    "id": "adcp",
    "names": [
      { "en": "AdCP" },
      { "en": "Advertising Context Protocol" },
      { "en": "Ad Context Protocol" }
    ],
    "description": "Open standard for AI-powered advertising workflows built on Model Context Protocol (MCP)",
    "industry": "advertising_technology",
    "target_audience": "Ad tech developers, platform providers, and media buyers implementing agentic advertising",
    "logos": [
      {
        "url": "https://adcontextprotocol.org/adcp_logo.svg",
        "tags": ["icon", "square", "light-bg"],
        "width": 204,
        "height": 204
      }
    ],
    "colors": {
      "primary": "#1a36b4",
      "secondary": "#2d4fd6",
      "accent": "#a4c2f4",
      "background": "#FFFFFF",
      "text": "#1d1d1d"
    },
    "fonts": {
      "primary": "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    },
    "tone": {
      "voice": "Technical and precise, empowering developers to build the next generation of advertising",
      "attributes": ["technical", "precise", "developer-friendly", "clear", "innovative"]
    },
    "tagline": "The Open Standard for Agentic Advertising"
  }',
  'approved'
)
ON CONFLICT (domain) DO NOTHING;
