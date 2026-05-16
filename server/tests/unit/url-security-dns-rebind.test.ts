import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LookupAddress } from 'dns';

// Mock dns.lookup BEFORE importing the module under test so the
// `import { lookup as dnsLookup }` binding picks up the spy.
vi.mock('dns', async () => {
  const actual = await vi.importActual<typeof import('dns')>('dns');
  return {
    ...actual,
    default: actual,
    lookup: vi.fn(),
  };
});

import { lookup as dnsLookup } from 'dns';
import { ssrfSafeLookup, isPrivateHostname } from '../../src/utils/url-security.js';

type LookupCallback = (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void;
type LookupSingleCallback = (err: NodeJS.ErrnoException | null, address: string, family: number) => void;

describe('ssrfSafeLookup', () => {
  const lookupMock = dnsLookup as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    lookupMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects when the OS resolver returns a private IPv4 (DNS rebind defence)', async () => {
    // Simulate a hostile authoritative server: hostname looks public, but at
    // connect time the resolver hands back AWS metadata's 169.254.169.254.
    lookupMock.mockImplementation((_host: string, _opts: unknown, cb: LookupCallback) => {
      cb(null, [{ address: '169.254.169.254', family: 4 }]);
    });

    const err = await new Promise<Error | null>((resolve) => {
      ssrfSafeLookup('attacker.example.com', { all: true } as never, (e) => resolve(e));
    });

    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/private or internal IP/i);
  });

  it('rejects RFC1918 10.0.0.0/8', async () => {
    lookupMock.mockImplementation((_host: string, _opts: unknown, cb: LookupCallback) => {
      cb(null, [{ address: '10.0.0.5', family: 4 }]);
    });

    const err = await new Promise<Error | null>((resolve) => {
      ssrfSafeLookup('victim.example.com', { all: true } as never, (e) => resolve(e));
    });

    expect(err).toBeInstanceOf(Error);
  });

  it('rejects loopback 127.0.0.1', async () => {
    lookupMock.mockImplementation((_host: string, _opts: unknown, cb: LookupCallback) => {
      cb(null, [{ address: '127.0.0.1', family: 4 }]);
    });

    const err = await new Promise<Error | null>((resolve) => {
      ssrfSafeLookup('victim.example.com', { all: true } as never, (e) => resolve(e));
    });

    expect(err).toBeInstanceOf(Error);
  });

  it('rejects when every returned address is private (multi-record bypass)', async () => {
    lookupMock.mockImplementation((_host: string, _opts: unknown, cb: LookupCallback) => {
      cb(null, [
        { address: '127.0.0.1', family: 4 },
        { address: '10.5.5.5', family: 4 },
        { address: '::1', family: 6 },
      ]);
    });

    const err = await new Promise<Error | null>((resolve) => {
      ssrfSafeLookup('multi.example.com', { all: true } as never, (e) => resolve(e));
    });

    expect(err).toBeInstanceOf(Error);
  });

  it('passes through a public IP address (singleton callback form)', async () => {
    lookupMock.mockImplementation((_host: string, _opts: unknown, cb: LookupCallback) => {
      cb(null, [{ address: '93.184.216.34', family: 4 }]);
    });

    const result = await new Promise<{ err: Error | null; addr: unknown }>((resolve) => {
      // No `all: true`: undici's connector wants the singleton form.
      ssrfSafeLookup('example.com', {} as never, ((err, addr) => {
        resolve({ err, addr });
      }) as unknown as LookupSingleCallback);
    });

    expect(result.err).toBeNull();
    expect(result.addr).toBe('93.184.216.34');
  });

  it('filters private addresses out of an array, keeps public ones', async () => {
    lookupMock.mockImplementation((_host: string, _opts: unknown, cb: LookupCallback) => {
      cb(null, [
        { address: '10.0.0.5', family: 4 }, // private
        { address: '93.184.216.34', family: 4 }, // public
      ]);
    });

    const result = await new Promise<{ err: Error | null; addr: unknown }>((resolve) => {
      ssrfSafeLookup('mixed.example.com', { all: true } as never, ((err, addrs) => {
        resolve({ err, addr: addrs });
      }) as LookupCallback);
    });

    expect(result.err).toBeNull();
    expect(result.addr).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('rejects an IP literal hostname pointing to a private range without resolving', async () => {
    const err = await new Promise<Error | null>((resolve) => {
      ssrfSafeLookup('169.254.169.254', { all: true } as never, (e) => resolve(e));
    });

    expect(err).toBeInstanceOf(Error);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('propagates resolver errors without consulting isPrivateHostname', async () => {
    const dnsErr = Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    lookupMock.mockImplementation((_host: string, _opts: unknown, cb: LookupCallback) => {
      cb(dnsErr, []);
    });

    const err = await new Promise<Error | null>((resolve) => {
      ssrfSafeLookup('nx.example.com', { all: true } as never, (e) => resolve(e));
    });

    expect(err).toBe(dnsErr);
  });
});

describe('isPrivateHostname (regression coverage for the surfaces ssrfSafeLookup relies on)', () => {
  it.each([
    ['127.0.0.1'],
    ['10.0.0.5'],
    ['172.16.0.1'],
    ['172.31.255.255'],
    ['192.168.1.1'],
    ['169.254.169.254'],
    ['100.64.0.1'],
    ['0.0.0.0'],
    ['::1'],
    ['fe80::1'],
    ['fc00::1'],
    ['localhost'],
    ['internal.local'],
    ['svc.internal'],
    ['::ffff:127.0.0.1'],
  ])('flags %s as private', (host) => {
    expect(isPrivateHostname(host)).toBe(true);
  });

  // IPv6 shorthands that previously bypassed because the literal-string check
  // (`hostname === '::1'`) didn't match expanded / zero-padded forms, and
  // because the `startsWith('fc00:')` / `startsWith('fe80:')` prefixes only
  // covered one address out of each /7 or /10 block.
  it.each([
    ['0:0:0:0:0:0:0:1'],          // expanded ::1
    ['0000:0000:0000:0000:0000:0000:0000:0001'], // fully zero-padded ::1
    ['0:0:0:0:0:0:0:0'],          // expanded ::
    ['0:0:0:0:0:ffff:7f00:1'],    // expanded ::ffff:127.0.0.1
    ['fe81::1'],                  // fe80::/10 — second address in block
    ['febf::1'],                  // fe80::/10 — last address in block
    ['fc12::1'],                  // fc00::/7 ULA — middle of block
    ['fdff::1'],                  // fc00::/7 ULA — last address in block
    ['fec0::1'],                  // fec0::/10 deprecated site-local
    ['feff::1'],                  // fec0::/10 last address
    ['fe80::1%eth0'],             // zone-id stripped before classification
  ])('flags %s as private (IPv6 canonicalization)', (host) => {
    expect(isPrivateHostname(host)).toBe(true);
  });

  it.each([
    ['93.184.216.34'],
    ['172.66.147.243'], // outside 172.16/12, public
    ['8.8.8.8'],
    ['example.com'],
    ['2001:4860:4860::8888'],     // public IPv6 (Google DNS) — must not match private blocks
    ['ff00::1'],                  // multicast — not private, separate concern
  ])('does not flag %s as private', (host) => {
    expect(isPrivateHostname(host)).toBe(false);
  });
});
