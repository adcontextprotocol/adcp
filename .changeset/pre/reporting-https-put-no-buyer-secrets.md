---
"adcontextprotocol": minor
---

spec(reporting): `https_put` file transfer and no buyer secrets for reporting delivery (experimental, #8149).

Reliable Reporting managed delivery (`media_buy.reporting_delivery`, experimental):

- **No buyer secrets.** For every managed pattern the seller authenticates as itself, through its advertised `producer_identity`. A seller MUST NOT hold, request, or store a caller-issued secret of any kind (password, API key, bearer token, OAuth client secret, private key, signed URL, or shared signing key), directly or through a processor acting for it, and a seller that does is non-conformant. The deprecated `reporting_webhook.authentication` block is not precedent. Stated in `core/reporting-write-destination.json`, `core/agent-reporting-destination.json`, `core/reporting-delivery-method.json`, `get_reporting_status`, and `sync_principal`.
- **Row push is `reporting_webhook`.** Rows in an HTTP request body are the Core `reporting_webhook` transport, never `file_transfer`: it has no destination, manifest, materialization, or receipt.
- **`https_put` (experimental in 3.3).** A new open `file_transfer` transport token for writing immutable objects and a manifest to a buyer HTTPS endpoint. It is conformant only when the manifest is written last, every request is signed by the seller under the Web Bot Auth profile with keys from its origin's key directory, and the endpoint passes a signed probe before `ready`. The probe carries the seller-issued `destination_ref`, and the endpoint echoes its nonce only after recognizing that reference. A write-only endpoint is allowed, with the signed probe in place of the read-back (`proof_file_transfer`, `enums/reporting-destination-setup-state.json`). `producer_identity` for `https_put` names the seller agent's signing origin. `transport` is already an open string, so no enum or shape changes.
