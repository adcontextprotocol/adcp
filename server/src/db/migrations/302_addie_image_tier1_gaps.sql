-- Tier 1 illustration gap fill: brand identity, MCP architecture, SI sessions, agent trust
-- These are the highest-priority topics taught in certification with zero image coverage.
-- All images use the Sage (teal) theme.

INSERT INTO addie_images (filename, alt_text, topics, category, characters, description, image_url)
VALUES
  -- Brand Identity Protocol (C2)
  ('brand-identity-01-brand-json.png',
   'Sage presents a holographic brand.json document showing brand identity structure',
   ARRAY['brand-identity', 'brand-json', 'brand-safety', 'compliance', 'protocol-overview'],
   'scene',
   ARRAY['sage'],
   'Sage presents a holographic projection of a brand.json document with visible sections: brand name, color palette, logo, content standards checklist, and approved categories. The document glows with teal energy as Sage gestures like a teacher presenting a blueprint.',
   'https://docs.adcontextprotocol.org/images/concepts/brand-identity-01-brand-json.png'),

  ('brand-identity-02-validation.png',
   'A brand agent robot validates creative ads against brand.json — approved get checkmarks, violations get flagged',
   ARRAY['brand-identity', 'brand-safety', 'compliance', 'creative', 'governance'],
   'scene',
   ARRAY[]::text[],
   'A teal brand agent robot examines creative ad mockups on a conveyor belt using a magnifying glass. Approved creatives move to a validated zone with teal checkmarks. One creative glows red indicating a brand safety violation. The agent holds a brand.json card for reference.',
   'https://docs.adcontextprotocol.org/images/concepts/brand-identity-02-validation.png'),

  ('brand-identity-03-standards-cascade.png',
   'Brand standards cascade from master brand identity down to governance plans, creative manifests, and content policies',
   ARRAY['brand-identity', 'brand-safety', 'campaign-governance', 'creative', 'compliance'],
   'diagram',
   ARRAY[]::text[],
   'A cascade diagram showing brand standards flowing from a master brand shield at the top down to three contexts: campaign governance plan, creative manifest, and publisher content policy. Each inherits brand constraints while adding its own specifics.',
   'https://docs.adcontextprotocol.org/images/concepts/brand-identity-03-standards-cascade.png'),

  -- MCP Server Architecture (D1)
  ('mcp-01-architecture.png',
   'MCP server architecture with three layers — transport, protocol, and tools — with clients and backends',
   ARRAY['architecture', 'mcp', 'protocol-overview', 'multi-agent'],
   'diagram',
   ARRAY['sage'],
   'Clean architectural diagram of an MCP server with three horizontal layers: transport (HTTP/SSE) at bottom, protocol (message envelopes) in middle, and tools (search, create, list, update, validate, discover) at top. Client robots on left, database and API on right. Sage points at the layers.',
   'https://docs.adcontextprotocol.org/images/concepts/mcp-01-architecture.png'),

  ('mcp-02-tool-registration.png',
   'Sage assembles MCP tools on a workbench — six tool cards being wired into a central server hub',
   ARRAY['architecture', 'mcp', 'protocol-overview', 'tool-registration'],
   'scene',
   ARRAY['sage'],
   'Sage assembles and registers MCP tools at a workbench. Six tool cards with distinct icons (search, create, list, update, validate, discover) are being registered and connected to a central server hub with glowing teal wires. Each connection lights up when complete.',
   'https://docs.adcontextprotocol.org/images/concepts/mcp-02-tool-registration.png'),

  ('mcp-03-transport.png',
   'Two transport modes compared — HTTP request/response and SSE streaming — with Sage comparing them',
   ARRAY['architecture', 'mcp', 'protocol-overview'],
   'diagram',
   ARRAY['sage'],
   'Side-by-side comparison of MCP transports. Left: simple HTTP request/response arrows between client and server. Right: persistent SSE channel (glowing teal tunnel) with multiple event arrows streaming back. Sage stands between panels gesturing to compare.',
   'https://docs.adcontextprotocol.org/images/concepts/mcp-03-transport.png'),

  -- Sponsored Intelligence Sessions (S5)
  ('si-01-session-initiation.png',
   'A reader encounters a Sponsored Intelligence invitation within content — Sage offers a conversational experience',
   ARRAY['sponsored-intelligence', 'conversational-ads', 'session-lifecycle'],
   'scene',
   ARRAY['sage'],
   'A person views a content article on their device. Within the article, a teal chat bubble appears as a Sponsored Intelligence conversational ad invitation. Sage peeks out waving in a friendly greeting. The person looks curious. Non-intrusive, opt-in moment.',
   'https://docs.adcontextprotocol.org/images/concepts/si-01-session-initiation.png'),

  ('si-02-conversation.png',
   'Active SI session — a person chats with a brand agent while product cards float in conversation',
   ARRAY['sponsored-intelligence', 'conversational-ads', 'session-lifecycle', 'product-discovery'],
   'scene',
   ARRAY['sage'],
   'An active Sponsored Intelligence conversational ad session. A person converses with a brand agent (small teal robot with brand badge). Product cards, comparison charts, and recommendations float in the conversation. Sage observes from the side ensuring quality standards.',
   'https://docs.adcontextprotocol.org/images/concepts/si-02-conversation.png'),

  ('si-03-commerce-handoff.png',
   'SI session concludes with commerce handoff — action button, consent receipt generated, brand agent waves goodbye',
   ARRAY['sponsored-intelligence', 'conversational-ads', 'session-lifecycle', 'commerce', 'consent', 'measurement'],
   'scene',
   ARRAY['sage'],
   'The conclusion of an SI conversational ad session. The person taps a teal action button. A handoff arrow connects to a commerce destination. A consent receipt document is generated. The brand agent waves goodbye. Sage gives a thumbs up.',
   'https://docs.adcontextprotocol.org/images/concepts/si-03-commerce-handoff.png'),

  -- Agent Trust / adagents.json (D2)
  ('agent-trust-01-adagents.png',
   'Publisher storefront with agent trust — doorkeeper checks arriving agents against a registry',
   ARRAY['agent-trust', 'adagents', 'adagents-json', 'architecture', 'publisher'],
   'scene',
   ARRAY['sage'],
   'A publisher website shown as a storefront where the publisher controls which agents can access inventory. Three robots approach, each with an identity card. A doorkeeper robot checks each against a registry. One is welcomed (teal checkmark), one is questioned (yellow caution), one is blocked (red X). Agent authorization at the publisher boundary.',
   'https://docs.adcontextprotocol.org/images/concepts/agent-trust-01-adagents.png'),

  ('agent-trust-02-discovery.png',
   'Agent discovery — buyer agents navigate toward a lighthouse (adagents.json endpoint) with Sage guiding',
   ARRAY['agent-trust', 'adagents', 'adagents-json', 'architecture', 'publisher'],
   'scene',
   ARRAY['sage'],
   'A lighthouse emits teal beams at center. Multiple buyer agent robots navigate toward it from different directions. The lighthouse represents the adagents.json discovery endpoint where publishers declare their agents. Arriving agents receive capability cards. Sage stands atop the lighthouse.',
   'https://docs.adcontextprotocol.org/images/concepts/agent-trust-02-discovery.png'),

  ('agent-trust-03-authorization-chain.png',
   'Authorization chain — publisher authorizes operators who authorize buyer agents with teal chain links',
   ARRAY['agent-trust', 'adagents', 'architecture', 'governance'],
   'diagram',
   ARRAY[]::text[],
   'Chain of trust diagram. Publisher robot holds a master key at top. Three levels cascade: publisher authorizes operator (middle), operator authorizes buyer agents (bottom row). Each authorization shown as teal chain links. One path shows direct publisher-to-buyer authorization.',
   'https://docs.adcontextprotocol.org/images/concepts/agent-trust-03-authorization-chain.png')
ON CONFLICT (filename) DO NOTHING;
