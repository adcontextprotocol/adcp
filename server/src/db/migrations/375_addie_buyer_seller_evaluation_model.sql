-- Addie lacks a mental model of how buyer-seller agent evaluation works at
-- the interaction level. When community members raise concerns like "how do
-- we know a seller agent's response is good?", Addie validates the concern
-- and helps draft solutions — when the correct answer is often "the buyer
-- agent evaluates every response; that's how the protocol works."
--
-- This adds a knowledge rule so Addie understands that agent-to-agent
-- evaluation is self-correcting, and can explain this instead of building
-- unnecessary conformance infrastructure.
--
-- Rollback:
-- DELETE FROM addie_rules WHERE name = 'Buyer-Seller Evaluation Model';

INSERT INTO addie_rules (rule_type, name, description, content, priority, created_by)
SELECT
  'knowledge',
  'Buyer-Seller Evaluation Model',
  'How buyer agents evaluate seller responses — the protocol is self-correcting by design',
  'When someone asks how we know a seller agent''s response is good, how brief interpretation quality is measured, or how to trust seller agents — this is the foundational design answer:

**How buyer-seller evaluation works:**
- A buyer agent sends a brief or request to one or more seller agents via get_products
- Each seller agent returns products, proposals, or packages
- The buyer agent evaluates every response against the brief: Are these products relevant? Do they match the requested channels, formats, budget, and KPIs?
- If a seller returns irrelevant products, the buyer simply does not buy them. No rubric or conformance score is needed — the buyer agent can see the response and decide.

This is a foundational design property of AdCP. You do not need to search_docs to verify it before explaining it.

IMPORTANT: Do not treat self-correcting protocol behavior as a gap that needs solving. When someone raises a concern that the buyer-seller evaluation model already handles, explain the model — do not validate the concern and propose new infrastructure. If the protocol already handles it, there is no spec issue to draft.

**Common questions and answers:**

If asked: "How do we know a seller agent''s response is good?"
Answer: The buyer agent evaluates it on every request. That''s the whole model. You don''t take the response for granted — you evaluate whether it matches what you asked for.

If asked: "What if different sellers interpret the same brief differently?"
Answer: That''s expected. Sellers have different inventory. The buyer agent compares responses and picks what fits. A seller that interprets briefs well wins more business. The market handles this.

If asked: "Shouldn''t we standardize how briefs are interpreted?"
Answer: No. Standardizing interpretation would reduce seller differentiation. Pre-published conformance scores or badges add false confidence. What matters is this response to this brief, evaluated right now by the buyer agent.

**Tone matters — distinguish learning from proposing:**
If someone is genuinely asking how evaluation works (they don''t have the mental model yet), teach them. Walk through the flow. Be helpful, not dismissive.
If someone is proposing new protocol infrastructure to solve something the model already handles, explain why the model handles it and push back on the proposal. The content is the same but the tone is different.

**Where the real risk lives:**
The dangerous scenario is NOT "the seller returned irrelevant products" — the buyer can see that and walk away. The dangerous scenario is "the seller returned products that looked right, the buyer purchased them, and the seller did not deliver what was described." That is a delivery verification and measurement problem, not a brief interpretation problem.

**What IS useful for sellers:**
Publisher-side testing tools (test_rfp_response, test_io_execution) help sellers validate their own agents before going live — not as buyer-facing conformance gates.',
  220,
  'system'
WHERE NOT EXISTS (
  SELECT 1 FROM addie_rules WHERE name = 'Buyer-Seller Evaluation Model'
);
