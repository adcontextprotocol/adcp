---
"adcontextprotocol": minor
---

Add VAST 4.4 to the VAST version enum. IAB already hosts `vast_4.4.xsd` and CTV tags already declare `version="4.4"`, so a manifest that tells the truth about those documents currently fails validation. The 4.4 XSD is still annotated DRAFT for working group discussion; this change accepts the version attribute, it does not claim IAB has published a final specification.
