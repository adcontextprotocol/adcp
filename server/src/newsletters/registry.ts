/**
 * Newsletter Registry
 *
 * Central registry of all configured newsletters. Each newsletter registers
 * itself on import, and the shared infrastructure looks up configs by ID.
 */

import type { NewsletterConfig } from './config.js';

const newsletters = new Map<string, NewsletterConfig>();

export function registerNewsletter(config: NewsletterConfig): void {
  if (newsletters.has(config.id)) {
    throw new Error(`Newsletter "${config.id}" is already registered`);
  }
  newsletters.set(config.id, config);
}

export function getNewsletter(id: string): NewsletterConfig | undefined {
  return newsletters.get(id);
}

export function getAllNewsletters(): NewsletterConfig[] {
  return Array.from(newsletters.values());
}

export function getNewsletterOrThrow(id: string): NewsletterConfig {
  const config = newsletters.get(id);
  if (!config) {
    throw new Error(`Newsletter "${id}" not found. Registered: ${Array.from(newsletters.keys()).join(', ')}`);
  }
  return config;
}
