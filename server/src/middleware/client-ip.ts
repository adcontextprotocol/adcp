import { BlockList, isIP } from 'node:net';
import type { RequestHandler } from 'express';

// Fly's HTTP proxy connects over the private network (or local loopback).
// The environment flag alone must not let a public peer supply these headers.
const flyProxyPeers = new BlockList();
flyProxyPeers.addSubnet('fdaa::', 16, 'ipv6');
flyProxyPeers.addAddress('127.0.0.1', 'ipv4');
flyProxyPeers.addAddress('::1', 'ipv6');

// Cloudflare's published edge ranges, checked 2026-10-02:
// https://www.cloudflare.com/ips-v4/ and https://www.cloudflare.com/ips-v6/
// New ranges fail back to Fly-Client-IP until this list is updated.
const cloudflarePeers = new BlockList();
for (const subnet of [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22',
  '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22',
  '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32',
  '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
]) {
  const [address, prefix] = subnet.split('/');
  cloudflarePeers.addSubnet(address, Number(prefix), isIP(address) === 4 ? 'ipv4' : 'ipv6');
}

function parseIp(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const ip = value.trim();
  // Scope IDs are meaningful only on the local interface, never in client headers.
  return !ip.includes('%') && isIP(ip) ? ip : undefined;
}

function includes(blockList: BlockList, ip: string): boolean {
  return blockList.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Restore the client address before any IP-based limiter runs.
 *
 * Fly appends the app's shared/dedicated address to X-Forwarded-For; with
 * trust proxy = 1, Express selects that address and pools callers together.
 * Fly-Client-IP is the authoritative immediate upstream. Only a verified
 * Cloudflare upstream can supply the original CF-Connecting-IP address.
 * https://docs.fly.io/networking/request-headers
 * https://developers.cloudflare.com/fundamentals/reference/http-headers/
 */
export const restoreClientIp: RequestHandler = (req, _res, next) => {
  const peer = parseIp(req.socket.remoteAddress);
  if (process.env.FLY_APP_NAME && peer && includes(flyProxyPeers, peer)) {
    const upstream = parseIp(req.headers['fly-client-ip']);
    if (upstream) {
      const cloudflareClient = includes(cloudflarePeers, upstream)
        ? parseIp(req.headers['cf-connecting-ip']) : undefined;
      Object.defineProperty(req, 'ip', { value: cloudflareClient ?? upstream, configurable: true });
    }
  }
  next();
};
