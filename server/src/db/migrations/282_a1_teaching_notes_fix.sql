-- Fix A1 teaching notes: don't attempt live demo on the very first turn.
-- When the sandbox agent is slow or unreachable, the learner's first experience
-- is a failure message. Instead, greet the learner and ask about their background
-- first, then run the demo on turn 2-3.

UPDATE certification_modules SET
  lesson_plan = '{
    "objectives": [
      "Explain the difference between agentic and traditional programmatic advertising",
      "Understand AdCP covers 19 channels including linear TV, radio, print, and DOOH — not just digital",
      "Query a live agent and interpret the response",
      "Articulate why a shared protocol matters for AI-powered advertising"
    ],
    "key_concepts": [
      {"topic": "Agentic vs traditional programmatic", "teaching_notes": "First, learn about the learner — what they work on, what they know about programmatic. Then query @cptestagent using get_products to show the paradigm shift — goal-driven agents vs rigid APIs. Let the protocol speak for itself before lecturing."},
      {"topic": "Not just digital", "teaching_notes": "AdCP covers 19 channels: display, social, search, CTV, linear TV, AM/FM radio, podcast, streaming audio, DOOH, OOH, print, cinema, email, gaming, retail media, influencer, affiliate, product placement. Can you buy local radio? Yes. Broadcast syndication? Yes. The same protocol buys a TikTok ad and a local news spot."},
      {"topic": "AI agents in advertising", "teaching_notes": "An agent perceives, decides, and acts autonomously. In advertising, agents discover inventory, negotiate pricing, manage creatives, and optimize campaigns. Use the live @cptestagent interaction to ground this — the learner just talked to an agent."},
      {"topic": "The protocol hierarchy", "teaching_notes": "AdCP is built on MCP (Model Context Protocol). MCP handles transport. AdCP adds the advertising domain. Multiple transports work: MCP and A2A. Keep this brief — the point is that AdCP works across different connection methods."}
    ],
    "demo_scenarios": [
      {"description": "Query @cptestagent for available products", "tools": ["get_products"], "expected_outcome": "See products with pricing, targeting options, and format support — a real agent response, not a slide deck"}
    ]
  }'
WHERE id = 'A1';
