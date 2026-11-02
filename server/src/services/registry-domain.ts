import { isIP } from 'node:net';

// Validate the received value before any convenience normalization can hide a
// pasted URL. Keep hostname syntax aligned with core/identifier.json.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_TLDS = new Set(['example', 'test', 'invalid', 'localhost', 'local', 'onion']);
const EXAMPLE_DOMAINS = ['example.com', 'example.net', 'example.org'];

export function isRegistryDomain(value: string, options: { sandbox?: boolean; wildcard?: boolean } = {}): boolean {
  const hostname = options.wildcard && value.startsWith('*.') ? value.slice(2) : value;
  if (hostname.length > 253 || isIP(hostname)) return false;
  const labels = hostname.split('.');
  if (labels.length < 2 || !labels.every(label => LABEL.test(label))) return false;
  if (options.sandbox) return true;
  return !RESERVED_TLDS.has(labels.at(-1)!)
    && !EXAMPLE_DOMAINS.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
}
