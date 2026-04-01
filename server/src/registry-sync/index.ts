/**
 * RegistrySync — in-memory replica of the AdCP registry.
 *
 * Bootstraps from the server API, then polls the change feed to stay current.
 * Exposes local indexes for zero-latency lookups:
 *
 *   registry.agents.search({ channels: ['ctv'], markets: ['US'] })
 *   registry.authorizations.check({ agent_url, property_rid, placement_id })
 *   registry.properties.getByRid(rid)
 *
 * Usage:
 *   const registry = new RegistrySync({ apiKey: '...', baseUrl: 'https://agenticadvertising.org' });
 *   await registry.start();
 *   // ... use registry.agents, registry.properties, registry.authorizations
 *   registry.stop();
 */

import { EventEmitter } from 'node:events';
import { AgentIndex, type AgentProfile } from './agent-index.js';
import { CatalogPropertyIndex, type CatalogProperty } from './property-index.js';
import { AuthorizationIndex, type AuthorizationEntry } from './authorization-index.js';
import { FeedPoller } from './poller.js';
import type { CatalogEvent } from '../db/catalog-events-db.js';

// ─── Config ──────────────────────────────────────────────────────────────────

export type IndexName = 'agents' | 'properties' | 'authorizations';

export interface RegistrySyncConfig {
  apiKey: string;
  baseUrl?: string;
  pollIntervalMs?: number;
  persistCursor?: boolean;
  cursorPath?: string;
  onError?: (err: Error) => void;
  types?: string[];
  indexes?: IndexName[];
  bootstrap?: { mode: 'full' };
}

// ─── RegistrySync ────────────────────────────────────────────────────────────

export class RegistrySync extends EventEmitter {
  readonly agents?: AgentIndex;
  readonly properties?: CatalogPropertyIndex;
  readonly authorizations?: AuthorizationIndex;

  private poller: FeedPoller;
  private enabledIndexes: Set<IndexName>;

  constructor(config: RegistrySyncConfig) {
    super();

    const enabledIndexes = new Set<IndexName>(config.indexes ?? ['agents', 'properties', 'authorizations']);
    this.enabledIndexes = enabledIndexes;

    // Create indexes based on config
    if (enabledIndexes.has('properties')) {
      this.properties = new CatalogPropertyIndex();
    }
    if (enabledIndexes.has('agents')) {
      this.agents = new AgentIndex();
    }
    if (enabledIndexes.has('authorizations')) {
      this.authorizations = new AuthorizationIndex(this.properties);
    }

    this.poller = new FeedPoller(
      {
        apiKey: config.apiKey,
        baseUrl: config.baseUrl ?? 'https://agenticadvertising.org',
        pollIntervalMs: config.pollIntervalMs ?? 30_000,
        types: config.types,
        persistCursor: config.persistCursor ?? false,
        cursorPath: config.cursorPath,
        onError: config.onError ?? ((err) => this.emit('error', err)),
      },
      {
        onEvents: (events) => this.applyEvents(events),
        onBootstrapAgents: (agents) => this.bootstrapAgents(agents),
        onBootstrapProperties: (properties) => this.bootstrapProperties(properties),
      }
    );
  }

  async start(): Promise<void> {
    await this.poller.start();
    this.emit('ready');
  }

  stop(): void {
    this.poller.stop();
    this.emit('stopped');
  }

  isRunning(): boolean {
    return this.poller.isRunning();
  }

  // ── Bootstrap ───────────────────────────────────────────────────

  private bootstrapAgents(rawAgents: unknown[]): void {
    if (!this.agents) return;

    for (const raw of rawAgents) {
      const agent = raw as AgentProfile;
      if (agent.agent_url) {
        this.agents.upsert(agent);
      }
    }

    this.emit('agents:bootstrapped', { count: this.agents.size });
  }

  private bootstrapProperties(rawProperties: unknown[]): void {
    if (!this.properties) return;

    for (const raw of rawProperties) {
      const prop = raw as CatalogProperty;
      if (prop.property_rid) {
        this.properties.upsert(prop);
      }
    }

    this.emit('properties:bootstrapped', { count: this.properties.size });
  }

  // ── Event application ───────────────────────────────────────────

  private applyEvents(events: CatalogEvent[]): void {
    for (const event of events) {
      this.applyEvent(event);
      this.emit(event.event_type, event);
    }
  }

  private applyEvent(event: CatalogEvent): void {
    const payload = event.payload as Record<string, unknown>;

    switch (event.event_type) {
      case 'agent.discovered':
        if (this.agents && payload.agent_url) {
          this.agents.upsert({
            agent_url: payload.agent_url as string,
            channels: (payload.channels as string[]) ?? [],
            property_types: (payload.property_types as string[]) ?? [],
            markets: (payload.markets as string[]) ?? [],
            categories: (payload.categories as string[]) ?? [],
            tags: (payload.tags as string[]) ?? [],
            delivery_types: (payload.delivery_types as string[]) ?? [],
            format_ids: [],
            property_count: (payload.property_count as number) ?? 0,
            publisher_count: (payload.publisher_count as number) ?? 0,
            has_tmp: (payload.has_tmp as boolean) ?? false,
            category_taxonomy: null,
            updated_at: event.created_at.toString(),
          });
        }
        break;

      case 'agent.removed':
        if (this.agents && payload.agent_url) {
          this.agents.remove(payload.agent_url as string);
        }
        if (this.authorizations && payload.agent_url) {
          this.authorizations.removeAgent(payload.agent_url as string);
        }
        break;

      case 'property.created':
        if (this.properties && payload.property_rid) {
          this.properties.upsert({
            property_rid: payload.property_rid as string,
            identifiers: (payload.identifiers as Array<{ type: string; value: string }>) ?? [],
            classification: (payload.classification as string) ?? 'property',
            publisher_domain: payload.publisher_domain as string | undefined,
          });
        }
        break;

      case 'property.updated':
        if (this.properties && payload.property_rid) {
          const existing = this.properties.getByRid(payload.property_rid as string);
          if (existing) {
            this.properties.upsert({
              ...existing,
              ...(payload as Partial<CatalogProperty>),
            });
          }
        }
        break;

      case 'property.merged':
        if (this.properties && payload.alias_rid && payload.canonical_rid) {
          this.properties.handleMerge(
            payload.alias_rid as string,
            payload.canonical_rid as string,
          );
        }
        break;

      case 'authorization.granted':
        if (this.authorizations && payload.agent_url && payload.publisher_domain && payload.authorization_type) {
          this.authorizations.addEntry({
            agent_url: payload.agent_url as string,
            publisher_domain: payload.publisher_domain as string,
            authorization_type: payload.authorization_type as string,
            authorized_for: payload.authorized_for as string | undefined,
            property_ids: payload.property_ids as string[] | undefined,
            property_tags: payload.property_tags as string[] | undefined,
            placement_ids: payload.placement_ids as string[] | undefined,
            placement_tags: payload.placement_tags as string[] | undefined,
            collections: payload.collections as Array<{ publisher_domain: string; collection_id: string }> | undefined,
            countries: payload.countries as string[] | undefined,
            delegation_type: payload.delegation_type as string | undefined,
            exclusive: payload.exclusive as boolean | undefined,
            effective_from: payload.effective_from as string | undefined,
            effective_until: payload.effective_until as string | undefined,
            signing_keys: payload.signing_keys as AuthorizationEntry['signing_keys'],
          });
        }
        break;

      case 'authorization.revoked':
        if (this.authorizations && payload.agent_url && payload.publisher_domain) {
          this.authorizations.removeEntry(
            payload.agent_url as string,
            payload.publisher_domain as string,
          );
        }
        break;
    }
  }
}

// Re-exports
export { AgentIndex, type AgentProfile, type AgentSearchQuery, type AgentSearchResult } from './agent-index.js';
export { CatalogPropertyIndex, type CatalogProperty } from './property-index.js';
export {
  AuthorizationIndex,
  type AuthorizationEntry,
  type AuthorizationQuery,
  type AuthorizationResult,
  type SigningKey,
} from './authorization-index.js';
