import { describe, expect, it } from 'vitest';
import { auditAgentUrlKeyMigration, proposedRegistryAgentUrlKey } from '../../src/scripts/agent-url-key-migration-audit.js';

const row = (rawUrl: string, store = 'metadata') => ({ store, rowId: rawUrl, rawUrl });

describe('registry URL migration preflight', () => {
  it('preserves endpoint path case and non-root trailing slashes', () => {
    expect(proposedRegistryAgentUrlKey('HTTPS://Agent.Example/tenants/Acme/mcp/')).toBe('https://agent.example/tenants/Acme/mcp/');
    const audit = auditAgentUrlKeyMigration([
      row('https://agent.example/tenants/Acme/mcp/'),
      row('https://agent.example/tenants/acme/mcp'),
    ]);
    expect(audit.splitCandidates).toHaveLength(1);
    expect(audit.splitCandidates[0].proposedKeys).toHaveLength(2);
    expect(audit.nonRootTrailingSlashRows).toHaveLength(1);
  });

  it('normalizes equivalent URLs and exposes merge candidates', () => {
    const audit = auditAgentUrlKeyMigration([
      row('https://agent.example:443/a/../MCP/%7e#fragment'),
      row('https://agent.example/MCP/~'),
    ]);
    expect(audit.mergeCandidates).toHaveLength(1);
    expect(audit.mergeCandidates[0].proposedKey).toBe('https://agent.example/MCP/~');
    expect(proposedRegistryAgentUrlKey('https://bücher.example')).toBe('https://xn--bcher-kva.example');
  });

  it('retains existing root keys while preserving empty-query identity', () => {
    expect(proposedRegistryAgentUrlKey('https://agent.example/')).toBe('https://agent.example');
    expect(proposedRegistryAgentUrlKey('https://agent.example')).toBe('https://agent.example');
    expect(proposedRegistryAgentUrlKey('https://agent.example?')).toBe('https://agent.example/?');
    expect(proposedRegistryAgentUrlKey('https://agent.example/mcp?')).toBe('https://agent.example/mcp?');
    expect(auditAgentUrlKeyMigration([row('https://agent.example?')]).bareQueryRows).toHaveLength(1);
  });

  it('preserves query bytes and normalizes one DNS root dot', () => {
    expect(proposedRegistryAgentUrlKey('https://agent.example./mcp')).toBe('https://agent.example/mcp');
    expect(proposedRegistryAgentUrlKey('https://agent.example../mcp')).toBeNull();
    expect(proposedRegistryAgentUrlKey('https://agent.example/mcp?x=%7e')).toBe('https://agent.example/mcp?x=%7e');
    const audit = auditAgentUrlKeyMigration([
      row('https://agent.example/mcp?x=%7e'), row('https://agent.example/mcp?x=~'),
    ]);
    expect(audit.mergeCandidates).toHaveLength(0);
  });

  it('keeps the wildcard sentinel and rejects malformed or credential-bearing URLs', () => {
    expect(proposedRegistryAgentUrlKey(' * ')).toBe('*');
    for (const raw of ['', 'https://agent.example/*', 'https://agent.example/a b', 'https://agent.example/a\u0000', 'ftp://agent.example', 'https://user:secret@agent.example', 'https://@agent.example/mcp', 'https://:@agent.example/mcp', 'https:///p', 'https://agent.example\\mcp', 'https://agent.example\\tenants\\Acme/mcp', 'invalid']) {
      expect(proposedRegistryAgentUrlKey(raw)).toBeNull();
    }
  });

  it('compares persisted keys and source manifests to expose lost identities', () => {
    const audit = auditAgentUrlKeyMigration([
      { ...row('https://agent.example/MCP/', 'catalog'), storedKey: 'https://agent.example/mcp' },
      row('https://agent.example/mcp', 'metadata'),
      row('https://agent.example/MCP/', 'manifest'),
    ]);
    expect(audit.changedRows).toHaveLength(1);
    expect(audit.rawSourceRequired).toHaveLength(1);
    expect(audit.splitCandidates).toHaveLength(1);
    expect(audit.splitCandidates[0].candidates).toHaveLength(3);
  });

  it('surfaces invalid stored values without stopping the audit', () => {
    const audit = auditAgentUrlKeyMigration([row('https://agent.example/mcp'), row('invalid')]);
    expect(audit.invalidRows).toHaveLength(1);
    expect(audit.rowCount).toBe(2);
  });

  it('requires source verification for already lowercased root queries', () => {
    const audit = auditAgentUrlKeyMigration([row('https://agent.example/?token=abc')]);
    expect(audit.rawSourceRequired).toHaveLength(1);
  });
});
