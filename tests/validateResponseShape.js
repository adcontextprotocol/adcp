/**
 * Validates that an actual API response matches the expected shape from documentation.
 *
 * This function checks:
 * - All documented fields are present in the actual response
 * - Types match between expected and actual values
 * - Nested objects and arrays have the correct structure
 *
 * It does NOT check:
 * - Exact string values (messages, IDs will vary)
 * - Exact numeric values (prices, budgets will vary)
 * - Extra fields in response (allows implementation to return more data)
 *
 * @param {object} actual - The actual response from the API
 * @param {object} expected - The expected response shape from documentation
 * @param {string} path - Current path in the object (for error messages)
 * @throws {Error} If validation fails
 */
function validateResponseShape(actual, expected, path = 'response') {
  // Both null/undefined is OK
  if (expected === null || expected === undefined) {
    if (actual !== null && actual !== undefined) {
      throw new Error(`${path}: Expected null/undefined, got ${typeof actual}`);
    }
    return;
  }

  // Check actual is not null when expected has a value
  if (actual === null || actual === undefined) {
    throw new Error(`${path}: Expected ${typeof expected}, got ${actual}`);
  }

  // Get the type of expected value
  const expectedType = Array.isArray(expected) ? 'array' : typeof expected;
  const actualType = Array.isArray(actual) ? 'array' : typeof actual;

  // Type must match
  if (expectedType !== actualType) {
    throw new Error(`${path}: Expected type ${expectedType}, got ${actualType}`);
  }

  // Validate based on type
  switch (expectedType) {
    case 'object':
      validateObject(actual, expected, path);
      break;

    case 'array':
      validateArray(actual, expected, path);
      break;

    case 'string':
    case 'number':
    case 'boolean':
      // Primitive types - just check type, not value
      // (values will vary between test runs)
      break;

    default:
      throw new Error(`${path}: Unsupported type ${expectedType}`);
  }
}

/**
 * Validates object structure
 */
function validateObject(actual, expected, path) {
  // Check all expected fields are present
  for (const key in expected) {
    if (!Object.prototype.hasOwnProperty.call(actual, key)) {
      throw new Error(`${path}.${key}: Field is missing from response`);
    }

    // Recursively validate nested structure
    validateResponseShape(actual[key], expected[key], `${path}.${key}`);
  }

  // Note: We don't check for extra fields in actual
  // This allows implementations to return additional data
}

/**
 * Validates array structure
 */
function validateArray(actual, expected, path) {
  // If expected is empty array, actual must also be an array (any length OK)
  if (expected.length === 0) {
    // Just check it's an array, allow any content
    return;
  }

  // Actual can be empty (no results found)
  if (actual.length === 0) {
    return;
  }

  // Validate first element of actual array against first element of expected array
  const template = expected[0];

  // Check each element in actual matches the template structure
  actual.forEach((item, index) => {
    validateResponseShape(item, template, `${path}[${index}]`);
  });
}

module.exports = { validateResponseShape };
