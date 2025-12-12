import freeEmailDomains from 'free-email-domains';

// Convert the free-email-domains list to a Set for O(1) lookups
const freeDomainsSet = new Set(freeEmailDomains);

/**
 * Extract domain from email address
 */
export function getEmailDomain(email: string): string | null {
  const parts = email.split('@');
  if (parts.length !== 2) {
    return null;
  }
  return parts[1].toLowerCase();
}

/**
 * Check if an email domain is a free/personal email provider
 * (gmail.com, yahoo.com, hotmail.com, etc.)
 */
export function isFreeEmailDomain(domain: string): boolean {
  return freeDomainsSet.has(domain.toLowerCase());
}

/**
 * Check if an email is from a free/personal email provider
 */
export function isFreeEmail(email: string): boolean {
  const domain = getEmailDomain(email);
  if (!domain) {
    return false;
  }
  return isFreeEmailDomain(domain);
}

/**
 * Check if an email is from a company/work email domain
 */
export function isCompanyEmail(email: string): boolean {
  return !isFreeEmail(email);
}

/**
 * Get company domain from email, or null if it's a free email provider
 */
export function getCompanyDomain(email: string): string | null {
  const domain = getEmailDomain(email);
  if (!domain || isFreeEmailDomain(domain)) {
    return null;
  }
  return domain;
}
