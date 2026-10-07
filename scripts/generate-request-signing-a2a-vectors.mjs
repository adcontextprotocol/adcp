#!/usr/bin/env node
/**
 * Generates the A2A operation-resolution request-signing vectors
 * (adcp#7820) under
 * static/compliance/source/test-vectors/request-signing/a2a/{positive,negative}/.
 *
 * These vectors grade a verifier's handling of `required_for` / `supported_for`
 * / `warn_for` over A2A: the AdCP operation is the `skill` of the sole
 * invocation DataPart, not the JSON-RPC `method` (`SendMessage`, `message/send`,
 * ...). They use the 3.2 request-signing wire profile unchanged (content-digest
 * covered, RFC 8941 sf-binary); only the operation-resolution rule is new.
 *
 * Positive vectors that are signed and the signed fail-closed negative carry
 * real Ed25519 signatures from keys.json (deterministic, so `--check` is
 * stable). Unsigned vectors carry no Signature headers.
 *
 * Usage:
 *   node scripts/generate-request-signing-a2a-vectors.mjs          # write
 *   node scripts/generate-request-signing-a2a-vectors.mjs --check  # verify committed files are current
 *
 * The keys in keys.json are public test keys. Never use them in production.
 */

import { createHash, createPrivateKey, sign } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VECTOR_DIR = join(ROOT, 'static/compliance/source/test-vectors/request-signing');
const OUT_DIR = join(VECTOR_DIR, 'a2a');
const SCRIPT = 'scripts/generate-request-signing-a2a-vectors.mjs';

const KEYID = 'test-ed25519-2026';
const URL = 'https://seller.example.com/a2a/jsonrpc';
const AUTHORITY = 'seller.example.com';
const COMPONENTS = ['@method', '@target-uri', '@authority', 'content-type', 'content-digest'];
const CREATED = 1776520800;
const EXPIRES = CREATED + 300;
const ADCP_EXTENSION = 'https://adcontextprotocol.org/extensions/adcp/v3';
const SPEC = '#verifier-checklist-requests pre-check (operation resolution over A2A)';

const key = JSON.parse(readFileSync(join(VECTOR_DIR, 'keys.json'), 'utf8')).keys.find(k => k.kid === KEYID);
const privateKey = createPrivateKey({
  key: { kty: key.kty, crv: key.crv, x: key.x, d: key._private_d_for_test_only },
  format: 'jwk',
});

const CREATE_MEDIA_BUY_INPUT = {
  idempotency_key: 'vector-a2a-create-media-buy-0001',
  account: { brand: { domain: 'acmeoutdoor.example' }, operator: 'pinnacle-agency.example', sandbox: false },
  packages: [{ product_id: 'prod-1', budget: 5000.0, pricing_option_id: 'cpm_usd_fixed', paused: false }],
  brand: { domain: 'brand.example' },
  start_time: '2027-01-04T00:00:00Z',
  end_time: '2027-02-01T00:00:00Z',
  paused: false,
  plan_id: 'plan_001',
};
const GET_PRODUCTS_INPUT = { buying_mode: 'brief', brief: 'Premium CTV inventory for a spring campaign' };

const invocation = (skill, input) => ({ data: { skill, input } });

/** A2A 1.0 JSON-RPC request body (no Part `kind`, ProtoJSON role enum). */
function a2a10(method, parts, id, messageExtras = {}) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params: { message: { messageId: `msg-${id}`, role: 'ROLE_USER', parts, ...messageExtras } },
  });
}

/** A2A 0.3 JSON-RPC request body (`kind` discriminators, lowercase role). */
function a2a03(method, parts, id) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params: {
      message: {
        kind: 'message',
        messageId: `msg-${id}`,
        role: 'user',
        parts: parts.map(part => ({ kind: 'data', ...part })),
      },
    },
  });
}

const HEADERS_1_0 = { 'A2A-Version': '1.0', 'A2A-Extensions': ADCP_EXTENSION };
const HEADERS_1_0_NO_EXTENSION = { 'A2A-Version': '1.0' };
const HEADERS_0_3 = {};

const CAPABILITY = {
  supported: true,
  covers_content_digest: 'required',
  supported_for: ['create_media_buy', 'get_products'],
  required_for: ['create_media_buy'],
};

const SIGNED_NOTE =
  'AdCP 3.2 request-signing wire profile, unchanged: the signature covers content-digest and binary values are RFC 8941 sf-binary. Only the operation-resolution rule is new.';

/**
 * `hardening` vectors grade clauses that go beyond resolving the 3.2.x
 * contradiction (SHOULD in 3.2.x, MUST from 3.3). Everything else is
 * `contradiction-resolution`: derived from the A2A profile's MCP-parity rule.
 */
const HARDENING = new Set([
  'negative/010', 'negative/011', 'negative/013', 'negative/014', 'negative/018', 'negative/019',
  'negative/020', 'negative/021', 'negative/023', 'negative/024', 'negative/025',
]);

const DEFINITIONS = [
  // ── Positive ────────────────────────────────────────────────────────────
  {
    out: 'positive/001-signed-sendmessage-create-media-buy.json',
    name: 'Signed A2A 1.0 SendMessage carrying create_media_buy; operation resolves from DataPart skill',
    body: a2a10('SendMessage', [invocation('create_media_buy', CREATE_MEDIA_BUY_INPUT)], 'a2a-pos-001'),
    headers: HEADERS_1_0,
    nonce: 'QTJBLXBvcy0wMDEtc2lnbmVk',
    capability: CAPABILITY,
    outcome: { success: true, status: 'verified', resolved_operation: 'create_media_buy' },
    comment: `${SIGNED_NOTE} A verifier that resolves the operation from the JSON-RPC method (SendMessage) instead of the skill would not match required_for and would skip the signature requirement for this operation.`,
  },
  {
    out: 'positive/002-signed-message-send-v0-3-create-media-buy.json',
    name: 'Signed A2A 0.3 message/send carrying create_media_buy; operation resolves from DataPart skill',
    body: a2a03('message/send', [invocation('create_media_buy', CREATE_MEDIA_BUY_INPUT)], 'a2a-pos-002'),
    headers: HEADERS_0_3,
    nonce: 'QTJBLXBvcy0wMDItc2lnbmVk',
    capability: CAPABILITY,
    outcome: { success: true, status: 'verified', resolved_operation: 'create_media_buy' },
    comment: `${SIGNED_NOTE} A2A 0.3 Parts carry kind="data"; the resolution rule reads data.skill identically for both A2A versions without translating method names.`,
  },
  {
    out: 'positive/003-unsigned-sendmessage-get-products-not-required.json',
    name: 'Unsigned A2A 1.0 SendMessage carrying get_products; not in required_for, so no signature is demanded',
    body: a2a10('SendMessage', [invocation('get_products', GET_PRODUCTS_INPUT)], 'a2a-pos-003'),
    headers: HEADERS_1_0,
    unsigned: true,
    capability: CAPABILITY,
    outcome: { success: true, status: 'unsigned', resolved_operation: 'get_products' },
    comment: 'Over-coverage control. Matching on the JSON-RPC method (listing SendMessage in protocol_methods_required_for) would also demand a signature here; matching on the resolved operation does not.',
  },
  {
    out: 'positive/004-unsigned-decoy-text-and-metadata.json',
    name: 'Unsigned A2A 1.0 SendMessage whose TextPart and metadata name a different operation; only the DataPart skill counts',
    body: a2a10(
      'SendMessage',
      [{ text: 'AdCP task: create_media_buy', mediaType: 'text/plain' }, invocation('get_products', GET_PRODUCTS_INPUT)],
      'a2a-pos-004',
      { metadata: { skill: 'create_media_buy' } }
    ),
    headers: HEADERS_1_0,
    unsigned: true,
    capability: CAPABILITY,
    outcome: { success: true, status: 'unsigned', resolved_operation: 'get_products', dispatched_operation: 'get_products' },
    comment: 'Skill-to-handler binding canary. The resolved operation is get_products, so the unsigned request passes the signature gate. The agent MUST then dispatch get_products (and validate input against its request schema): it MUST NOT re-derive the operation from the TextPart or message metadata, which would run create_media_buy past a gate that only checked get_products.',
  },

  {
    out: 'positive/005-unsigned-alias-skill-not-in-lists.json',
    name: 'Unsigned A2A 1.0 SendMessage whose skill is a case variant of create_media_buy; it resolves to a name that is not an operation',
    body: a2a10('SendMessage', [invocation('Create_Media_Buy', CREATE_MEDIA_BUY_INPUT)], 'a2a-pos-005'),
    headers: HEADERS_1_0,
    unsigned: true,
    capability: CAPABILITY,
    outcome: { success: true, status: 'unsigned', resolved_operation: 'Create_Media_Buy', dispatch: 'unsupported_operation' },
    comment: 'Exact-match canary. Matching is case-sensitive with no alias or normalization, so the resolved operation matches no list entry and the signature gate does not apply. The agent MUST then reject the unknown skill as an unsupported operation. It MUST NOT route it to create_media_buy through a case-insensitive, hyphen-folding, or alias lookup, which would run an unsigned create_media_buy past a gate that never saw the name.',
  },
  {
    out: 'positive/006-unsigned-message-send-v0-3-legacy-parameters.json',
    name: 'Unsigned A2A 0.3 message/send carrying get_products with the legacy parameters member; resolution reads skill only',
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'a2a-pos-006',
      method: 'message/send',
      params: {
        message: {
          kind: 'message',
          messageId: 'msg-a2a-pos-006',
          role: 'user',
          parts: [{ kind: 'data', data: { skill: 'get_products', parameters: GET_PRODUCTS_INPUT } }],
        },
      },
    }),
    headers: HEADERS_0_3,
    unsigned: true,
    capability: CAPABILITY,
    outcome: { success: true, status: 'unsigned', resolved_operation: 'get_products' },
    comment: 'Legacy 3.0/3.1 A2A clients send parameters instead of input and never send A2A-Extensions. Resolution reads only skill, so the gate neither fails on parameters nor depends on extension activation. Rejecting parameters is the dispatcher job under the v3 profile.',
  },

  {
    out: 'positive/007-unsigned-method-case-variant.json',
    name: 'Unsigned request whose JSON-RPC method is a case variant of SendMessage; the gate resolves no operation',
    body: a2a10('sendmessage', [invocation('create_media_buy', CREATE_MEDIA_BUY_INPUT)], 'a2a-pos-007'),
    headers: HEADERS_1_0,
    unsigned: true,
    capability: CAPABILITY,
    outcome: { success: true, status: 'unsigned', resolved_operation: null, dispatch: 'method_not_found' },
    comment: 'Method names match exactly. sendmessage is not a message-carrying method, so it resolves no operation and passes the gate. The dispatcher MUST reject it as an unknown method. A lenient dispatcher that case-folds the method would run an unsigned create_media_buy past a gate that saw no operation.',
  },

  // ── Negative ────────────────────────────────────────────────────────────
  {
    out: 'negative/001-unsigned-sendmessage-required.json',
    name: 'Unsigned A2A 1.0 SendMessage carrying create_media_buy; operation is in required_for',
    body: a2a10('SendMessage', [invocation('create_media_buy', CREATE_MEDIA_BUY_INPUT)], 'a2a-neg-001'),
    headers: HEADERS_1_0,
    unsigned: true,
    capability: CAPABILITY,
    outcome: { success: false, error_code: 'request_signature_required', failed_step: 0, resolved_operation: 'create_media_buy' },
    comment: 'The bypass in adcp#7820: the JSON-RPC method is SendMessage, not tools/call, so a verifier following the superseded cross-namespace rule never enters the required_for check and the unsigned create_media_buy proceeds.',
  },
  {
    out: 'negative/002-unsigned-message-send-v0-3-required.json',
    name: 'Unsigned A2A 0.3 message/send carrying create_media_buy; operation is in required_for',
    body: a2a03('message/send', [invocation('create_media_buy', CREATE_MEDIA_BUY_INPUT)], 'a2a-neg-002'),
    headers: HEADERS_0_3,
    unsigned: true,
    capability: CAPABILITY,
    outcome: { success: false, error_code: 'request_signature_required', failed_step: 0, resolved_operation: 'create_media_buy' },
  },
  {
    out: 'negative/003-unsigned-sendstreamingmessage-required.json',
    name: 'Unsigned A2A 1.0 SendStreamingMessage carrying create_media_buy; operation is in required_for',
    body: a2a10('SendStreamingMessage', [invocation('create_media_buy', CREATE_MEDIA_BUY_INPUT)], 'a2a-neg-003'),
    headers: HEADERS_1_0,
    unsigned: true,
    capability: CAPABILITY,
    outcome: { success: false, error_code: 'request_signature_required', failed_step: 0, resolved_operation: 'create_media_buy' },
    comment: 'Streaming invocation methods resolve the operation exactly like SendMessage.',
  },
  {
    out: 'negative/004-duplicate-invocation-datapart.json',
    name: 'Unsigned A2A 1.0 SendMessage with two invocation DataParts; the operation is ambiguous',
    body: a2a10(
      'SendMessage',
      [invocation('get_products', GET_PRODUCTS_INPUT), invocation('create_media_buy', CREATE_MEDIA_BUY_INPUT)],
      'a2a-neg-004'
    ),
    headers: HEADERS_1_0,
    unsigned: true,
    capability: CAPABILITY,
    outcome: { success: false, error_code: 'request_body_malformed', failed_step: 0 },
    comment: 'Fail closed. First-wins resolves get_products (not required) while last-wins would dispatch create_media_buy. The verifier rejects before consulting required_for and never treats an unresolvable invocation as "not in required_for".',
  },
  {
    out: 'negative/005-signed-duplicate-invocation-datapart.json',
    name: 'Validly signed A2A 1.0 SendMessage with two invocation DataParts; still rejected as ambiguous',
    body: a2a10(
      'SendMessage',
      [invocation('get_products', GET_PRODUCTS_INPUT), invocation('create_media_buy', CREATE_MEDIA_BUY_INPUT)],
      'a2a-neg-005'
    ),
    headers: HEADERS_1_0,
    nonce: 'QTJBLW5lZy0wMDUtZHVwcw',
    capability: CAPABILITY,
    outcome: { success: false, error_code: 'request_body_malformed', failed_step: 0 },
    comment: `${SIGNED_NOTE} The signature is valid over the body, but the body does not resolve to exactly one operation, so the verifier rejects before handler entry. Same class as step 14: a valid signature does not make an ambiguous body safe.`,
  },
  {
    out: 'negative/006-missing-skill.json',
    name: 'Unsigned A2A 1.0 SendMessage whose only DataPart has no skill; the operation cannot be resolved',
    body: a2a10('SendMessage', [{ data: { input: CREATE_MEDIA_BUY_INPUT } }], 'a2a-neg-006'),
    headers: HEADERS_1_0,
    unsigned: true,
    capability: CAPABILITY,
    outcome: { success: false, error_code: 'request_body_malformed', failed_step: 0 },
    comment: 'No resolvable operation. The verifier MUST NOT fall through to "not in required_for" and let a dispatcher guess the operation from the input shape.',
  },
  {
    out: 'negative/007-protocol-method-required-covers-sendmessage.json',
    name: 'Unsigned A2A 1.0 SendMessage carrying get_products; SendMessage is in protocol_methods_required_for',
    body: a2a10('SendMessage', [invocation('get_products', GET_PRODUCTS_INPUT)], 'a2a-neg-007'),
    headers: HEADERS_1_0,
    unsigned: true,
    capability: {
      supported: true,
      covers_content_digest: 'required',
      supported_for: ['create_media_buy', 'get_products'],
      required_for: ['create_media_buy'],
      protocol_methods_supported_for: ['SendMessage'],
      protocol_methods_required_for: ['SendMessage'],
    },
    outcome: { success: false, error_code: 'request_signature_required', failed_step: 0, resolved_operation: 'get_products' },
    comment: 'Namespaces stay disjoint and independent. protocol_methods_required_for matches the JSON-RPC method only, so listing SendMessage demands a signature on every A2A 1.0 message, including get_products. This is the over-covering interim mitigation for operators who cannot adopt the operation-resolution rule yet; it is unchanged by the operation-resolution rule.',
  },
  {
    out: 'negative/008-no-extension-header.json',
    name: 'Unsigned A2A 1.0 SendMessage carrying create_media_buy with no A2A-Extensions header; still resolved and still requires a signature',
    body: a2a10('SendMessage', [invocation('create_media_buy', CREATE_MEDIA_BUY_INPUT)], 'a2a-neg-008'),
    headers: HEADERS_1_0_NO_EXTENSION,
    unsigned: true,
    capability: CAPABILITY,
    outcome: { success: false, error_code: 'request_signature_required', failed_step: 0, resolved_operation: 'create_media_buy' },
    comment: 'Resolution keys on the JSON-RPC method, not on extension activation. Omitting A2A-Extensions MUST NOT move a create_media_buy out of required_for.',
  },
  {
    out: 'negative/009-extra-non-invocation-datapart.json',
    name: 'Unsigned A2A 1.0 SendMessage with an invocation DataPart plus a second DataPart that has no skill',
    body: a2a10('SendMessage', [invocation('get_products', GET_PRODUCTS_INPUT), { data: { note: 'extra' } }], 'a2a-neg-009'),
    headers: HEADERS_1_0,
    unsigned: true,
    capability: CAPABILITY,
    outcome: { success: false, error_code: 'request_body_malformed', failed_step: 0 },
    comment: 'A Message carries exactly one DataPart. A gate that counts only DataParts shaped like an invocation and a dispatcher that counts every DataPart can disagree about which Part is authoritative.',
  },
  {
    out: 'negative/010-filepart-present.json',
    name: 'Unsigned A2A 1.0 SendMessage with an invocation DataPart plus a FilePart',
    body: a2a10('SendMessage', [invocation('get_products', GET_PRODUCTS_INPUT), { url: 'https://cdn.example.com/creative.mp4', mediaType: 'video/mp4' }], 'a2a-neg-010'),
    headers: HEADERS_1_0,
    unsigned: true,
    capability: CAPABILITY,
    outcome: { success: false, error_code: 'request_body_malformed', failed_step: 0 },
    comment: 'FileParts are outside the AdCP A2A invocation profile; a Message that carries one does not resolve to exactly one operation.',
  },
  {
    out: 'negative/011-part-with-text-and-data.json',
    name: 'Unsigned A2A 1.0 SendMessage whose single Part carries both text and data members',
    body: a2a10('SendMessage', [{ text: 'AdCP task: get_products', data: { skill: 'create_media_buy', input: CREATE_MEDIA_BUY_INPUT } }], 'a2a-neg-011'),
    headers: HEADERS_1_0,
    unsigned: true,
    capability: CAPABILITY,
    outcome: { success: false, error_code: 'request_body_malformed', failed_step: 0 },
    comment: 'A 1.0 Part is a oneof by member presence. A lenient parser can read it as the TextPart while another reads it as the DataPart, so a Part with more than one content member is rejected.',
  },
  {
    out: 'negative/012-non-object-data.json',
    name: 'Unsigned A2A 1.0 SendMessage whose DataPart data is an array, not an object',
    body: a2a10('SendMessage', [{ data: ['create_media_buy', CREATE_MEDIA_BUY_INPUT] }], 'a2a-neg-012'),
    headers: HEADERS_1_0,
    unsigned: true,
    capability: CAPABILITY,
    outcome: { success: false, error_code: 'request_body_malformed', failed_step: 0 },
    comment: 'A2A 1.0 models data as a protobuf Value, so an array, string, or number is representable on the wire. Only a JSON object with a string skill resolves.',
  },
  {
    out: 'negative/013-v0-3-kind-mismatch.json',
    name: 'Unsigned A2A 0.3 message/send whose Part declares kind text but carries a data member',
    body: JSON.stringify({ jsonrpc: '2.0', id: 'a2a-neg-013', method: 'message/send', params: { message: { kind: 'message', messageId: 'msg-a2a-neg-013', role: 'user', parts: [{ kind: 'text', data: { skill: 'create_media_buy', input: CREATE_MEDIA_BUY_INPUT } }] } } }),
    headers: HEADERS_0_3,
    unsigned: true,
    capability: CAPABILITY,
    outcome: { success: false, error_code: 'request_body_malformed', failed_step: 0 },
    comment: 'A 0.3 kind that disagrees with the member present is ambiguous. A 0.3-to-1.0 compatibility translator and the gate could otherwise pick different Parts.',
  },
  {
    out: 'negative/014-duplicate-skill-key.json',
    name: 'Unsigned A2A 1.0 SendMessage whose DataPart object repeats the skill key',
    body: '{"jsonrpc":"2.0","id":"a2a-neg-014","method":"SendMessage","params":{"message":{"messageId":"msg-a2a-neg-014","role":"ROLE_USER","parts":[{"data":{"skill":"get_products","skill":"create_media_buy","input":{}}}]}}}',
    headers: HEADERS_1_0,
    unsigned: true,
    capability: CAPABILITY,
    outcome: { success: false, error_code: 'request_body_malformed', failed_step: 0 },
    comment: 'Parser differential: first-wins reads get_products, last-wins reads create_media_buy. The resolver MUST use a duplicate-key-rejecting parser on the unsigned path too, not only at checklist step 14.',
  },
  {
    out: 'negative/015-non-string-skill.json',
    name: 'Unsigned A2A 1.0 SendMessage whose skill is a number',
    body: a2a10('SendMessage', [{ data: { skill: 7, input: CREATE_MEDIA_BUY_INPUT } }], 'a2a-neg-015'),
    headers: HEADERS_1_0,
    unsigned: true,
    capability: CAPABILITY,
    outcome: { success: false, error_code: 'request_body_malformed', failed_step: 0 },
    comment: 'skill MUST be a non-empty string. A coercing parser could turn a non-string into a name the dispatcher then matches.',
  },
  {
    out: 'negative/016-text-only-message.json',
    name: 'Unsigned A2A 1.0 SendMessage with only a TextPart on an interface that dispatches AdCP operations',
    body: a2a10('SendMessage', [{ text: 'Please create a media buy for the spring campaign', mediaType: 'text/plain' }], 'a2a-neg-016'),
    headers: HEADERS_1_0,
    unsigned: true,
    capability: CAPABILITY,
    outcome: { success: false, error_code: 'request_body_malformed', failed_step: 0 },
    comment: 'Zero DataParts: no operation resolves. A text- or model-based router MUST NOT infer create_media_buy from the prose and dispatch it past the signature gate.',
  },
  {
    out: 'negative/017-unsigned-message-stream-v0-3-required.json',
    name: 'Unsigned A2A 0.3 message/stream carrying create_media_buy; operation is in required_for',
    body: a2a03('message/stream', [invocation('create_media_buy', CREATE_MEDIA_BUY_INPUT)], 'a2a-neg-017'),
    headers: HEADERS_0_3,
    unsigned: true,
    capability: CAPABILITY,
    outcome: { success: false, error_code: 'request_signature_required', failed_step: 0, resolved_operation: 'create_media_buy' },
    comment: 'The 0.3 streaming method resolves exactly like message/send.',
  },
  {
    out: 'negative/018-unresolvable-with-lone-signature-header.json',
    name: 'Unsigned-looking A2A 1.0 SendMessage with two DataParts and a Signature header but no Signature-Input',
    body: a2a10(
      'SendMessage',
      [invocation('get_products', GET_PRODUCTS_INPUT), invocation('create_media_buy', CREATE_MEDIA_BUY_INPUT)],
      'a2a-neg-018'
    ),
    headers: HEADERS_1_0,
    extraHeaders: { Signature: `sig1=:${Buffer.alloc(64).toString('base64')}:` },
    unsigned: true,
    capability: CAPABILITY,
    outcome: { success: false, error_code: 'request_body_malformed', failed_step: 0 },
    comment: 'Ordering canary. The request is both unresolvable and carries a malformed header pair (Signature without Signature-Input). Resolution runs first in the pre-check, so the code is request_body_malformed, not request_signature_header_malformed.',
  },
  {
    out: 'negative/019-raw-part-present.json',
    name: 'Unsigned A2A 1.0 SendMessage with an invocation DataPart plus a raw-bytes Part',
    body: a2a10('SendMessage', [invocation('get_products', GET_PRODUCTS_INPUT), { raw: 'AAAA', mediaType: 'application/octet-stream' }], 'a2a-neg-019'),
    headers: HEADERS_1_0,
    unsigned: true,
    capability: CAPABILITY,
    outcome: { success: false, error_code: 'request_body_malformed', failed_step: 0 },
    comment: 'raw and url are both A2A 1.0 file content members; either makes a FilePart, which the invocation profile does not allow.',
  },
  {
    out: 'negative/020-case-variant-member-name.json',
    name: 'Unsigned A2A 1.0 SendMessage whose DataPart carries both skill and a case variant Skill',
    body: '{"jsonrpc":"2.0","id":"a2a-neg-020","method":"SendMessage","params":{"message":{"messageId":"msg-a2a-neg-020","role":"ROLE_USER","parts":[{"data":{"skill":"get_products","Skill":"create_media_buy","input":{}}}]}}}',
    headers: HEADERS_1_0,
    unsigned: true,
    capability: CAPABILITY,
    outcome: { success: false, error_code: 'request_body_malformed', failed_step: 0 },
    comment: 'Some decoders match member names case-insensitively (Go encoding/json). A case-sensitive gate reads get_products while such a dispatcher reads create_media_buy. A recognized member name in another case is rejected.',
  },
  {
    out: 'negative/021-escaped-duplicate-skill-key.json',
    name: 'Unsigned A2A 1.0 SendMessage whose DataPart repeats skill, once written with a JSON unicode escape',
    body: '{"jsonrpc":"2.0","id":"a2a-neg-021","method":"SendMessage","params":{"message":{"messageId":"msg-a2a-neg-021","role":"ROLE_USER","parts":[{"data":{"skill":"get_products","sk\\u0069ll":"create_media_buy","input":{}}}]}}}',
    headers: HEADERS_1_0,
    unsigned: true,
    capability: CAPABILITY,
    outcome: { success: false, error_code: 'request_body_malformed', failed_step: 0 },
    comment: 'Duplicate detection runs after JSON string decoding, so skill and sk\\u0069ll are the same key. A byte-level duplicate check misses this and the two parsers disagree on the value.',
  },
  {
    out: 'negative/022-unsigned-http-json-message-send-required.json',
    name: 'Unsigned A2A 1.0 HTTP+JSON POST /message:send carrying create_media_buy; operation is in required_for',
    url: 'https://seller.example.com/a2a/v1/message:send',
    body: JSON.stringify({ message: { messageId: 'msg-a2a-neg-022', role: 'ROLE_USER', parts: [invocation('create_media_buy', CREATE_MEDIA_BUY_INPUT)] } }),
    headers: HEADERS_1_0,
    unsigned: true,
    capability: CAPABILITY,
    outcome: { success: false, error_code: 'request_signature_required', failed_step: 0, resolved_operation: 'create_media_buy' },
    comment: 'The HTTP+JSON binding has no JSON-RPC method, so method-keyed resolution never fires. The same skill resolution applies to the decoded message. The binding path is /message:send or /message:stream.',
  },
  {
    out: 'negative/023-batch-body.json',
    name: 'Unsigned JSON array of two A2A 1.0 SendMessage requests, one carrying create_media_buy',
    body: JSON.stringify([
      JSON.parse(a2a10('SendMessage', [invocation('get_products', GET_PRODUCTS_INPUT)], 'a2a-neg-023-a')),
      JSON.parse(a2a10('SendMessage', [invocation('create_media_buy', CREATE_MEDIA_BUY_INPUT)], 'a2a-neg-023-b')),
    ]),
    headers: HEADERS_1_0,
    unsigned: true,
    capability: CAPABILITY,
    outcome: { success: false, error_code: 'request_body_malformed', failed_step: 0 },
    comment: 'A batch has no top-level method. A verifier that does not support batches rejects it. A verifier that does MUST resolve every element and demand a signature because the second element is in required_for, so request_signature_required is the only other conformant outcome. Batch semantics are tracked in adcp#7565.',
  },
  {
    out: 'negative/024-duplicate-method-key.json',
    name: 'Unsigned JSON-RPC body that repeats the method key, tasks/get first and SendMessage last',
    body: '{"jsonrpc":"2.0","id":"a2a-neg-024","method":"tasks/get","method":"SendMessage","params":{"message":{"messageId":"msg-a2a-neg-024","role":"ROLE_USER","parts":[{"data":{"skill":"create_media_buy","input":{}}}]}}}',
    headers: HEADERS_1_0,
    unsigned: true,
    capability: CAPABILITY,
    outcome: { success: false, error_code: 'request_body_malformed', failed_step: 0 },
    comment: 'A first-wins gate classifies the request as tasks/get (no operation) while a last-wins executor dispatches SendMessage carrying create_media_buy.',
  },
  {
    out: 'negative/025-missing-method.json',
    name: 'Unsigned JSON-RPC body with no method member',
    body: JSON.stringify({ jsonrpc: '2.0', id: 'a2a-neg-025', params: { message: { messageId: 'msg-a2a-neg-025', role: 'ROLE_USER', parts: [invocation('create_media_buy', CREATE_MEDIA_BUY_INPUT)] } } }),
    headers: HEADERS_1_0,
    unsigned: true,
    capability: CAPABILITY,
    outcome: { success: false, error_code: 'request_body_malformed', failed_step: 0 },
    comment: 'A JSON-RPC request has a string method. Without one nothing classifies the body, so it is rejected rather than treated as a request for no operation.',
  },
  {
    out: 'negative/026-empty-skill.json',
    name: 'Unsigned A2A 1.0 SendMessage whose skill is the empty string',
    body: a2a10('SendMessage', [{ data: { skill: '', input: CREATE_MEDIA_BUY_INPUT } }], 'a2a-neg-026'),
    headers: HEADERS_1_0,
    unsigned: true,
    capability: CAPABILITY,
    outcome: { success: false, error_code: 'request_body_malformed', failed_step: 0 },
    comment: 'skill MUST be a non-empty string.',
  },
];

function buildVector(def) {
  const headers = { 'Content-Type': 'application/json', ...def.headers, ...def.extraHeaders };
  const digest = `sha-256=:${createHash('sha256').update(def.body, 'utf8').digest('base64')}:`;
  const vector = {
    name: def.name,
    spec_reference: SPEC,
    signing_profile_version: '3.2',
    tier: HARDENING.has(def.out.slice(0, 12)) ? 'hardening' : 'contradiction-resolution',
    reference_now: CREATED,
    request: { method: 'POST', url: def.url ?? URL, headers, body: def.body },
    verifier_capability: def.capability,
    jwks_ref: [KEYID],
  };

  if (!def.unsigned) {
    headers['Content-Digest'] = digest;
    const serialized = `(${COMPONENTS.map(c => `"${c}"`).join(' ')});created=${CREATED};expires=${EXPIRES};nonce="${def.nonce}";keyid="${KEYID}";alg="ed25519";tag="adcp/request-signing/v1"`;
    const base = [
      `"@method": POST`,
      `"@target-uri": ${def.url ?? URL}`,
      `"@authority": ${AUTHORITY}`,
      `"content-type": application/json`,
      `"content-digest": ${digest}`,
      `"@signature-params": ${serialized}`,
    ].join('\n');
    headers['Signature-Input'] = `sig1=${serialized}`;
    headers.Signature = `sig1=:${sign(null, Buffer.from(base, 'utf8'), privateKey).toString('base64')}:`;
    vector.expected_signature_base = base;
  }

  vector.expected_outcome = def.outcome;
  vector.$comment = def.comment ?? 'Same resolution rule as negative/001, exercised on a different invocation-carrying method or A2A version.';
  return vector;
}

const check = process.argv.includes('--check');
let stale = 0;
const owned = new Set(DEFINITIONS.map(def => def.out));
for (const sub of ['positive', 'negative']) {
  mkdirSync(join(OUT_DIR, sub), { recursive: true });
  for (const file of readdirSync(join(OUT_DIR, sub)).filter(name => name.endsWith('.json'))) {
    if (!owned.has(`${sub}/${file}`)) {
      console.error(`${sub}/${file} is not produced by ${SCRIPT}; delete or register it`);
      stale++;
    }
  }
}
for (const def of DEFINITIONS) {
  const rendered = `${JSON.stringify(buildVector(def), null, 2)}\n`;
  const path = join(OUT_DIR, def.out);
  if (check) {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (current !== rendered) {
      console.error(`${def.out} is stale; run node ${SCRIPT}`);
      stale++;
    }
  } else {
    writeFileSync(path, rendered);
  }
}
if (stale) process.exitCode = 1;
else console.log(`${check ? 'verified' : 'wrote'} ${DEFINITIONS.length} A2A request-signing vectors`);
