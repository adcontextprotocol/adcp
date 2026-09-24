import { describe, expect, it } from 'vitest';
import { enforceJsonValidationClaims, jsonValidationReceipt, UNCONFIRMED_JSON_VALIDATION } from '../../../src/addie/json-validation-evidence.js';
import type { ToolExecution } from '../../../src/addie/model-providers/tool-orchestration.js';

const schema = 'https://adcontextprotocol.org/schemas/3.1.24/media-buy/get-media-buy-delivery-response.json';
const candidate = { totals: {}, by_package: {} };
function receipt(json: unknown = candidate, url = schema, valid = true): ToolExecution {
  return {
    tool_name: 'validate_json', parameters: { json, schema_path: 'media-buy/get-media-buy-delivery-response.json', version: '3.1' },
    result: valid ? `✅ **Valid!** The JSON validates successfully against ${url}\n\nThe provided JSON conforms to the schema.`
      : `❌ **Invalid.** Validation errors against ${url}:\n\n- /totals: must be object`,
    is_error: !valid, duration_ms: 1, sequence: 1,
  };
}
const answer = (claim: string, json: unknown = candidate) => `${claim}\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\``;

describe('evidence-backed JSON validation claims', () => {
  it.each([{ json: [] }, { json: [1] }, { json: 'text' }, { json: 42 }, { json: true }, { json: null }])(
    'cannot manufacture successful receipts for values outside the object-only tool contract: $json', ({ json }) => {
      expect(jsonValidationReceipt(receipt(json))).toBeNull();
    },
  );

  it('accepts nested arrays and scalars within a validated object', () => {
    const json = { items: [1, 'text', null, true], count: 4 };
    expect(enforceJsonValidationClaims(answer('The JSON passes validation.', json), [receipt(json)]).reason).toBeNull();
  });

  it.each(['Schema-Validated MVP Response', 'Validated against AdCP 3.1.24.', 'The JSON passes validation.', 'The payload is valid.',
    'Validation succeeded.', 'This payload conforms to the schema.', 'The JSON passed all schema checks.',
    '### Validated against AdCP 3.2.0-rc.6', '### Validation succeeded.',
    '- Validation succeeded.', '> Validation succeeded.',
    'The payload was not validated, but this JSON passes validation.'])(
    'blocks unsupported success prose after seven rejected attempts: %s', claim => {
      const result = enforceJsonValidationClaims(answer(claim), Array.from({ length: 7 }, () => receipt(candidate, schema, false)));
      expect(result.reason).toBe('Unconfirmed JSON schema validation');
      expect(result.text).toContain(UNCONFIRMED_JSON_VALIDATION);
      expect(result.text).toContain(JSON.stringify(candidate, null, 2));
      expect(result.text).not.toContain(claim);
    },
  );

  it('accepts matching successful evidence despite JSON key ordering', () => {
    const result = enforceJsonValidationClaims(answer(`Validated against ${schema}.`, { by_package: {}, totals: {} }), [receipt()]);
    expect(result.reason).toBeNull();
    expect(result.text).toContain(`passed validation against ${schema}`);
  });

  it.each([
    [answer('The JSON passes validation.', { totals: [], by_package: {} }), receipt()],
    [answer('Validated against AdCP 3.2.0-rc.6.'), receipt()],
    [answer('Validated against media-buy/create-media-buy-request.json.'), receipt()],
    [answer('Validated against `media-buy/create-media-buy-request.json`.'), receipt()],
    [answer('Validated against AdCP `3.2.0-rc.6`.'), receipt()],
    [answer('The JSON passes validation.'), { ...receipt(), tool_name: 'search_docs' }],
    [answer('The JSON passes validation.'), { ...receipt(), is_error: true }],
    ['The JSON passes validation.', receipt()],
  ] as const)('rejects mismatched candidate/schema or untrusted evidence', (text, execution) => {
    expect(enforceJsonValidationClaims(text, [execution]).reason).toBeTruthy();
  });

  it('requires matching evidence for every displayed candidate', () => {
    const text = `${answer('The JSON passes validation.')}\n${answer('', { totals: [] })}`;
    expect(enforceJsonValidationClaims(text, [receipt()]).reason).toBeTruthy();
    expect(enforceJsonValidationClaims(text, [receipt(), receipt({ totals: [] })]).reason).toBeNull();
  });

  it('uses failed attempts as context, never as successful evidence', () => {
    expect(enforceJsonValidationClaims('Validation succeeded.', [receipt(candidate, schema, false)]).reason).toBeTruthy();
  });

  it('keeps an already-enforced disclaimer stable when checking a truncated answer again', () => {
    const first = enforceJsonValidationClaims(answer('The JSON passes validation.'), []);
    expect(enforceJsonValidationClaims(first.text, []).text).toBe(first.text);
  });

  it('preserves inline JSON when confirming or rejecting validation prose', () => {
    const inline = '`{"totals":{},"by_package":{}}`';
    for (const valid of [true, false]) {
      const result = enforceJsonValidationClaims(`The JSON ${inline} passes validation.`, [receipt(candidate, schema, valid)]);
      expect(result.text).toContain(inline);
      expect(Boolean(result.reason)).toBe(!valid);
    }
  });

  it('does not treat code strings, questions, negation, or conditional guidance as claims', () => {
    for (const text of [
      answer('This is an example.', { text: 'Schema-Validated MVP Response' }),
      'Has this JSON passed validation?', 'This has not been validated.',
      'Once validated against the schema, the JSON can be submitted.',
      'Your email address was validated.', 'The member directory validates organization domains.',
      'Use a valid JSON payload.', 'The schema requires valid JSON.', 'This schema validates product definitions.',
    ]) expect(enforceJsonValidationClaims(text, [])).toEqual({ text, reason: null });
  });
});
