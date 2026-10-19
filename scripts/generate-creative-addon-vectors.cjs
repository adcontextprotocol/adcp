#!/usr/bin/env node
// Deterministic public conformance data. RFC 8032 test key; NEVER use for production.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const canonicalize = require('canonicalize').default;
const output = path.join(__dirname, '../static/compliance/source/test-vectors/creative-addon-chain.json');
const sha = value => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
const bytes = value => Buffer.from(canonicalize(value), 'utf8');
const encode = value => bytes(value).toString('base64url');
const key = { kid: 'addon-vector-key', kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig',
  key_ops: ['verify'], adcp_use: 'addon-chain-signing',
  x: Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex').toString('base64url') };
const privateKey = { kty: key.kty, crv: key.crv, x: key.x,
  d: Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex').toString('base64url') };
const privateObject = crypto.createPrivateKey({ key: privateKey, format: 'jwk' });
const timestamp = '2026-10-14T12:00:00Z';
const iat = Date.parse(timestamp) / 1000;
function sign(payload, header = { alg: 'EdDSA', kid: key.kid, typ: 'adcp-addon-chain+jws' }, canonical = true) {
  const protectedHeader = encode(header);
  const payloadEncoded = canonical ? encode(payload) : Buffer.from(JSON.stringify(payload, null, 2)).toString('base64url');
  return { profile: 'adcp/addon-chain/v1', protected: protectedHeader, payload: payloadEncoded,
    signature: crypto.sign(null, Buffer.from(`${protectedHeader}.${payloadEncoded}`), privateObject).toString('base64url') };
}
const fragment = '<script src="https://measurement.example/loader.js"></script>';
const fragmentHash = sha(Buffer.from(fragment, 'utf8'));
const contexts = [
  { format_kind: 'image', content_hash: sha(Buffer.from('89504e470d0a1a0a', 'hex')) },
  { format_kind: 'html5', content_type: 'text/html', content_hash: sha(Buffer.from('<!doctype html><p>Creative</p>', 'utf8')) },
  { format_kind: 'display_tag', asset: { asset_type: 'display_tag', delivery_type: 'inline_markup', markup_type: 'javascript', markup: '<script src="https://creative.example/tag.js"></script>' } },
];
const valid = contexts.map((creative_hash_input, i) => {
  const source = i === 1 ? 'static_reference' : 'live';
  const vendor = { agent_name: 'measure', source, mode: i === 2 ? 'best_effort' : 'required',
    format_kinds: ['image', 'html5', 'display_tag'], positions: ['append'],
    ...(source === 'live' ? { agent_url: 'https://measurement.example/agent' } : { static_content_hash: fragmentHash }),
    ...(i === 2 ? {} : { max_hold_seconds: 60 }) };
  const configuration = { scope: 'product', product_id: 'display', complete: true, signed_chain_profile: 'adcp/addon-chain/v1', vendors: [vendor] };
  const entry = { order: 0, registration_index: 0, agent_name: vendor.agent_name, source,
    ...(source === 'live' ? { agent_url: vendor.agent_url } : {}), timestamp,
    ...(i === 2 ? { status: 'omitted', reason: 'vendor_omission' } : { status: 'applied', position: 'append', fragment_index: 0, content_hash: fragmentHash, bytes: Buffer.byteLength(fragment) }) };
  const expected = { agent_url: 'https://sales.example/agent', publisher_domain: 'publisher.example',
    creative_id: `creative-${i}`, format_kind: creative_hash_input.format_kind, variant_id: `variant-${i}`,
    media_buy_id: 'buy-1', package_id: 'package-1', revision_id: 'revision-1', product_id: 'display',
    creative_hash: sha(bytes(creative_hash_input)) };
  const chain = { creative_id: expected.creative_id, creative_hash: expected.creative_hash, configuration, entries: [entry], chain_hash: sha(bytes([entry])) };
  const { product_id, ...covered } = expected;
  const claims = { typ: 'adcp-addon-chain+jws', ...covered, chain_hash: chain.chain_hash, configuration_hash: sha(bytes(configuration)), iat };
  chain.signed_attestation = sign(claims);
  return { id: ['live-image', 'static-html5', 'omitted-display-tag'][i], creative_hash_input, fragment, fragment_hash: fragmentHash, chain,
    trust: { key: structuredClone(key), publisher_pin: structuredClone(key), expected, now: iat + 30 } };
});
const invalid = [];
function negative(id, expected, mutate, base = 0) {
  const changed = structuredClone(valid[base]); mutate(changed);
  const edits = [];
  function diff(a,b,at='') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const location = at ? `${at}.${k}` : k;
      if (!(k in b)) { edits.push({ path: location, remove: true }); continue; }
      if (!(k in a)) { edits.push({ path: location, value: b[k] }); continue; }
      if (a[k] && b[k] && typeof a[k] === 'object' && typeof b[k] === 'object') diff(a[k], b[k], location);
      else if (a[k] !== b[k]) edits.push({ path: location, value: b[k] });
    }
  }
  diff(valid[base], changed);invalid.push({ id, base, edits, expected });
}
function resign(vector, mutateClaims = () => {}) {
  const claims = JSON.parse(Buffer.from(vector.chain.signed_attestation.payload, 'base64url'));
  mutateClaims(claims);
  vector.chain.signed_attestation = sign(claims);
}
negative('altered-fragment-hash', 'chain_hash', v => { v.chain.entries[0].content_hash = `sha256:${'0'.repeat(64)}`; });
negative('altered-configuration', 'configuration_hash', v => { v.chain.configuration.vendors[0].mode = 'best_effort'; });
negative('wrong-key-purpose', 'key_purpose', v => { v.trust.key.adcp_use = 'request-signing'; });
negative('same-kid-wrong-publisher-material', 'publisher_pin', v => { v.trust.publisher_pin.x = 'A'.repeat(43); });
negative('wrong-variant', 'context', v => { v.trust.expected.variant_id = 'another-variant'; });
negative('wrong-publisher', 'context', v => { v.trust.expected.publisher_domain = 'other.example'; });
negative('wrong-creative', 'creative_hash', v => { v.trust.expected.creative_hash = `sha256:${'0'.repeat(64)}`; });
negative('wrong-revision', 'context', v => { v.trust.expected.revision_id = 'revision-2'; });
negative('missing-delivery-binding', 'context', v => { resign(v, p => delete p.package_id); });
negative('jws-key-url-not-a-trust-root', 'header', v => { const p=JSON.parse(Buffer.from(v.chain.signed_attestation.payload,'base64url'));v.chain.signed_attestation=sign(p,{alg:'EdDSA',kid:key.kid,typ:'adcp-addon-chain+jws',jku:'https://attacker.example/jwks'}); });
negative('noncanonical-payload', 'canonicalization', v => { const p=JSON.parse(Buffer.from(v.chain.signed_attestation.payload,'base64url'));v.chain.signed_attestation=sign(p,undefined,false); });
negative('corrupt-signature', 'signature', v => { v.chain.signed_attestation.signature = 'A'.repeat(86); });
negative('padded-base64url', 'encoding', v => { v.chain.signed_attestation.protected += '='; });
negative('future-issuance', 'time', v => resign(v, p => { p.iat += 120; }));
negative('revoked-at-issuance', 'revocation', v => { v.trust.key.revoked_at=timestamp; });
negative('backdated-without-observed-history', 'revocation', v => { v.trust.key.revoked_at='2026-10-14T12:01:00Z';v.trust.now=iat+120; });
negative('rewritten-observation-history', 'revocation', v => { v.trust.key.revoked_at='2026-10-14T12:01:00Z';v.trust.observed_at=iat+20;v.trust.observed_chain_hash=`sha256:${'0'.repeat(64)}`; });
negative('signed-required-omission', 'required_omission', v => { v.chain.configuration.vendors[0].mode='required';v.chain.configuration.vendors[0].max_hold_seconds=60;resign(v,p=>{p.configuration_hash=sha(bytes(v.chain.configuration));}); },2);
negative('signed-registration-mismatch', 'entry', v => { v.chain.entries[0].agent_name='other-vendor';v.chain.chain_hash=sha(bytes(v.chain.entries));resign(v,p=>{p.chain_hash=v.chain.chain_hash;}); });
negative('signed-invalid-order', 'entry', v => { v.chain.entries[0].order=1;v.chain.chain_hash=sha(bytes(v.chain.entries));resign(v,p=>{p.chain_hash=v.chain.chain_hash;}); });
negative('publisher-pin-revoked-at-issuance', 'revocation', v => { v.trust.publisher_pin.revoked_at=timestamp; });
negative('publisher-pin-purpose-conflict', 'publisher_pin', v => { v.trust.publisher_pin.adcp_use='request-signing'; });
negative('signed-missing-byte-count', 'schema', v => { delete v.chain.entries[0].bytes;v.chain.chain_hash=sha(bytes(v.chain.entries));resign(v,p=>{p.chain_hash=v.chain.chain_hash;}); });
negative('unknown-signed-claim', 'schema', v => { resign(v,p=>{p.unrecognized='claim';}); });
negative('signed-fragment-index-gap', 'entry', v => { v.chain.entries[0].fragment_index=1;v.chain.chain_hash=sha(bytes(v.chain.entries));resign(v,p=>{p.chain_hash=v.chain.chain_hash;}); });
negative('signed-reversed-omission-order', 'order', v => {
  v.chain.configuration.vendors.push({...v.chain.configuration.vendors[0],agent_name:'second',agent_url:'https://second.example/agent'});
  const first=v.chain.entries[0];
  v.chain.entries=[{...first,order:0,registration_index:1,agent_name:'second',agent_url:'https://second.example/agent'},{...first,order:1}];
  v.chain.chain_hash=sha(bytes(v.chain.entries));resign(v,p=>{p.chain_hash=v.chain.chain_hash;p.configuration_hash=sha(bytes(v.chain.configuration));});
},2);
negative('signed-duplicate-fragment-index-across-positions', 'entry', v => {
  v.chain.configuration.vendors[0].positions=['prepend','append'];
  v.chain.entries=[{...v.chain.entries[0],position:'prepend'},{...v.chain.entries[0],order:1,position:'append'}];
  v.chain.chain_hash=sha(bytes(v.chain.entries));resign(v,p=>{p.chain_hash=v.chain.chain_hash;p.configuration_hash=sha(bytes(v.chain.configuration));});
});
const historical = structuredClone(valid[0]);historical.id='historical-after-rotation-and-revocation';historical.trust.key.revoked_at='2026-10-14T12:01:00Z';historical.trust.observed_at=iat+20;historical.trust.observed_chain_hash=historical.chain.chain_hash;historical.trust.observed_attestation_hash=sha(bytes(historical.chain.signed_attestation));historical.trust.now=iat+86400;valid.push(historical);
const required = { source: 'live', mode: 'required', max_hold_seconds: 60, fragments: [] };
const behavior = [
 { id:'required-empty-keeps-original-task', input:{async:true,task_id:'task-1',elapsed_seconds:59,vendors:[required]},expected:{status:'working',task_id:'task-1'} },
 { id:'required-empty-at-deadline-fails', input:{async:true,task_id:'task-1',elapsed_seconds:60,vendors:[required]},expected:{status:'failed',code:'ADDON_REQUIRED_UNAVAILABLE'} },
 { id:'required-without-async-fails', input:{async:false,task_id:'task-1',elapsed_seconds:0,vendors:[required]},expected:{status:'failed',code:'ADDON_REQUIRED_UNAVAILABLE'} },
 { id:'best-effort-deliberate-omission',input:{vendors:[{...required,mode:'best_effort'}]},expected:{status:'completed',fragments:[],omitted:[{registration_index:0,reason:'vendor_omission'}]} },
 { id:'best-effort-network-failure',input:{vendors:[{...required,mode:'best_effort',error_code:'ADDON_UNREACHABLE'}]},expected:{status:'completed',fragments:[],omitted:[{registration_index:0,reason:'failure'}]} },
 { id:'required-bad-hash-fails',input:{async:false,elapsed_seconds:0,vendors:[{...required,fragments:[{position:'append',content:'x',content_hash:`sha256:${'0'.repeat(64)}`}]}]},expected:{status:'failed',code:'ADDON_REQUIRED_UNAVAILABLE'} },
 { id:'static-does-not-call-vendor',input:{vendors:[{source:'static_reference',mode:'required',position:'append',content:'static'}]},expected:{status:'completed',fragments:['static'],omitted:[]} },
 { id:'prepend-order-is-not-reversed',input:{vendors:[{source:'live',mode:'required',fragments:[{position:'append',content:'A1',content_hash:sha('A1')},{position:'prepend',content:'A0',content_hash:sha('A0')}]},{source:'live',mode:'required',fragments:[{position:'prepend',content:'B0',content_hash:sha('B0')},{position:'append',content:'B1',content_hash:sha('B1')}]}]},expected:{status:'completed',fragments:['A0','B0','A1','B1'],omitted:[]} }
];
behavior.push(
 { id:'late-recovery-cannot-resume-expired-operation',input:{async:true,task_id:'task-1',elapsed_seconds:61,vendors:[{...required,first_failure_seconds:0,fragments:[{position:'append',content:'repaired',content_hash:sha('repaired')}]}]},expected:{status:'failed',code:'ADDON_REQUIRED_UNAVAILABLE'} },
 { id:'later-expired-vendor-overrides-earlier-pending',input:{async:true,task_id:'task-1',elapsed_seconds:30,vendors:[required,{...required,max_hold_seconds:10}]},expected:{status:'failed',code:'ADDON_REQUIRED_UNAVAILABLE'} },
 { id:'per-vendor-original-deadline-survives-restart',input:{async:true,task_id:'task-1',elapsed_seconds:90,vendors:[{...required,first_failure_seconds:30,max_hold_seconds:60},{...required,first_failure_seconds:70,max_hold_seconds:60}]},expected:{status:'failed',code:'ADDON_REQUIRED_UNAVAILABLE'} },
 { id:'later-first-failure-keeps-its-own-deadline',input:{async:true,task_id:'task-1',elapsed_seconds:90,vendors:[{...required,first_failure_seconds:50,max_hold_seconds:60}]},expected:{status:'working',task_id:'task-1'} },
 { id:'recovered-earlier-vendor-cannot-mask-expired-other-vendor',input:{async:true,task_id:'task-1',elapsed_seconds:30,vendors:[{...required,fragments:[{position:'append',content:'repaired',content_hash:sha('repaired')}]},{...required,max_hold_seconds:10}]},expected:{status:'failed',code:'ADDON_REQUIRED_UNAVAILABLE'} }
);
const fixture = { $schema:'creative-addon-chain.schema.json', profile:'adcp/addon-chain/v1', note:'Public RFC 8032 test key only. Reference vectors are not production integration evidence.',test_private_key:privateKey,valid,invalid,behavior };
const serialized=JSON.stringify(fixture,null,2)+'\n';
if(process.argv.includes('--check')) { if(!fs.existsSync(output)||fs.readFileSync(output,'utf8')!==serialized) { console.error('Creative addon vectors are stale');process.exitCode=1; } else console.log('Creative addon vectors are reproducible'); }
else { fs.writeFileSync(output,serialized);console.log(`Wrote ${valid.length} valid, ${invalid.length} invalid, and ${behavior.length} behavior vectors`); }
