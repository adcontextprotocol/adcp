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
 * For more thorough validation including value checks, use validateResponse().
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

/**
 * Validates that an actual API response matches expected values (stricter than validateResponseShape).
 *
 * This function checks everything validateResponseShape does, PLUS:
 * - Enum values are valid (e.g., delivery_type must be "guaranteed" or "non_guaranteed")
 * - Numeric ranges are sensible (e.g., CPM > 0)
 * - String patterns match (e.g., IDs, URLs)
 * - Consistency rules (e.g., if is_fixed_price, pricing must have fixed price)
 *
 * Use this for targeted integration tests where you control the test data.
 * Use validateResponseShape() for documentation examples where data varies.
 *
 * @param {object} actual - The actual response from the API
 * @param {object} constraints - Constraints to validate (enum values, ranges, etc.)
 * @param {string} path - Current path in the object (for error messages)
 * @throws {Error} If validation fails
 */
function validateResponse(actual, constraints, path = 'response') {
  // First validate structure
  validateResponseShape(actual, constraints.shape || constraints, path);

  // Then validate specific values if constraints provided
  if (constraints.enums) {
    validateEnums(actual, constraints.enums, path);
  }

  if (constraints.ranges) {
    validateRanges(actual, constraints.ranges, path);
  }

  if (constraints.patterns) {
    validatePatterns(actual, constraints.patterns, path);
  }

  if (constraints.consistency) {
    constraints.consistency.forEach(rule => rule(actual, path));
  }
}

/**
 * Validate enum fields have allowed values
 */
function validateEnums(actual, enums, path) {
  for (const [field, allowedValues] of Object.entries(enums)) {
    const value = getNestedValue(actual, field);
    if (value !== undefined && !allowedValues.includes(value)) {
      throw new Error(`${path}.${field}: Invalid value "${value}". Must be one of: ${allowedValues.join(', ')}`);
    }
  }
}

/**
 * Validate numeric fields are within valid ranges
 */
function validateRanges(actual, ranges, path) {
  for (const [field, range] of Object.entries(ranges)) {
    const value = getNestedValue(actual, field);
    if (value !== undefined) {
      if (range.min !== undefined && value < range.min) {
        throw new Error(`${path}.${field}: Value ${value} is below minimum ${range.min}`);
      }
      if (range.max !== undefined && value > range.max) {
        throw new Error(`${path}.${field}: Value ${value} is above maximum ${range.max}`);
      }
    }
  }
}

/**
 * Validate string fields match expected patterns
 */
function validatePatterns(actual, patterns, path) {
  for (const [field, pattern] of Object.entries(patterns)) {
    const value = getNestedValue(actual, field);
    if (value !== undefined && !pattern.test(value)) {
      throw new Error(`${path}.${field}: Value "${value}" does not match pattern ${pattern}`);
    }
  }
}

/**
 * Get nested value from object using dot notation
 */
function getNestedValue(obj, path) {
  return path.split('.').reduce((acc, part) => acc?.[part], obj);
}

module.exports = { validateResponseShape, validateResponse };
