/**
 * Collision classes for the #7830 registry-key migration.
 *
 * Both algorithms now come from the shared helper: `registryAgentUrlKey` is
 * what every reader and writer computes after this change, and
 * `legacyRegistryAgentUrlKey` is the frozen pre-migration form, so before /
 * after reports stay comparable and the audit can never drift from the code
 * the migration actually runs.
 */
import {
  legacyRegistryAgentUrlKey,
  registryAgentUrlKey,
} from '../db/registry-agent-url-key.js';

/**
 * Historical name for the registry key, kept so the read-only audit script
 * and its tests keep reading as "what the migration would produce".
 */
export const proposedRegistryAgentUrlKey = registryAgentUrlKey;

export interface AgentUrlAuditRow {
  store: string;
  rowId: string;
  rawUrl: string;
  storedKey?: string;
}

export function auditAgentUrlKeyMigration(rows: AgentUrlAuditRow[]) {
  const entries = rows.map(row => ({
    ...row,
    legacyKey: legacyRegistryAgentUrlKey(row.rawUrl),
    proposedKey: registryAgentUrlKey(row.rawUrl),
  }));
  const groupBy = (field: 'legacyKey' | 'proposedKey') => {
    const groups = new Map<string, typeof entries>();
    for (const entry of entries) {
      const key = entry[field];
      if (key === null) continue;
      const group = groups.get(key) ?? [];
      group.push(entry);
      groups.set(key, group);
    }
    return [...groups.entries()];
  };
  const splits = groupBy('legacyKey').flatMap(([legacyKey, candidates]) => {
    const proposedKeys = [...new Set(candidates.map(row => row.proposedKey).filter(key => key !== null))];
    return proposedKeys.length > 1 ? [{ legacyKey, proposedKeys, candidates }] : [];
  });
  const merges = groupBy('proposedKey').flatMap(([proposedKey, candidates]) => {
    const legacyKeys = [...new Set(candidates.map(row => row.legacyKey).filter(key => key !== null))];
    return legacyKeys.length > 1 ? [{ proposedKey, legacyKeys, candidates }] : [];
  });
  return {
    rowCount: rows.length,
    // Rows whose raw URL carries a trailing slash the key folds away. These
    // are the identity merges, and they are also the rows whose registered
    // spelling has to be preserved for spec-exact authorization matching
    // (#7829) — see declaredAgentUrl.
    trailingSlashFoldedRows: entries.filter(row => {
      if (row.proposedKey === null || row.proposedKey === '*') return false;
      const path = row.rawUrl.trim().split('#', 1)[0].split('?', 1)[0];
      return path.endsWith('/');
    }),
    bareQueryRows: entries.filter(row => row.rawUrl.split('#', 1)[0].endsWith('?')),
    invalidRows: entries.filter(row => row.proposedKey === null),
    changedRows: entries.filter(row => row.proposedKey !== null && (row.storedKey ?? row.rawUrl) !== row.proposedKey),
    splitCandidates: splits,
    mergeCandidates: merges,
    // Already normalized keys cannot recover lost path case/trailing slashes.
    rawSourceRequired: entries.filter(row => row.proposedKey && row.proposedKey !== '*'
      && row.rawUrl === row.legacyKey
      && (new URL(row.proposedKey).pathname !== '/' || row.rawUrl.includes('?'))),
  };
}
