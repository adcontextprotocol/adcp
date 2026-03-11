-- Rebalance A3 assessment dimensions: increase synthesis weight from 15% to 25%
-- and reduce breadth from 35% to 25%. Synthesis (connecting concepts across domains)
-- is the higher-order skill that A3 should emphasize. Breadth is still important but
-- was over-weighted relative to the depth of understanding synthesis measures.

UPDATE certification_modules SET
  assessment_criteria = '{
    "dimensions": [
      {"name": "breadth", "weight": 25, "description": "Awareness of all protocol domains", "scoring_guide": {"high": "Can describe all 8 domains and name key tasks in each", "medium": "Knows most domains but fuzzy on some", "low": "Only aware of media buy basics"}},
      {"name": "discovery_mechanisms", "weight": 25, "description": "Understands brand.json, adagents.json, community registry", "scoring_guide": {"high": "Can explain all three discovery mechanisms and why they matter", "medium": "Knows about one or two", "low": "Unaware of discovery infrastructure"}},
      {"name": "key_concepts", "weight": 25, "description": "Grasps format vs manifest, billing models, Oracle model", "scoring_guide": {"high": "Can explain each concept clearly", "medium": "Understands some", "low": "Confused about key distinctions"}},
      {"name": "synthesis", "weight": 25, "description": "Can connect concepts across domains without prompting", "scoring_guide": {"high": "Independently draws connections between domains (e.g. how governance affects media buy, how signals feed creative)", "medium": "Makes connections when prompted", "low": "Treats each domain as isolated"}}
    ],
    "passing_threshold": 70
  }'
WHERE id = 'A3';
