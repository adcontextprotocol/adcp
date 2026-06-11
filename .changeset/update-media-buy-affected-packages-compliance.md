---
---

test(compliance): require update_media_buy affected package state

Tightens media-buy storyboards so successful update_media_buy calls that mutate
existing packages[] must return affected_packages with package identity and
scenario-critical post-update state. Responses that omit affected_packages or
return package IDs only now fail compliance on the exercised paths.

Adds a storyboard lint to keep future existing-package update_media_buy steps
from regressing to ID-only affected_packages assertions, and clarifies the
update_media_buy response docs/schema descriptions with full-state examples.
