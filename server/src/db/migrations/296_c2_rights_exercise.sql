-- Add rights discovery exercise to C2
-- This uses jsonb_set to append to the existing exercise_definitions array
UPDATE certification_modules SET exercise_definitions = exercise_definitions || '[
  {
    "id": "c2_ex3",
    "title": "Rights discovery and acquisition",
    "description": "Your client runs a steakhouse in Amsterdam and wants a Dutch athlete in their next campaign. Walk through how you would use get_rights to find available talent, evaluate the pricing options, and decide whether to proceed with acquire_rights. Consider: What query would you use? How would you evaluate the match results? What restrictions should you watch for? What budget makes sense for a local restaurant?",
    "sandbox_actions": [
      {"tool": "sandbox_get_rights", "guidance": "Search for Dutch athletes available for food brands in the Netherlands. Evaluate the match results — pricing, restrictions, exclusions."},
      {"tool": "sandbox_get_brand_identity", "guidance": "Look up a matched talent''s brand identity to understand their public profile and what authorized fields are available."},
      {"tool": "sandbox_acquire_rights", "guidance": "Try acquiring Pieter van Dijk for your steakhouse campaign. Compare this rejection (no suggestions — final) with what happens when you try Daan Janssen for a sportswear campaign (suggestions included — actionable). What does the presence of suggestions tell you about what to do next?"},
      {"tool": "sandbox_acquire_rights", "guidance": "Submit a rights acquisition request for the selected talent. Review the generation credentials and rights constraints returned."},
      {"tool": "sandbox_update_rights", "guidance": "Extend the rights grant end date to 2026-09-30 and increase the impression cap. Review the re-issued generation credentials and updated rights constraint."}
    ],
    "success_criteria": [
      "Can construct an effective natural-language rights query with appropriate filters (uses, geography, budget)",
      "Evaluates pricing options by comparing CPM vs flat rate for the campaign size",
      "Identifies relevant restrictions and exclusions in the rights response",
      "Understands the acquire_rights flow: request, pending_approval, credential issuance",
      "Can explain how generation credentials connect to creative production"
    ]
  }
]'::jsonb WHERE id = 'C2';
