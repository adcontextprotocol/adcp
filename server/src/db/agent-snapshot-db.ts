import { query } from './client.js';
import { createLogger } from '../logger.js';
import type { AgentHealth, AgentStats } from '../types.js';
import type {
  AgentCapabilityProfile,
  StandardOperations,
  CreativeCapabilities,
  SignalsCapabilities,
  ToolCapability,
} from '../capabilities.js';

const logger = createLogger('agent-snapshot-db');

export interface AgentHealthSnapshotRow {
  agent_url: string;
  online: boolean;
  response_time_ms: number | null;
  tools_count: number | null;
  resources_count: number | null;
  error: string | null;
  checked_at: Date;
  stats_json: AgentStats | null;
  updated_at: Date;
}

export interface AgentCapabilitiesSnapshotRow {
  agent_url: string;
  protocol: 'mcp' | 'a2a';
  discovered_tools_json: ToolCapability[];
  standard_operations_json: StandardOperations | null;
  creative_capabilities_json: CreativeCapabilities | null;
  signals_capabilities_json: SignalsCapabilities | null;
  inferred_type: string | null;
  discovery_error: string | null;
  oauth_required: boolean;
  last_discovered: Date;
  updated_at: Date;
}

export class AgentSnapshotDatabase {
  async bulkGetHealth(agentUrls: string[]): Promise<Map<string, AgentHealthSnapshotRow>> {
    if (agentUrls.length === 0) return new Map();
    const result = await query<AgentHealthSnapshotRow>(
      `SELECT * FROM agent_health_snapshot WHERE agent_url = ANY($1)`,
      [agentUrls],
    );
    const map = new Map<string, AgentHealthSnapshotRow>();
    for (const row of result.rows) map.set(row.agent_url, row);
    return map;
  }

  async bulkGetCapabilities(
    agentUrls: string[],
  ): Promise<Map<string, AgentCapabilitiesSnapshotRow>> {
    if (agentUrls.length === 0) return new Map();
    const result = await query<AgentCapabilitiesSnapshotRow>(
      `SELECT * FROM agent_capabilities_snapshot WHERE agent_url = ANY($1)`,
      [agentUrls],
    );
    const map = new Map<string, AgentCapabilitiesSnapshotRow>();
    for (const row of result.rows) map.set(row.agent_url, row);
    return map;
  }

  async upsertHealth(agentUrl: string, health: AgentHealth, stats: AgentStats): Promise<void> {
    try {
      await query(
        `INSERT INTO agent_health_snapshot
           (agent_url, online, response_time_ms, tools_count, resources_count, error, checked_at, stats_json, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (agent_url) DO UPDATE SET
           online = EXCLUDED.online,
           response_time_ms = EXCLUDED.response_time_ms,
           tools_count = EXCLUDED.tools_count,
           resources_count = EXCLUDED.resources_count,
           error = EXCLUDED.error,
           checked_at = EXCLUDED.checked_at,
           stats_json = EXCLUDED.stats_json,
           updated_at = NOW()`,
        [
          agentUrl,
          health.online,
          health.response_time_ms ?? null,
          health.tools_count ?? null,
          health.resources_count ?? null,
          health.error ?? null,
          health.checked_at,
          JSON.stringify(stats ?? {}),
        ],
      );
    } catch (err) {
      logger.warn({ agentUrl, err }, 'Failed to upsert agent health snapshot');
    }
  }

  async upsertCapabilities(
    profile: AgentCapabilityProfile,
    inferredType: string | null,
  ): Promise<void> {
    try {
      await query(
        `INSERT INTO agent_capabilities_snapshot
           (agent_url, protocol, discovered_tools_json, standard_operations_json,
            creative_capabilities_json, signals_capabilities_json, inferred_type,
            discovery_error, oauth_required, last_discovered, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
         ON CONFLICT (agent_url) DO UPDATE SET
           protocol = EXCLUDED.protocol,
           discovered_tools_json = EXCLUDED.discovered_tools_json,
           standard_operations_json = EXCLUDED.standard_operations_json,
           creative_capabilities_json = EXCLUDED.creative_capabilities_json,
           signals_capabilities_json = EXCLUDED.signals_capabilities_json,
           inferred_type = EXCLUDED.inferred_type,
           discovery_error = EXCLUDED.discovery_error,
           oauth_required = EXCLUDED.oauth_required,
           last_discovered = EXCLUDED.last_discovered,
           updated_at = NOW()`,
        [
          profile.agent_url,
          profile.protocol,
          JSON.stringify(profile.discovered_tools ?? []),
          profile.standard_operations ? JSON.stringify(profile.standard_operations) : null,
          profile.creative_capabilities ? JSON.stringify(profile.creative_capabilities) : null,
          profile.signals_capabilities ? JSON.stringify(profile.signals_capabilities) : null,
          inferredType,
          profile.discovery_error ?? null,
          profile.oauth_required ?? false,
          profile.last_discovered,
        ],
      );
    } catch (err) {
      logger.warn({ agentUrl: profile.agent_url, err }, 'Failed to upsert agent capabilities snapshot');
    }
  }
}
