/**
 * Planning half of the #7830 registry-key rewrite.
 *
 * Pure: it takes the rows a store holds and returns what the rewrite would
 * do, including every class of collision that makes the rewrite unsafe. The
 * script that talks to the database
 * (`migrate-registry-agent-url-keys.ts`) does nothing a plan did not
 * describe, so the dry-run output and the applied writes cannot diverge.
 */
import {
  legacyRegistryAgentUrlKey,
  registryAgentUrlKey,
} from '../db/registry-agent-url-key.js';

export interface KeyedRow {
  /** Stable identifier for the operator: a primary key, or `profile:index`. */
  rowId: string;
  /** The value the new key is computed from. */
  rawUrl: string;
  /** The key the row is stored under today. */
  storedKey: string;
  /**
   * One serialized uniqueness tuple per unique index the key participates
   * in, excluding the key itself. Two rows that share a scope and land on
   * the same key collide. Empty when nothing constrains the key, which is
   * the normal case for history tables that hold many rows per agent.
   */
  scopes: readonly string[];
}

export interface KeyRewrite {
  rowId: string;
  rawUrl: string;
  fromKey: string;
  toKey: string;
}

export interface MergeCollision {
  /** The key two or more rows in one uniqueness scope would land on. */
  key: string;
  scope: string;
  rows: Array<{ rowId: string; rawUrl: string; storedKey: string }>;
}

export interface ChainCollision {
  scope: string;
  /** The key one row is vacating and another is moving onto. */
  key: string;
  vacatedBy: string;
  claimedBy: string;
}

export interface SplitGroup {
  /** The pre-migration key these rows shared. */
  legacyKey: string;
  keys: string[];
  rows: Array<{ rowId: string; rawUrl: string; newKey: string }>;
}

export interface StorePlan {
  store: string;
  rowCount: number;
  /** Rows whose stored key changes. Everything else is already correct. */
  rewrites: KeyRewrite[];
  /**
   * Rows whose URL no longer produces a key at all. Rewriting them is
   * impossible and leaving them strands a row no reader can look up, so an
   * operator has to decide per row. Blocks the apply.
   */
  unkeyable: Array<{ rowId: string; rawUrl: string; storedKey: string }>;
  /** Two live rows landing on one key in one uniqueness scope. Blocks. */
  merges: MergeCollision[];
  /**
   * Rows whose new key is another moving row's current key, in the same
   * uniqueness scope. The post-rewrite state is collision-free, so these
   * are not merges — but Postgres checks a unique index per row, not per
   * statement, so the UPDATE aborts halfway through on a key that only
   * exists transiently. The transaction rolls back, so nothing is
   * destroyed; the cost is an apply that fails after the dry run said go.
   * Blocks, so that failure happens in the dry run instead.
   */
  chains: ChainCollision[];
  /**
   * Rows that shared one pre-migration key and now key differently. The
   * rewrite handles these correctly row by row — each row keeps its own
   * identity — but the group is the evidence that the old key was conflating
   * distinct agents, so whatever ELSE was attached to the old key (ownership,
   * compliance history, credentials) now covers only one of them. Reported,
   * never auto-resolved; does not block.
   */
  splits: SplitGroup[];
  /**
   * Only for stores that overwrote their raw URL with the old key
   * (`rawIsDerived`). Those rows went through the old canonicalizer, so the
   * original path case and trailing slash are gone for good and the
   * recomputed key is the best available answer rather than a provably
   * correct one — if the agent really serves at `/Mcp`, only the publisher's
   * manifest can say so. Listed for every row with a non-root path or a
   * query, which in a healthy registry is most of them; the list is a
   * reconciliation worklist, not a defect count. Does not block.
   */
  lossyRows: Array<{ rowId: string; rawUrl: string; newKey: string }>;
}

/** True when the plan must not be applied without operator action. */
export function planIsBlocked(plan: StorePlan): boolean {
  return plan.unkeyable.length > 0 || plan.merges.length > 0 || plan.chains.length > 0;
}

export function planStoreRewrite(
  store: string,
  rows: KeyedRow[],
  /**
   * True when the store's URL column IS the key — it has no independent raw
   * source to recompute from, so anything the old algorithm destroyed is
   * unrecoverable. False for stores that keep the publisher's raw URL
   * alongside the key.
   */
  rawIsDerived = false,
): StorePlan {
  const rewrites: KeyRewrite[] = [];
  const unkeyable: StorePlan['unkeyable'] = [];
  const lossyRows: StorePlan['lossyRows'] = [];
  const byScopeAndKey = new Map<string, MergeCollision>();
  const byLegacyKey = new Map<string, SplitGroup>();

  const seenRowIds = new Set<string>();
  const scopesByRowId = new Map<string, readonly string[]>();
  for (const row of rows) {
    const newKey = registryAgentUrlKey(row.rawUrl);
    if (newKey === null) {
      unkeyable.push({ rowId: row.rowId, rawUrl: row.rawUrl, storedKey: row.storedKey });
      continue;
    }
    // Callers hand one row per rowId with every scope merged; the guard is
    // belt and braces so a future caller cannot produce duplicate rewrites.
    if (newKey !== row.storedKey && !seenRowIds.has(row.rowId)) {
      seenRowIds.add(row.rowId);
      rewrites.push({
        rowId: row.rowId,
        rawUrl: row.rawUrl,
        fromKey: row.storedKey,
        toKey: newKey,
      });
    }

    scopesByRowId.set(row.rowId, row.scopes);
    // Collision detection runs over the POST-rewrite state, so a scope where
    // one row moves onto another row's existing key counts.
    for (const scope of row.scopes) {
      const collisionId = `${scope}\u0000${newKey}`;
      const collision = byScopeAndKey.get(collisionId)
        ?? { key: newKey, scope, rows: [] };
      collision.rows.push({ rowId: row.rowId, rawUrl: row.rawUrl, storedKey: row.storedKey });
      byScopeAndKey.set(collisionId, collision);
    }

    const legacyKey = legacyRegistryAgentUrlKey(row.rawUrl);
    if (legacyKey !== null) {
      const group = byLegacyKey.get(legacyKey) ?? { legacyKey, keys: [], rows: [] };
      group.rows.push({ rowId: row.rowId, rawUrl: row.rawUrl, newKey });
      if (!group.keys.includes(newKey)) group.keys.push(newKey);
      byLegacyKey.set(legacyKey, group);
    }

    // Only flag the loss where it could matter: a key whose path is more
    // than '/' or that carries a query. A root-served agent's key survives
    // the old algorithm unchanged, so there is nothing to reconcile.
    if (rawIsDerived && newKey !== '*') {
      const { pathname } = new URL(newKey);
      if (pathname !== '/' || newKey.includes('?')) {
        lossyRows.push({ rowId: row.rowId, rawUrl: row.rawUrl, newKey });
      }
    }
  }

  // A chain is only possible where the key is derived from a separate raw
  // column: in a self-keyed store the mover always lands on a row that is
  // itself stable, which is already a merge.
  const chains: ChainCollision[] = [];
  const vacating = new Map<string, KeyRewrite>();
  for (const rewrite of rewrites) {
    for (const scope of scopesByRowId.get(rewrite.rowId) ?? []) {
      vacating.set(`${scope}\u0000${rewrite.fromKey}`, rewrite);
    }
  }
  for (const rewrite of rewrites) {
    for (const scope of scopesByRowId.get(rewrite.rowId) ?? []) {
      const vacated = vacating.get(`${scope}\u0000${rewrite.toKey}`);
      if (vacated === undefined || vacated.rowId === rewrite.rowId) continue;
      chains.push({
        scope,
        key: rewrite.toKey,
        vacatedBy: vacated.rowId,
        claimedBy: rewrite.rowId,
      });
    }
  }

  return {
    store,
    rowCount: rows.length,
    rewrites,
    chains,
    unkeyable,
    merges: [...byScopeAndKey.values()].filter(collision =>
      new Set(collision.rows.map(entry => entry.rowId)).size > 1),
    splits: [...byLegacyKey.values()].filter(group => group.keys.length > 1),
    lossyRows,
  };
}
