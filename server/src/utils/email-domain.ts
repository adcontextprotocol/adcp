import freeEmailDomains from 'free-email-domains';

// Convert the free-email-domains list to a Set for O(1) lookups
const freeDomainsSet = new Set(freeEmailDomains);

/**
 * Google treats these domains as interchangeable aliases for the same mailbox.
 * `googlemail.com` was the default in several countries (e.g. Germany, UK)
 * before Google secured the `gmail.com` trademark there.
 */
const GMAIL_ALIASES = new Set(['googlemail.com', 'googlemail.co.uk']);

/**
 * Normalize an email address so that known provider aliases resolve to
 * the same canonical form. Currently handles Google's domain aliases
 * (googlemail.com → gmail.com).
 *
 * Returns the email lowercased with the domain replaced if it matches
 * a known alias, or simply lowercased if not.
 */
export function normalizeEmail(email: string): string {
  const lower = email.toLowerCase().trim();
  const atIdx = lower.lastIndexOf('@');
  if (atIdx < 0) return lower;

  const local = lower.slice(0, atIdx);
  const domain = lower.slice(atIdx + 1);

  if (GMAIL_ALIASES.has(domain)) {
    return `${local}@gmail.com`;
  }
  return lower;
}

/**
 * Returns all Google email alias variants for the given address, excluding
 * the address itself. Returns an empty array for non-Google addresses.
 *
 *   twiegle@googlemail.com → [twiegle@gmail.com, twiegle@googlemail.co.uk]
 *   twiegle@gmail.com      → [twiegle@googlemail.com, twiegle@googlemail.co.uk]
 */
const ALL_GOOGLE_DOMAINS = ['gmail.com', ...GMAIL_ALIASES];

export function getGoogleEmailAliases(email: string): string[] {
  const lower = email.toLowerCase().trim();
  const atIdx = lower.lastIndexOf('@');
  if (atIdx < 0) return [];

  const local = lower.slice(0, atIdx);
  const domain = lower.slice(atIdx + 1);

  if (domain === 'gmail.com' || GMAIL_ALIASES.has(domain)) {
    return ALL_GOOGLE_DOMAINS.filter(d => d !== domain).map(d => `${local}@${d}`);
  }
  return [];
}

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
