# Client-only signer bootstrap vectors

Resolver-level vectors for [Client-only signers](https://adcontextprotocol.org/docs/building/by-layer/L1/security#client-only-signers-no-capabilities-endpoint) in `docs/building/by-layer/L1/security.mdx`.

A client-only signer is a buyer that only calls sellers. It serves no `get_adcp_capabilities`, so the verifier cannot start the discovery chain at step 1. The seller starts from its onboarding record for the authenticated principal instead.

## What these vectors cover

`vectors.json` holds fixture `documents` (brand.json by URL), fixture `jwks` (the `kid` values each JWKS URL publishes), and `vectors[]`. Each record names the `jwks_uri` the seller recorded at onboarding. Each vector gives the seller's `onboarding_record`, the `request` as the verifier sees it after independent authentication, and the `expected` outcome.

- `accept` vectors name the canonical `agent_url` the verifier retains as the signed-Agent identity. A vector's `must_not_fetch` lists URLs the verifier must not request.
- `reject` vectors name one `request_signature_*` code from `request-signing-error-code.json`. `negative-008` also names `not_code`: a seller that runs step 1 against a client-only signer gets `request_signature_capabilities_unreachable`, never `request_signature_brand_json_url_missing`. `negative-012` is its control: a callable agent that answers capabilities without `identity.brand_json_url` does get the second code. The `capabilities_endpoints` map lists the agent URLs that answer capabilities; any other URL is unreachable.

## What they do not cover

They carry no signatures, so they do not replace [`request-signing/`](https://adcontextprotocol.org/compliance/latest/test-vectors/request-signing/). They also do not cover live fetches, redirects, size caps, House Portfolio documents (the reference resolver reads their agent collections but no vector uses one), or the PSL. Hosts end in `.example`, and the reference resolver in `tests/client-only-signer-bootstrap-vectors.test.cjs` takes the last two labels as the eTLD+1. A production verifier uses the pinned PSL snapshot from the security specification.

## Running

```bash
node --test tests/client-only-signer-bootstrap-vectors.test.cjs
```
