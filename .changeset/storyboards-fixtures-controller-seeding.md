---
---

storyboards: add `fixtures:` blocks + `prerequisites.controller_seeding: true` to the five storyboards that reference fixture IDs no prior step creates (governance-spend-authority, media-buy/governance escalation, creative-ad-server, sales-non-guaranteed, governance-delivery-monitor). Agents that implement `comply_test_controller.seed_*` have the fixtures auto-seeded before phases run; agents without seed support grade these storyboards `not_applicable` rather than failed. Tracks #2743, companion to adcp#2742.
