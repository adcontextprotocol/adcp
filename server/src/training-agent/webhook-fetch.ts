/**
 * SSRF-guarded `fetch` wrapper for outbound webhook deliveries.
 *
 * Callers supply `push_notification_config.url`. Without a guard the training
 * agent would POST signed webhook bodies to whatever URL is provided —
 * including loopback (`127.0.0.1`), link-local (`169.254.169.254` fly/AWS
 * metadata), or RFC1918 private IPs reachable from the container.
 *
 * Two-step guard:
 * 1. Refuse non-`http:`/`https:` URLs outright.
 * 2. Resolve the hostname via DNS. If any resolved address is private,
 *    link-local, loopback, or broadcast, refuse.
 *
 * The DNS lookup happens immediately before `fetch`; a rebinding attack that
 * flips the answer between the check and the connect is theoretically
 * possible but narrower than the primary "caller submits metadata URL"
 * threat. Matches the SSRF pattern already used in `server/src/validator.ts`.
 *
 * `allowPrivateIp: true` is required for conformance storyboards that use
 * `http://127.0.0.1:<port>` loopback receivers. Default in non-production.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class SsrfRefusedError extends Error {
  readonly url: string;
  readonly reason: string;
  constructor(url: string, reason: string) {
    super(`SSRF guard refused webhook delivery to ${url}: ${reason}`);
    this.name = 'SsrfRefusedError';
    this.url = url;
    this.reason = reason;
  }
}

function isPrivateIpv4(address: string): boolean {
  const [a, b] = address.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIpAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) {
    const v = address.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fe80:')) return true;
    if (v.startsWith('fc') || v.startsWith('fd')) return true;        // ULA fc00::/7
    if (v.startsWith('ff')) return true;                               // multicast ff00::/8
    if (v.startsWith('64:ff9b:')) return true;                         // NAT64 well-known
    if (v.startsWith('2001:db8:')) return true;                        // documentation
    // IPv4-mapped (::ffff:a.b.c.d). Node's URL parser canonicalizes to this form.
    const mapped = v.match(/^::ffff:([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)$/);
    if (mapped && isPrivateIpv4(mapped[1])) return true;
    return false;
  }
  return false;
}

/** Reject hostnames that look like numeric-encoded IP addresses. Node's URL
 *  parser accepts `http://2852039166/` and `http://0177.0.0.1/` — `isIP()`
 *  returns 0 for those, but the OS resolver happily decodes them to the
 *  target IP. Blocking bypass requires rejecting anything that isn't a real
 *  DNS name before we fall through to `dns.lookup`. */
function isNumericHostname(hostname: string): boolean {
  if (/^[0-9]+$/.test(hostname)) return true;                          // decimal integer
  if (/^0[xX][0-9a-fA-F]+$/.test(hostname)) return true;               // hex literal
  if (/^[0-9]+(\.[0-9]+){1,3}$/.test(hostname)) return true;           // dotted-numeric (octal / invalid v4)
  return false;
}

async function assertPublicTarget(url: URL): Promise<void> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SsrfRefusedError(url.toString(), `scheme ${url.protocol} not allowed`);
  }
  // `url.hostname` strips brackets from `[::1]` → `::1`. Userinfo (user:pass@)
  // never leaks into hostname per WHATWG, so we don't need to scrub that.
  const hostname = url.hostname;
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new SsrfRefusedError(url.toString(), 'hostname resolves to loopback');
  }
  const version = isIP(hostname);
  if (version !== 0) {
    if (isPrivateIpAddress(hostname)) {
      throw new SsrfRefusedError(url.toString(), 'literal private/loopback address');
    }
    return;
  }
  if (isNumericHostname(hostname)) {
    throw new SsrfRefusedError(url.toString(), 'numeric-encoded hostname not allowed');
  }
  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    if (records.length === 0) {
      throw new SsrfRefusedError(url.toString(), 'hostname did not resolve');
    }
    if (records.some(r => isPrivateIpAddress(r.address))) {
      throw new SsrfRefusedError(url.toString(), 'hostname resolves to private address');
    }
  } catch (err) {
    if (err instanceof SsrfRefusedError) throw err;
    throw new SsrfRefusedError(url.toString(), `DNS lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Build a `fetch`-shaped function gated by the SSRF guard.
 *
 * When `allowPrivateIp` is true the guard is bypassed. That's the right
 * default for dev/CI where conformance storyboards use `http://127.0.0.1:<port>`
 * receivers; it's explicitly the wrong default for production. The returned
 * function always dereferences `globalThis.fetch` lazily so tests that replace
 * the global see their replacement. */
export function createWebhookFetch(options: { allowPrivateIp: boolean }): typeof fetch {
  return async (input, init) => {
    if (!options.allowPrivateIp) {
      const href = typeof input === 'string' || input instanceof URL
        ? input.toString()
        : input.url;
      await assertPublicTarget(new URL(href));
    }
    return globalThis.fetch(input, init);
  };
}
