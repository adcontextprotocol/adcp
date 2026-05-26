/**
 * SSRF-guarded `fetch` wrapper for outbound webhook deliveries.
 *
 * Callers supply `push_notification_config.url`. Without a guard the training
 * agent would POST signed webhook bodies to whatever URL is provided —
 * including loopback (`127.0.0.1`), link-local (`169.254.169.254` fly/AWS
 * metadata), or RFC1918 private IPs reachable from the container.
 *
 * Implements steps 1–4 of `docs/building/by-layer/L1/security.mdx#webhook-url-validation-ssrf`:
 *
 * 1. Refuse non-`http:`/`https:` URLs outright.
 * 2. Resolve the hostname via DNS. If any resolved address is private,
 *    link-local, loopback, or broadcast, refuse.
 * 3. Pin the TCP connect to the validated IP via an undici dispatcher whose
 *    `connect.lookup` hook re-checks the resolved IP at dial time. Closes
 *    the DNS-rebinding window between hostname validation and the actual
 *    connect: a hostile authoritative server cannot return a public IP at
 *    validation and a private IP at fetch time.
 * 4. Set `redirect: 'manual'` so a 30x to `169.254.169.254` or any other
 *    reserved address cannot bypass the IP-range check on the original URL.
 *    3xx responses are returned to the caller as-is — the emitter treats
 *    them as a delivery failure (per its existing non-2xx handling), and
 *    receivers wanting to relocate their endpoint must re-register, not
 *    redirect.
 *
 * `allowPrivateIp: true` is required for conformance storyboards that use
 * `http://127.0.0.1:<port>` loopback receivers; it bypasses steps 2 and 3
 * but **not** step 4 — the no-follow redirect contract holds in every
 * environment, since redirect-follow is a security guard, not a routing
 * affordance.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { type Dispatcher } from 'undici';
import { buildSsrfSafeDispatcher } from '../utils/url-security.js';

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

export async function assertPublicTarget(url: URL): Promise<void> {
  // Scheme refusal is handled by the wrapper before this is called (so it
  // applies unconditionally, including under `allowPrivateIp: true`). By the
  // time we get here the URL is already known to be http(s).
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
 * When `allowPrivateIp` is true the hostname/connect guard is bypassed
 * (steps 2–3). That's the right default for dev/CI where conformance
 * storyboards use `http://127.0.0.1:<port>` receivers; it's explicitly
 * the wrong default for production. Step 1 (scheme refusal) and step 4
 * (`redirect: 'manual'`) hold in every environment — redirect-follow is
 * a security guard, not a routing affordance.
 *
 * The returned function always dereferences `globalThis.fetch` lazily
 * so tests that replace the global see their replacement. */
export function createWebhookFetch(options: { allowPrivateIp: boolean }): typeof fetch {
  return async (input, init) => {
    const href = typeof input === 'string' || input instanceof URL
      ? input.toString()
      : input.url;
    const url = new URL(href);
    // Step 1 (scheme refusal) is unconditional even under allowPrivateIp —
    // a sandbox loopback receiver always uses http/https.
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new SsrfRefusedError(url.toString(), `scheme ${url.protocol} not allowed`);
    }
    if (!options.allowPrivateIp) {
      // Step 2: pre-flight hostname + DNS check. Catches literal private
      // IPs and numeric-encoded bypasses (`http://2852039166/`) before
      // we even open a socket.
      await assertPublicTarget(url);
    }
    // Step 4 (no redirect-follow) and step 3 (connect-time IP recheck via
    // the dispatcher) both apply on the fetch call itself. Manual redirect
    // mode returns the 3xx response to the caller as-is rather than chasing
    // the Location header — the emitter's existing non-2xx handling then
    // treats the 3xx as a delivery failure.
    const dispatcher = options.allowPrivateIp ? undefined : buildSsrfSafeDispatcher();
    // `dispatcher` is the standard escape hatch for undici-on-Node.fetch but is
    // not typed on Node's `RequestInit` (the userland `undici` and Node's bundled
    // `undici-types` are type-incompatible copies). Cast at the call site —
    // same pattern as `safeFetch` in `utils/url-security.ts`.
    return globalThis.fetch(input, {
      ...(init ?? {}),
      redirect: 'manual',
      dispatcher,
    } as RequestInit & { dispatcher?: Dispatcher });
  };
}
