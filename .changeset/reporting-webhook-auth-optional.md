---
"adcontextprotocol": minor
---

`reporting_webhook.authentication` and `create_media_buy.artifact_webhook.authentication` are no longer in `required[]` (#8176), so a 3.3 integration can be fully HMAC-free before 4.0.

- **Version gate:** the block is required on a request served below 3.3, including a 3.3 seller serving a buyer pinned to 3.2.
- **Absent block:** the seller signs every delivery under the profile the registration's `signing_profile` selects (`adcp/webhook-signing/v1` when it is omitted), as for `push_notification_config`.
- **One list of webhook registrations:** `security.mdx` §Webhook callbacks now defines the list, including `reporting_webhook` and `artifact_webhook`, and the page's legacy-HMAC, switch, and downgrade rules refer to it. The downgrade and injection rules cover the two new entries on requests served at 3.3 or later.
- **`token`:** both descriptions now match the push rule: the seller echoes it verbatim, and it never substitutes for verifying the delivery's signature.

Sending the block stays valid throughout 3.x, and #4288 still owns its 4.0 removal. The 3.2→3.3 migration guide, the reporting docs, and the `update_media_buy` reference are updated.
