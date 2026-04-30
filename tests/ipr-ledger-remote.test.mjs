import { describe, it, expect } from 'vitest';
import { isLedgerRemoteAllowed } from '../scripts/ipr/ledger-remote.mjs';

describe('isLedgerRemoteAllowed', () => {
  // The "must accept" set covers every URL shape that `git remote get-url`
  // can plausibly emit for adcontextprotocol/adcp on github.com — bare
  // (helper-based credentials, actions/checkout@v6 default), embedded
  // credentials (older actions/checkout default), and `.git` / trailing-slash
  // variants of each.
  it.each([
    ['https://github.com/adcontextprotocol/adcp'],
    ['https://github.com/adcontextprotocol/adcp.git'],
    ['https://github.com/adcontextprotocol/adcp/'],
    ['https://github.com/adcontextprotocol/adcp.git/'],
    ['https://x-access-token:TOKEN@github.com/adcontextprotocol/adcp'],
    ['https://x-access-token:TOKEN@github.com/adcontextprotocol/adcp.git'],
    ['https://github.com:443/adcontextprotocol/adcp'],
  ])('accepts %s', (url) => {
    expect(isLedgerRemoteAllowed(url)).toBe(true);
  });

  it.each([
    ['https://github.com/foo/bar', 'wrong repo'],
    ['https://evil.com/adcontextprotocol/adcp', 'wrong host'],
    ['https://attacker.com@evil.com/adcontextprotocol/adcp', 'host-confusion (userinfo carries fake host)'],
    ['git@github.com:adcontextprotocol/adcp.git', 'SSH form'],
    ['http://github.com/adcontextprotocol/adcp', 'plaintext scheme'],
    ['https://github.com/adcontextprotocol/adcp-foo', 'prefix-only path match'],
    ['https://github.com/adcontextprotocol/adcp/foo', 'extra path segment'],
    ['https://github.com:8443/adcontextprotocol/adcp', 'non-default port'],
    ['', 'empty string'],
    ['not-a-url', 'unparseable'],
  ])('rejects %s (%s)', (url) => {
    expect(isLedgerRemoteAllowed(url)).toBe(false);
  });
});
