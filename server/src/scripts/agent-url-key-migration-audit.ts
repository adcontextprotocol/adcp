import { canonicalTargetUri } from '@adcp/sdk/signing';

/** Frozen pre-migration algorithm so before/after reports stay comparable. */
function legacyRegistryAgentUrlKey(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '*') return '*';
  if (!trimmed || trimmed.includes('*') || /[\s\x00-\x1f]/.test(trimmed)) return null;
  const lower = trimmed.toLowerCase();
  let end = lower.length;
  while (end > 0 && lower[end - 1] === '/') end -= 1;
  return lower.slice(0, end) || null;
}

/** Candidate keys only: live readers and writers retain their current semantics. */
export function proposedRegistryAgentUrlKey(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '*') return '*';
  if (!trimmed || trimmed.includes('*') || trimmed.includes('\\') || /[\s\x00-\x1f\x7f]/.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (!['https:', 'http:'].includes(url.protocol) || !trimmed.includes('://') || url.username || url.password) return null;
    // The SDK accepts ASCII URI authorities; WHATWG URL supplies the IDN
    // A-label first. Preserve the original path/query bytes for SDK handling.
    const authorityStart = trimmed.indexOf('://') + 3;
    const suffixOffset = trimmed.slice(authorityStart).search(/[/?#]/);
    if (suffixOffset === 0) return null;
    const authority = trimmed.slice(authorityStart, suffixOffset < 0 ? undefined : authorityStart + suffixOffset);
    if (authority.includes('@')) return null;
    const suffix = suffixOffset < 0 ? '' : trimmed.slice(authorityStart + suffixOffset);
    const canonical = canonicalTargetUri(`${url.protocol}//${url.host}${suffix}`, '3.2');
    // Root-served registry agents keep their existing key when there is no query.
    const parsed = new URL(canonical);
    return parsed.pathname === '/' && !canonical.includes('?') ? canonical.slice(0, -1) : canonical;
  } catch {
    return null;
  }
}

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
    proposedKey: proposedRegistryAgentUrlKey(row.rawUrl),
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
    nonRootTrailingSlashRows: entries.filter(row => {
      if (!row.proposedKey || row.proposedKey === '*') return false;
      const path = new URL(row.proposedKey).pathname;
      return path !== '/' && path.endsWith('/');
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
