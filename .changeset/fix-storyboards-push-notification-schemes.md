---
---

fix(storyboards): use `schemes` (array) + `credentials` in push_notification_config.authentication

The base `media_buy_seller` storyboard and two specialisms (`sales-guaranteed`, `creative-generative/seller`) declared the deprecated singular `scheme` field inside `push_notification_config.authentication`. The spec schema (`/schemas/core/push-notification-config.json`) requires `schemes` (array) and `credentials`, and conformant agents using `@adcp/client` 5.9.0+ reject the malformed shape at client-side validation.

Align all three with `sales-broadcast-tv` (already correct) and drop the three grandfathered entries from the sample-request schema allowlist now that the drift is fixed.

Closes #2770.
