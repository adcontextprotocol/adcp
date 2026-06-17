---
---

docs(media-buy): document the `account` field in the create_media_buy response

The `create_media_buy` success response has carried an `account` field (full `Account`, including the canonical `account_id`) since 3.0.1, but the task-reference page documented `account` only as a request parameter. The response field table and the success/webhook-completion examples omitted it, so readers could not see that the seller echoes back the resolved account — including, for implicit `brand` + `operator` resolution, the `account_id` a buyer can reference on later account-scoped calls. Add `account` to the Success Response field table and to the success and approved-webhook example payloads.
