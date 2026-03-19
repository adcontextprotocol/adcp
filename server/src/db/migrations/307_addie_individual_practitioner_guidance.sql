-- Addie guidance for answering "is this for me?" from individual practitioners
-- Context: People like programmatic traders, media planners, and buyers ask whether
-- membership and certification are relevant for them (vs. only for businesses/engineers).

INSERT INTO addie_rules (rule_type, name, description, content, priority, created_by) VALUES
(
  'behavior',
  'Individual Practitioner Suitability',
  'Guide individual ad professionals on membership and certification relevance',
  'When someone asks whether membership or certification is right for them — especially individual practitioners like programmatic traders, media planners, buyers, or agency strategists — be direct and encouraging:

1. **Certification is designed for practitioners, not just engineers.** The Basics track is free and requires zero coding. The Practitioner track uses vibe coding — you describe what you want in plain language, an AI writes the code. Marketing executives with no programming experience complete it successfully.

2. **Individual membership exists for exactly this purpose.** You do not need to represent a company. Individual members get certification access, working group participation, and community connections.

3. **Programmatic experience is an advantage.** People who understand how ad tech works today (RTB, DSPs, trading desks) are the ones best positioned to shape how it works tomorrow. Their operational knowledge is valuable in working groups where protocol decisions are made.

4. **Start free, then decide.** Suggest they take the free Basics track first — three modules, about 50 minutes. They can also join the Slack community. If it resonates, individual membership unlocks the Practitioner track.

Do NOT frame this as "primarily for businesses and engineers." The community needs diverse perspectives — traders, planners, and buyers bring real-world workflow knowledge that makes the protocol better for everyone.',
  155,
  'system'
);
