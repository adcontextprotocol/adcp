/**
 * Signer-side conformance harness for the legacy HMAC-SHA256 webhook scheme.
 *
 * CONTRACT BOUNDARY. The fixtures in static/test-vectors/webhook-hmac-sha256.json
 * under `signer_side.rejection_vectors` and `signer_side.positive_vectors` ARE
 * the conformance contract. The reference signer in
 * tests/helpers/reference-webhook-signer.cjs is ONE implementation that passes
 * those fixtures; it is NOT itself a spec. Downstream SDK authors MUST match
 * the fixture behavior (action matches expected_signer_action, rejection
 * surfaces at least one sanitized duplicate-key name capped at 4, clean input
 * produces a verifying HMAC) but the internal shape of the returned error
 * object (field names, placeholder strings, overflow markers) is
 * implementation-defined.
 *
 * This file is the in-repo enforcement path that closes the gap prior review
 * flagged: the spec's "interop harnesses MUST exercise both" language was
 * previously exhortation without CI enforcement. This file runs the reference
 * signer in-process against every fixture vector.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  referenceSigner,
  sanitizeKeyName,
  isNonPrintableCodepoint,
} = require('./helpers/reference-webhook-signer.cjs');

const vectorsPath = path.join(__dirname, '..', 'static', 'test-vectors', 'webhook-hmac-sha256.json');
const data = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));

describe('Signer conformance harness', () => {
  describe('rejection vectors', () => {
    for (const vector of data.signer_side?.rejection_vectors || []) {
      it(`reference signer rejects: ${vector.id}`, () => {
        const result = referenceSigner(vector.signer_input_body, { secret: data.secret });
        assert.equal(result.action, vector.expected_signer_action,
          `vector "${vector.id}": reference signer returned action "${result.action}", expected "${vector.expected_signer_action}". A failure here means either the fixture is miscategorized or the signer's duplicate-key detection is missing a shape the fixture probes`);
        assert.equal(result.error?.code, 'duplicate_key_input',
          `vector "${vector.id}": the error identifier is normative (security.mdx §duplicate-object-keys) and MUST be exactly "duplicate_key_input" so that multi-SDK integrations can dispatch on it — this is the one field in the error object that is cross-SDK stable; everything else is implementation-defined`);
        assert.ok(Array.isArray(result.error?.duplicate_keys) && result.error.duplicate_keys.length > 0,
          `vector "${vector.id}": rejection MUST surface at least one sanitized duplicate-key name in error.duplicate_keys for operator diagnosis`);
        assert.ok(result.error.duplicate_keys.length <= 4,
          `vector "${vector.id}": rejection MUST cap duplicate_keys at 4 per step 14b`);
        assert.ok(!result.signed_frame,
          `vector "${vector.id}": rejection MUST NOT emit a signed_frame (signer MUST NOT compute the HMAC on malformed input)`);
      });
    }
  });

  describe('positive vectors', () => {
    for (const vector of data.signer_side?.positive_vectors || []) {
      it(`reference signer signs: ${vector.id}`, () => {
        const result = referenceSigner(vector.signer_input_body, { secret: data.secret });
        assert.equal(result.action, vector.expected_signer_action,
          `vector "${vector.id}": reference signer returned action "${result.action}", expected "${vector.expected_signer_action}". A failure here means the signer's duplicate-key detection is over-eager (false positive on non-duplicate-key input)`);
        assert.ok(!result.error,
          `vector "${vector.id}": positive signer output MUST NOT carry an error field — emitting both signed_frame AND error is an ambiguous response shape that callers cannot interpret`);
        assert.ok(result.signed_frame?.signature?.startsWith('sha256='),
          `vector "${vector.id}": signed_frame MUST carry a sha256= signature`);
        const message = `${result.signed_frame.timestamp}.${result.signed_frame.body}`;
        const recomputed = `sha256=${crypto.createHmac('sha256', data.secret).update(message, 'utf8').digest('hex')}`;
        assert.equal(result.signed_frame.signature, recomputed,
          `vector "${vector.id}": signature MUST verify against the test secret and the signed message format`);
      });
    }
  });

  describe('sanitizeKeyName — ASCII controls', () => {
    it('printable ASCII pass-through', () => {
      assert.equal(sanitizeKeyName('status'), 'status');
      assert.equal(sanitizeKeyName('signed_authorized_agents'), 'signed_authorized_agents');
    });

    it('newline truncates and emits placeholder', () => {
      assert.equal(sanitizeKeyName('foo\nbar'), '<sanitized:3>',
        'newline at position 3: truncated prefix is "foo" (3 bytes), placeholder is <sanitized:3>');
    });

    it('ANSI escape at position 0 collapses to <sanitized:0>', () => {
      assert.equal(sanitizeKeyName('\u001b[31mred\u001b[0m'), '<sanitized:0>',
        'ESC at position 0: empty prefix, placeholder is <sanitized:0>');
    });

    it('DEL character truncates', () => {
      assert.equal(sanitizeKeyName('foo\u007fbar'), '<sanitized:3>',
        'DEL (0x7F) at position 3: truncated prefix is "foo"');
    });

    it('long printable-ASCII name truncates to 32 bytes', () => {
      assert.equal(sanitizeKeyName('a'.repeat(100)), 'a'.repeat(32),
        'no non-printables → no placeholder → just the 32-byte truncation');
    });
  });

  describe('sanitizeKeyName — Unicode non-printable ranges', () => {
    // M1: the prior implementation used only ASCII 0x20–0x7E. Bidi controls,
    // line separators, zero-width chars, and C1 controls passed through and
    // reopened the log-injection channel step 14b exists to close. These tests
    // document the expanded ranges and prevent regression.

    it('U+202E RIGHT-TO-LEFT OVERRIDE (bidi override, renders backwards in logs)', () => {
      const input = 'admin\u202Erenimda';
      const output = sanitizeKeyName(input);
      assert.equal(output, '<sanitized:5>',
        'U+202E after "admin" must truncate; without this check an attacker can reverse-render log entries in terminals/SIEMs');
    });

    it('U+2028 LINE SEPARATOR (JSON log injection)', () => {
      const input = 'key\u2028injected';
      const output = sanitizeKeyName(input);
      assert.equal(output, '<sanitized:3>',
        'U+2028 renders as a line break in many log viewers; must truncate to prevent row-injection attacks');
    });

    it('U+2029 PARAGRAPH SEPARATOR', () => {
      const input = 'foo\u2029bar';
      const output = sanitizeKeyName(input);
      assert.equal(output, '<sanitized:3>',
        'U+2029 like U+2028 — paragraph-level rendering break, must truncate');
    });

    it('U+200B ZERO WIDTH SPACE (invisible obfuscation)', () => {
      const input = 'admin\u200Buser';
      const output = sanitizeKeyName(input);
      assert.equal(output, '<sanitized:5>',
        'ZWSP is invisible; must truncate or attackers can embed invisible markers in keys that survive into logs');
    });

    it('U+200C ZWNJ and U+200D ZWJ', () => {
      assert.equal(sanitizeKeyName('a\u200Cb'), '<sanitized:1>');
      assert.equal(sanitizeKeyName('a\u200Db'), '<sanitized:1>');
    });

    it('U+FEFF BOM at mid-name (parser corruption)', () => {
      const input = 'ok\uFEFFbad';
      const output = sanitizeKeyName(input);
      assert.equal(output, '<sanitized:2>',
        'BOM is often stripped silently by parsers but leaks as literal byte in logs; must truncate');
    });

    it('U+0085 NEXT LINE (C1 control)', () => {
      const input = 'foo\u0085bar';
      const output = sanitizeKeyName(input);
      assert.equal(output, '<sanitized:3>',
        'U+0085 is a C1 control (line-break semantics in some terminals); must truncate');
    });

    it('U+009B CSI (C1 control — terminal control sequence introducer)', () => {
      const input = 'foo\u009B31mred';
      const output = sanitizeKeyName(input);
      assert.equal(output, '<sanitized:3>',
        'U+009B is a single-byte CSI equivalent to ESC[; terminals honor it, must truncate');
    });

    it('legitimate CJK / accented printable names pass through', () => {
      assert.equal(sanitizeKeyName('café'), 'café',
        'accented printable Latin passes through (in byte length: café = 5 bytes UTF-8, under 32)');
      // Note: truncation still applies, so anything exceeding 32 bytes is cut
      // at the last codepoint boundary. CJK names are 3 bytes per codepoint
      // and pass through up to 30 bytes = 10 codepoints.
      assert.equal(sanitizeKeyName('日本'), '日本',
        'short CJK passes through (6 bytes UTF-8, under 32)');
    });
  });

  describe('sanitizeKeyName — UTF-8 codepoint-boundary truncation', () => {
    it('11 × "日" (33 bytes) truncates to 10 × "日" (30 bytes) at codepoint boundary', () => {
      const input = '日'.repeat(11);
      const output = sanitizeKeyName(input);
      const outBytes = Buffer.byteLength(output, 'utf8');
      assert.ok(outBytes <= 32,
        `UTF-8 truncation MUST produce at most 32 bytes (got ${outBytes})`);
      assert.equal(outBytes % 3, 0,
        `all "日" codepoints are 3 bytes; valid truncation MUST land on a multiple-of-3 byte length (got ${outBytes})`);
      assert.equal(output, '日'.repeat(10),
        '10 × "日" = 30 bytes, highest complete-codepoint count that fits under 32');
    });

    it('emoji (4-byte codepoint) truncates at codepoint boundary', () => {
      const input = '😀'.repeat(10);
      const output = sanitizeKeyName(input);
      const outBytes = Buffer.byteLength(output, 'utf8');
      assert.ok(outBytes <= 32, `got ${outBytes} bytes`);
      assert.equal(outBytes % 4, 0,
        'each emoji is 4 bytes UTF-8; truncation MUST land on a multiple-of-4 byte length');
      assert.equal(output, '😀'.repeat(8),
        '8 × "😀" = 32 bytes, exactly fits the cap');
    });

    it('mixed-width codepoints truncate without splitting', () => {
      // "a" = 1 byte, "é" = 2 bytes, "日" = 3 bytes, "😀" = 4 bytes.
      // Build a string whose 33rd byte lands mid-codepoint and assert
      // truncation lands before that codepoint.
      const input = 'a'.repeat(28) + '日' + '日';  // 28 + 3 + 3 = 34 bytes
      const output = sanitizeKeyName(input);
      const outBytes = Buffer.byteLength(output, 'utf8');
      assert.ok(outBytes <= 32, `got ${outBytes}`);
      assert.equal(output, 'a'.repeat(28) + '日',
        'truncation lands after the first "日" (31 bytes) because the second "日" would cross 32');
    });
  });

  describe('isNonPrintableCodepoint — classification', () => {
    it('C0 controls flagged', () => {
      for (const cp of [0x00, 0x09, 0x0A, 0x0D, 0x1B, 0x1F]) {
        assert.ok(isNonPrintableCodepoint(cp), `U+${cp.toString(16).padStart(4, '0').toUpperCase()} MUST be non-printable`);
      }
    });
    it('DEL flagged', () => {
      assert.ok(isNonPrintableCodepoint(0x7F));
    });
    it('C1 controls flagged', () => {
      for (const cp of [0x80, 0x85, 0x9B, 0x9F]) {
        assert.ok(isNonPrintableCodepoint(cp), `U+${cp.toString(16).padStart(4, '0').toUpperCase()} MUST be non-printable`);
      }
    });
    it('bidi controls and isolates flagged', () => {
      for (const cp of [0x200E, 0x200F, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069]) {
        assert.ok(isNonPrintableCodepoint(cp), `U+${cp.toString(16).padStart(4, '0').toUpperCase()} MUST be non-printable`);
      }
    });
    it('zero-width chars flagged', () => {
      for (const cp of [0x200B, 0x200C, 0x200D]) {
        assert.ok(isNonPrintableCodepoint(cp), `U+${cp.toString(16).padStart(4, '0').toUpperCase()} MUST be non-printable`);
      }
    });
    it('line / paragraph separators flagged', () => {
      assert.ok(isNonPrintableCodepoint(0x2028));
      assert.ok(isNonPrintableCodepoint(0x2029));
    });
    it('BOM flagged', () => {
      assert.ok(isNonPrintableCodepoint(0xFEFF));
    });
    it('printable ranges pass', () => {
      // Space, ASCII alphanumerics, Latin-1 accents, CJK, emoji.
      for (const cp of [0x20, 0x41, 0x7E, 0xE9, 0x65E5, 0x1F600]) {
        assert.ok(!isNonPrintableCodepoint(cp), `U+${cp.toString(16).padStart(4, '0').toUpperCase()} MUST be printable`);
      }
    });
  });
});
