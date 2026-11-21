/**
 * JSON Schema for the `account` reference that training-agent tools accept.
 *
 * This module imports nothing, so every tool module can read the schema while
 * it evaluates, whatever module of the training-agent import cycle loads first.
 */
export const ACCOUNT_REF_SCHEMA = {
  type: 'object',
  oneOf: [
    {
      properties: { account_id: { type: 'string' } },
      required: ['account_id'],
      additionalProperties: false,
    },
    {
      properties: {
        brand: {
          type: 'object',
          properties: {
            domain: { type: 'string' },
            brand_id: { type: 'string' },
            countries: {
              type: 'array',
              items: { type: 'string', pattern: '^[A-Z]{2}$' },
              minItems: 1,
              uniqueItems: true,
            },
          },
          required: ['domain'],
          additionalProperties: false,
        },
        operator: { type: 'string' },
        operator_unit: {
          type: 'object',
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]*$' },
            name: { type: 'string', minLength: 1, maxLength: 200 },
          },
          required: ['id'],
          additionalProperties: false,
        },
        currency: { type: 'string', pattern: '^[A-Z]{3}$' },
        timezone: { type: 'string', minLength: 1 },
        sandbox: { type: 'boolean' },
      },
      required: ['brand', 'operator'],
      additionalProperties: false,
    },
  ],
};
