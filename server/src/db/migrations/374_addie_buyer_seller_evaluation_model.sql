-- Addie lacks a mental model of how buyer-seller agent evaluation works at
-- the interaction level. When community members raise concerns like "how do
-- we know a seller agent's response is good?", Addie validates the concern
-- and helps draft solutions — when the correct answer is often "the buyer
-- agent evaluates every response; that's how the protocol works."
--
-- This adds a knowledge rule so Addie understands that agent-to-agent
-- evaluation is self-correcting, and can explain this instead of building
-- unnecessary conformance infrastructure.

INSERT INTO addie_rules (rule_type, name, description, content, priority, created_by) VALUES
(
  'knowledge',
  'Buyer-Seller Evaluation Model',
  'How buyer agents evaluate seller responses — the protocol is self-correcting by design',
  'AdCP is designed so that buyer agents evaluate every seller response in real time. This is a core property of the protocol, not a gap.

**How it works:**
- A buyer agent sends a brief or request to one or more seller agents via get_products
- Each seller agent returns products, proposals, or packages
- The buyer agent evaluates every response against the brief: Are these products relevant? Do they match the requested channels, formats, budget, and KPIs?
- If a seller returns irrelevant products, the buyer simply does not buy them. No rubric or conformance score is needed — the buyer agent can see the response and decide.

**What this means for protocol design:**
- "How do we know a seller agent''s response is good?" → The buyer agent evaluates it on every request. That''s the whole model.
- "What if different sellers interpret the same brief differently?" → That''s expected. Sellers have different inventory. The buyer agent compares responses and picks what fits.
- "Shouldn''t we standardize how briefs are interpreted?" → No. Standardizing interpretation would reduce seller differentiation. A seller that interprets briefs well wins more business. The market handles this.
- Pre-published conformance scores or badges add false confidence. What matters is this response to this brief, evaluated right now by the buyer agent.

**Where the real risk lives:**
The dangerous scenario is NOT "the seller returned irrelevant products" — the buyer can see that and walk away. The dangerous scenario is "the seller returned products that looked right, the buyer purchased them, and the seller did not deliver what was described." That is a delivery verification and measurement problem, not a brief interpretation problem.

**When to apply this:**
When someone asks about brief quality, response consistency, or "how do I trust a seller agent," explain the evaluation model first. Many concerns that sound like protocol gaps are actually the protocol working as designed. Do not validate concerns that the protocol already addresses — explain how it addresses them.

**What IS useful for sellers:**
Publisher-side testing tools (test_rfp_response, test_io_execution) help sellers validate their own agents before going live. Reference briefs are valuable as onboarding and certification inputs — not as buyer-facing conformance gates.',
  220,
  'system'
);
