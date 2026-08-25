import type { QueryResultRow } from 'pg';
import { getPool, isDatabaseInitialized } from '../db/client.js';
import type { AccountRef } from './types.js';

export interface GovernanceBindingRecord {
  principal: string;
  accountId: string;
  accountScope: string;
  brandDomain: string;
  account: AccountRef;
  agents: Array<{ url: string }>;
  updatedAt: string;
}

export interface GovernanceBindingStore {
  upsert(binding: GovernanceBindingRecord): Promise<void>;
  getByAccountId(principal: string, accountId: string): Promise<GovernanceBindingRecord | null>;
  getByAccountScope(principal: string, accountScope: string): Promise<GovernanceBindingRecord | null>;
  findByBrandDomain(principal: string, brandDomain: string, limit: number): Promise<GovernanceBindingRecord[]>;
}

interface PgQueryable {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

interface GovernanceBindingRow extends QueryResultRow {
  principal_scope: string;
  account_id: string;
  account_scope: string;
  brand_domain: string;
  account_ref: AccountRef | string;
  agents: Array<{ url: string }> | string;
  updated_at: Date | string;
}

function parseJson<T>(value: T | string): T {
  return typeof value === 'string' ? JSON.parse(value) as T : value;
}

function bindingFromRow(row: GovernanceBindingRow): GovernanceBindingRecord {
  const account = parseJson(row.account_ref);
  const agents = parseJson(row.agents);
  if (!Array.isArray(agents) || agents.some(agent => (
    agent === null
    || typeof agent !== 'object'
    || typeof agent.url !== 'string'
  ))) {
    throw new Error('Stored governance-agent binding is malformed.');
  }
  return {
    principal: row.principal_scope,
    accountId: row.account_id,
    accountScope: row.account_scope,
    brandDomain: row.brand_domain,
    account,
    agents: agents.map(agent => ({ url: agent.url })),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const BINDING_COLUMNS = `
  principal_scope, account_id, account_scope, brand_domain,
  account_ref, agents, updated_at
`;

export class PostgresGovernanceBindingStore implements GovernanceBindingStore {
  constructor(private readonly db: PgQueryable) {}

  async upsert(binding: GovernanceBindingRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO governance_agent_bindings (
         principal_scope, account_id, account_scope, brand_domain,
         account_ref, agents, updated_at
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::timestamptz)
       ON CONFLICT (principal_scope, account_id) DO UPDATE SET
         account_scope = EXCLUDED.account_scope,
         brand_domain = EXCLUDED.brand_domain,
         account_ref = EXCLUDED.account_ref,
         agents = EXCLUDED.agents,
         updated_at = EXCLUDED.updated_at`,
      [
        binding.principal,
        binding.accountId,
        binding.accountScope,
        binding.brandDomain,
        JSON.stringify(binding.account),
        JSON.stringify(binding.agents),
        binding.updatedAt,
      ],
    );
  }

  async getByAccountId(principal: string, accountId: string): Promise<GovernanceBindingRecord | null> {
    const { rows } = await this.db.query<GovernanceBindingRow>(
      `SELECT ${BINDING_COLUMNS}
         FROM governance_agent_bindings
        WHERE principal_scope = $1 AND account_id = $2`,
      [principal, accountId],
    );
    return rows[0] ? bindingFromRow(rows[0]) : null;
  }

  async getByAccountScope(principal: string, accountScope: string): Promise<GovernanceBindingRecord | null> {
    const { rows } = await this.db.query<GovernanceBindingRow>(
      `SELECT ${BINDING_COLUMNS}
         FROM governance_agent_bindings
        WHERE principal_scope = $1 AND account_scope = $2`,
      [principal, accountScope],
    );
    return rows[0] ? bindingFromRow(rows[0]) : null;
  }

  async findByBrandDomain(
    principal: string,
    brandDomain: string,
    limit: number,
  ): Promise<GovernanceBindingRecord[]> {
    const { rows } = await this.db.query<GovernanceBindingRow>(
      `SELECT ${BINDING_COLUMNS}
         FROM governance_agent_bindings
        WHERE principal_scope = $1 AND brand_domain = $2
        ORDER BY account_id
        LIMIT $3`,
      [principal, brandDomain, limit],
    );
    return rows.map(bindingFromRow);
  }
}

export class InMemoryGovernanceBindingStore implements GovernanceBindingStore {
  private readonly byAccountId = new Map<string, GovernanceBindingRecord>();
  private readonly byAccountScope = new Map<string, string>();

  private accountKey(principal: string, accountId: string): string {
    return `${principal}\u001F${accountId}`;
  }

  private scopeKey(principal: string, accountScope: string): string {
    return `${principal}\u001F${accountScope}`;
  }

  async upsert(binding: GovernanceBindingRecord): Promise<void> {
    const accountKey = this.accountKey(binding.principal, binding.accountId);
    const prior = this.byAccountId.get(accountKey);
    const conflictingAccountKey = this.byAccountScope.get(
      this.scopeKey(binding.principal, binding.accountScope),
    );
    if (conflictingAccountKey !== undefined && conflictingAccountKey !== accountKey) {
      throw new Error('Governance binding account scope already belongs to another account.');
    }
    if (prior) this.byAccountScope.delete(this.scopeKey(prior.principal, prior.accountScope));
    this.byAccountId.set(accountKey, structuredClone(binding));
    this.byAccountScope.set(this.scopeKey(binding.principal, binding.accountScope), accountKey);
  }

  async getByAccountId(principal: string, accountId: string): Promise<GovernanceBindingRecord | null> {
    const binding = this.byAccountId.get(this.accountKey(principal, accountId));
    return binding ? structuredClone(binding) : null;
  }

  async getByAccountScope(principal: string, accountScope: string): Promise<GovernanceBindingRecord | null> {
    const accountKey = this.byAccountScope.get(this.scopeKey(principal, accountScope));
    const binding = accountKey ? this.byAccountId.get(accountKey) : undefined;
    return binding ? structuredClone(binding) : null;
  }

  async findByBrandDomain(
    principal: string,
    brandDomain: string,
    limit: number,
  ): Promise<GovernanceBindingRecord[]> {
    const matches: GovernanceBindingRecord[] = [];
    for (const binding of this.byAccountId.values()) {
      if (binding.principal !== principal || binding.brandDomain !== brandDomain) continue;
      matches.push(structuredClone(binding));
      if (matches.length >= limit) break;
    }
    return matches;
  }

  clear(): void {
    this.byAccountId.clear();
    this.byAccountScope.clear();
  }
}

const inMemoryStore = new InMemoryGovernanceBindingStore();
let overrideStore: GovernanceBindingStore | null = null;
let postgresStore: GovernanceBindingStore | null = null;

export function governanceBindingStore(): GovernanceBindingStore {
  if (overrideStore) return overrideStore;
  if (!isDatabaseInitialized()) return inMemoryStore;
  postgresStore ??= new PostgresGovernanceBindingStore(getPool());
  return postgresStore;
}

/** Test seam. Production cannot replace the authoritative binding store. */
export function setGovernanceBindingStore(store: GovernanceBindingStore | null): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('setGovernanceBindingStore is not allowed in production');
  }
  overrideStore = store;
}

export function clearInMemoryGovernanceBindings(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('clearInMemoryGovernanceBindings is not allowed in production');
  }
  inMemoryStore.clear();
  overrideStore = null;
}
