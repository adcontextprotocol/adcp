---
"adcontextprotocol": patch
---

Grade creative-asset fixture coverage gaps as `not_applicable` with the new
canonical `fixture_unavailable` skip reason instead of failing the seller,
require explicit text-slot mappings, and add common image fixtures for 970x250,
300x600, 336x280, and 1080x1920 formats. Storyboards that previously stopped on
a missing common-size fixture can now execute and produce real behavioral
signal; valid formats the runner still cannot synthesize no longer count
against the agent under test.
