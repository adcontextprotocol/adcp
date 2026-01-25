import { createLogger } from '../logger.js';

const logger = createLogger('validation');

/**
 * Result of validating an input field
 */
export interface FieldValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate organization name
 * - Must be 1-100 characters
 * - Must start with alphanumeric character
 * - Can contain letters, numbers, spaces, hyphens, underscores, and apostrophes
 * - Cannot contain consecutive spaces
 * - Cannot be only whitespace
 */
export function validateOrganizationName(name: unknown): FieldValidationResult {
  if (typeof name !== 'string') {
    return { valid: false, error: 'Organization name must be a string' };
  }

  const trimmed = name.trim();

  if (trimmed.length === 0) {
    return { valid: false, error: 'Organization name cannot be empty' };
  }

  if (trimmed.length > 100) {
    return { valid: false, error: 'Organization name must be 100 characters or less' };
  }

  if (trimmed.length < 2) {
    return { valid: false, error: 'Organization name must be at least 2 characters' };
  }

  // Must start with alphanumeric
  if (!/^[a-zA-Z0-9]/.test(trimmed)) {
    return { valid: false, error: 'Organization name must start with a letter or number' };
  }

  // Only allowed characters: letters, numbers, spaces, hyphens, underscores, apostrophes, periods
  if (!/^[a-zA-Z0-9][a-zA-Z0-9\s\-_'.]*$/.test(trimmed)) {
    return {
      valid: false,
      error: 'Organization name can only contain letters, numbers, spaces, hyphens, underscores, apostrophes, and periods',
    };
  }

  // No consecutive spaces
  if (/\s{2,}/.test(trimmed)) {
    return { valid: false, error: 'Organization name cannot contain consecutive spaces' };
  }

  // Check for potentially dangerous patterns (XSS prevention)
  if (/<[^>]*>/.test(trimmed) || /javascript:/i.test(trimmed)) {
    logger.warn({ name: trimmed }, 'Potentially dangerous organization name rejected');
    return { valid: false, error: 'Organization name contains invalid characters' };
  }

  return { valid: true };
}

/**
 * Validate email address
 */
export function validateEmail(email: unknown): FieldValidationResult {
  if (typeof email !== 'string') {
    return { valid: false, error: 'Email must be a string' };
  }

  const trimmed = email.trim().toLowerCase();

  if (trimmed.length === 0) {
    return { valid: false, error: 'Email cannot be empty' };
  }

  // Basic email pattern (not overly strict - let WorkOS do final validation)
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(trimmed)) {
    return { valid: false, error: 'Invalid email format' };
  }

  if (trimmed.length > 254) {
    return { valid: false, error: 'Email address is too long' };
  }

  return { valid: true };
}

/**
 * Sanitize string for safe display (removes potential XSS)
 */
export function sanitizeForDisplay(input: string): string {
  return input
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}
