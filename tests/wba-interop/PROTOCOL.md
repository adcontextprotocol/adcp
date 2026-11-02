# Web Bot Auth interop adapter protocol

An adapter connects one Web Bot Auth (WBA) implementation to the harness in this
directory. The harness grades the implementation against one judge: Cloudflare's
`web-bot-auth` and `http-message-sig` libraries at the versions pinned in
`package.json`, with the AdCP profile's rules from `policy.mjs`.

An adapter is one executable. For each operation, the harness starts the
executable, writes one JSON object to its standard input, and reads one JSON
object from its standard output. The harness passes the command to a shell, so
the command can carry arguments.

```bash
node tests/wba-interop/run.mjs --adapter "go run ./internal/wbainterop" --junit wba-interop.xml
```

## Shared shapes

The operations use the following shapes:

- **Request**: `{ "method", "url", "headers", "body" }`. `headers` is an object of
  field name to field value; names are case-insensitive. `body` is the exact byte
  string on the wire, empty for a request with no body.
- **Directory response**: `{ "url", "status", "headers", "body" }`, the signed
  response a key directory server sends for
  `<origin>/.well-known/http-message-signatures-directory`.
- **Key**: a private JWK, `{ "kty": "OKP", "crv": "Ed25519", "x", "d" }`. Every key
  is a published test key from `keys.json`, which a production verifier SHOULD
  reject (WBA section 6.8). An adapter configures its implementation to accept
  them. For the same reason, the judge does not apply the profile's rule to
  reject published test keys: `checkNotTestKey` in `policy.mjs` holds the rule,
  and the harness passes it no keys.
- **Time**: `now` is Unix seconds. The adapter uses it as the clock for signing and
  verification, never the system clock.
- **Refusal**: `{ "ok": false, "status", "rule", "error" }`. `status` is the HTTP
  status the implementation answers (`400`, `403`, or `429`). `rule` and `error`
  are free text that the report shows. An adapter writes a refusal only for the
  implementation's own verification refusals.
- **Crash**: any other error crashes the adapter. The adapter exits 0 after it
  writes its output; a nonzero exit, a signal, output that is not one JSON object,
  or the rule `adapter-crash` is a crash. The harness grades a crash as a failure
  of the check, never as a refusal, even where the check expects no status.

## Operations

### `sign_request`

Sign `request` as the identity `origin`, at `now`, under the profile.

```json
{ "op": "sign_request", "key": { "kty": "OKP", "crv": "Ed25519", "x": "...", "d": "..." },
  "origin": "https://buyer-7k3q.com", "request": { "method": "POST", "url": "...", "headers": {}, "body": "..." },
  "now": 1790841600 }
```

The output is the signed request: the input request with `Signature-Agent`,
`Signature-Input`, `Signature`, and, when the request has a body,
`Content-Digest` added. The judge then verifies it.

### `sign_directory`

Serve and sign the key directory of `origin`, which publishes `keys`, at `now`.

```json
{ "op": "sign_directory", "keys": [{ "kty": "OKP", "crv": "Ed25519", "x": "...", "d": "..." }],
  "origin": "https://buyer-7k3q.com", "now": 1790841600 }
```

The output is the directory response. The judge verifies it, and then verifies the
adapter's signed requests against it.

### `verify_request`

Verify `request` at `now`. `directories` maps each origin to the signed directory
response its well-known path serves; an origin absent from the map serves no
directory, and the adapter fetches nothing from the network. `prior` lists
requests to verify first, with the same replay state, which is how the harness
builds a replay without reaching into the implementation's replay store. The
harness always sends `prior`, and it is empty except in the replay checks.

```json
{ "op": "verify_request", "request": { "method": "POST", "url": "...", "headers": {}, "body": "..." },
  "directories": { "https://buyer-7k3q.com": { "url": "...", "status": 200, "headers": {}, "body": "..." } },
  "now": 1790841610, "prior": [] }
```

The output is `{ "ok": true, "identity", "keyid" }`, where `identity` is the
origin the implementation attributes the request to, or a refusal. The harness
grades the `identity` of a request that verifies and the `status` of one that
does not.

### `verify_directory`

Verify the signed directory response of `origin` at `now`.

```json
{ "op": "verify_directory", "origin": "https://buyer-7k3q.com",
  "response": { "url": "...", "status": 200, "headers": {}, "body": "..." }, "now": 1790841610 }
```

The output is `{ "ok": true, "keyids" }`, the thumbprints of the keys the
directory verified, or a refusal. The harness grades only whether the directory
verifies: a directory refusal has no status of its own, because the request that
needed the key gets `403`.

## What the harness runs

`run.mjs` runs three suites against the adapter:

- **`vectors`**: the committed vectors in
  `static/compliance/source/test-vectors/wba-profile/`, at each vector's
  `reference_now`, with directories signed by the judge.
- **`live`**: the adapter signs a `POST` and a `GET` and its own directory, and the
  judge verifies them; then the judge signs, and the adapter verifies. The judge
  signs with the library's `generateNonce`, which produces padded standard base64.
- **`scenarios`**: the judge signs every scenario in `scenarios.json` at the run's
  clock, and the adapter verifies it. For a directory scenario with `requests`,
  the judge also signs each request with its key, and the adapter verifies it
  against that directory. The report counts tier `wba` failures ("breaks WBA")
  separately from tier `adcp` failures ("breaks an AdCP addition").

`run.mjs --self` uses `judge.mjs` as the adapter and adds the `tiers` suite, which
checks every scenario's tier against the bare library and the policy.

## Pinning

Each SDK pins `ADCP_REF` to the commit that merged this harness, and moving to a
later commit is one pull request per SDK.

## Out of scope

The harness serves directories from data. It does not grade live fetches, the
fetch rules (HTTPS, resolved-address checks, redirects, size and time limits),
directory caching, or the two AdCP checks that run after WBA verification: the
revocation list and the contents of `Accept-Signature`.
