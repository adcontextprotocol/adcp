/**
 * Reference webhook signer for the legacy HMAC-SHA256 scheme.
 *
 * CONTRACT BOUNDARY. The fixtures in static/test-vectors/webhook-hmac-sha256.json
 * (signer_side.rejection_vectors and signer_side.positive_vectors) ARE the
 * conformance contract. This file is ONE implementation that passes those
 * fixtures; it is NOT itself a spec. Downstream SDK authors MUST match the
 * fixture behavior (action + at-least-one-sanitized-key + cap-at-4 + valid
 * HMAC over clean input), but the internal shape of the returned error object
 * (field names, placeholder strings, overflow markers) is implementation-
 * defined. A Go or Python signer returning `{ action, error: { field: "dup_keys" } }`
 * with different internals is spec-compliant as long as the fixtures' asserted
 * outcomes hold.
 *
 * The duplicate-key detection here uses a test-time JSON tokenizer, not a
 * spec-compliant strict parser. Production signers MUST use their language's
 * strict-parse escape hatch per security.mdx step 14a (Python
 * `object_pairs_hook`, Node `stream-json`, Go `json.Decoder` token-walk or
 * `goccy/go-json` with `DisallowDuplicateKey()`, Jackson
 * `FAIL_ON_READING_DUP_TREE_KEY`, Ruby `Oj.load(strict_mode)`). The tokenizer
 * here is a shortcut to keep the test harness self-contained; it assumes the
 * input is well-formed JSON.
 */
const crypto = require('crypto');

/**
 * Scope-aware duplicate-key detector. Walks the JSON string tracking `{` `}`
 * `[` `]` nesting and string state, collecting object-scope key names per
 * scope. Returns the list of duplicate key names at the scope where each
 * duplicate was detected (one entry per duplicate occurrence). Handles the
 * two cases a flat regex gets wrong: (1) the same key name appearing in
 * distinct array-contained objects (legitimate — different scopes), (2) a
 * string value that contains literal `":` (not a key at all).
 *
 * Not a general JSON parser — assumes the input is well-formed. For adversarial
 * production input, use a strict parser per step 14a.
 */
function findDuplicateKeyNames(jsonStr) {
  const scopeStack = [];
  const duplicates = [];
  let i = 0;
  while (i < jsonStr.length) {
    const c = jsonStr[i];
    if (c === '{') { scopeStack.push({ type: 'object', keys: new Set() }); i++; continue; }
    if (c === '[') { scopeStack.push({ type: 'array' }); i++; continue; }
    if (c === '}' || c === ']') { scopeStack.pop(); i++; continue; }
    if (c === '"') {
      let j = i + 1;
      let value = '';
      while (j < jsonStr.length) {
        if (jsonStr[j] === '\\' && j + 1 < jsonStr.length) { value += jsonStr[j + 1]; j += 2; continue; }
        if (jsonStr[j] === '"') break;
        value += jsonStr[j]; j++;
      }
      let k = j + 1;
      while (k < jsonStr.length && /\s/.test(jsonStr[k])) k++;
      const isKey = jsonStr[k] === ':' && scopeStack.length > 0 && scopeStack[scopeStack.length - 1].type === 'object';
      if (isKey) {
        const scope = scopeStack[scopeStack.length - 1];
        if (scope.keys.has(value)) duplicates.push(value);
        else scope.keys.add(value);
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return duplicates;
}

/**
 * Returns true if any object scope contains duplicate keys. Short-circuits
 * on the first find. Delegates to `findDuplicateKeyNames` to keep the parser
 * logic single-sourced.
 */
function hasDuplicateKeyInAnyObjectScope(jsonStr) {
  return findDuplicateKeyNames(jsonStr).length > 0;
}

/**
 * Returns true if the given codepoint is non-printable per step 14b of the
 * webhook verifier checklist: C0 controls, DEL, C1 controls, bidi controls,
 * line/paragraph separators, zero-width characters, BOM. Excludes the full
 * Unicode non-printable set (formatting, private-use, unassigned) to avoid
 * over-aggressively rejecting legitimate international field names; the
 * codepoints listed here are the ones with known log-injection or rendering-
 * corruption semantics.
 */
function isNonPrintableCodepoint(cp) {
  if (cp < 0x20) return true;                    // C0 controls
  if (cp === 0x7F) return true;                  // DEL
  if (cp >= 0x80 && cp <= 0x9F) return true;     // C1 controls
  if (cp >= 0x200B && cp <= 0x200F) return true; // ZWSP, ZWNJ, ZWJ, LRM, RLM
  if (cp === 0x2028 || cp === 0x2029) return true; // LINE SEPARATOR, PARAGRAPH SEPARATOR
  if (cp >= 0x202A && cp <= 0x202E) return true; // LRE, RLE, PDF, LRO, RLO (bidi overrides)
  if (cp >= 0x2066 && cp <= 0x2069) return true; // LRI, RLI, FSI, PDI (isolates)
  if (cp === 0xFEFF) return true;                // BOM / ZWNBSP
  return false;
}

/**
 * Sanitize a key name per step 14b of the webhook verifier checklist:
 *   (a) truncate at the first non-printable codepoint (C0/C1 controls, DEL,
 *       bidi controls, line/paragraph separators, zero-width chars, BOM),
 *       emitting `<sanitized:N>` where N is the truncation byte length —
 *       elides position so attackers cannot encode bits via placement;
 *   (b) truncate to the last complete UTF-8 codepoint boundary at or below
 *       32 bytes — realistic AdCP field names top at ~24 chars, and multi-
 *       byte UTF-8 split mid-codepoint would produce invalid UTF-8 in logs
 *       and break aggregation across verifiers;
 *   (c) see callers — cap count at 4 per rejection (applied at call site,
 *       not in this function).
 */
function sanitizeKeyName(name) {
  let truncated = '';
  let hadNonPrintable = false;
  for (const ch of name) {
    const cp = ch.codePointAt(0);
    if (isNonPrintableCodepoint(cp)) {
      hadNonPrintable = true;
      break;
    }
    truncated += ch;
  }
  // UTF-8 byte-length guard: back off to the last complete codepoint boundary
  // at or below 32 bytes. Node's Buffer.byteLength measures UTF-8 bytes.
  const buf = Buffer.from(truncated, 'utf8');
  if (buf.length > 32) {
    let cut = 32;
    // Back up past any UTF-8 continuation bytes (0x80-0xBF) so we don't split
    // mid-codepoint. 0xC0 mask covers both ASCII lead bytes and UTF-8 lead
    // bytes (0xC0, 0xE0, 0xF0 prefixes), keeping only complete codepoints.
    while (cut > 0 && (buf[cut] & 0xC0) === 0x80) cut--;
    truncated = buf.slice(0, cut).toString('utf8');
  }
  if (hadNonPrintable) {
    return `<sanitized:${Buffer.byteLength(truncated, 'utf8')}>`;
  }
  return truncated;
}

/**
 * Minimal spec-compliant signer. Takes a pre-serialized body string and the
 * HMAC secret; returns `{action, ...}` per signer_side.action_values.
 * Implements: strict duplicate-key detection at every object scope (top-level,
 * plain-nested, array-contained, three-deep), step 14b sanitization (first-
 * non-printable truncation to `<sanitized:N>`, 32-byte UTF-8-codepoint-safe
 * cap, count cap at 4), HMAC signing for clean input.
 *
 * See CONTRACT BOUNDARY at the top of this file — this function is not the
 * spec; the fixtures are.
 */
function referenceSigner(bodyStr, options) {
  const opts = options || {};
  const timestamp = opts.timestamp !== undefined ? opts.timestamp : 1700000000;
  if (!opts.secret) throw new Error('referenceSigner: options.secret is required');
  const secret = opts.secret;

  const duplicates = findDuplicateKeyNames(bodyStr);
  if (duplicates.length > 0) {
    const sanitized = duplicates.slice(0, 4).map(sanitizeKeyName);
    const overflow = duplicates.length > 4 ? `<...${duplicates.length - 4} more>` : null;
    return {
      action: 'reject-input-before-sign',
      error: {
        code: 'duplicate_key_input',
        duplicate_keys: sanitized,
        overflow,
      },
    };
  }

  const message = `${timestamp}.${bodyStr}`;
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(message, 'utf8').digest('hex')}`;
  return {
    action: 'sign-and-emit',
    signed_frame: {
      timestamp,
      body: bodyStr,
      signature,
    },
  };
}

module.exports = {
  findDuplicateKeyNames,
  hasDuplicateKeyInAnyObjectScope,
  isNonPrintableCodepoint,
  sanitizeKeyName,
  referenceSigner,
};
