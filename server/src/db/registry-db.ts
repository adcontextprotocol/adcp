import { query } from "./client.js";
import type { Agent, AgentType } from "../types.js";

export interface RegistryEntry {
  id: string;
  entry_type: "agent" | "partner" | "product" | "format";
  name: string;
  slug: string;
  url: string;
  card_manifest_url?: string;
  card_format_id?: any;
  metadata: Record<string, any>;
  tags: string[];
  contact_name?: string;
  contact_email?: string;
  contact_website?: string;
  approval_status: "pending" | "approved" | "rejected";
  approved_by?: string;
  approved_at?: Date;
  created_at: Date;
  updated_at: Date;
  active: boolean;
  workos_organization_id?: string;
}

export interface CreateRegistryEntryInput {
  entry_type: "agent" | "partner" | "product" | "format";
  name: string;
  slug: string;
  url: string;
  card_manifest_url?: string;
  card_format_id?: any;
  metadata?: Record<string, any>;
  tags?: string[];
  contact_name?: string;
  contact_email?: string;
  contact_website?: string;
  approval_status?: "pending" | "approved" | "rejected";
  workos_organization_id?: string;
}

export interface ListRegistryEntriesOptions {
  entry_type?: "agent" | "partner" | "product" | "format";
  tags?: string[];
  approval_status?: "pending" | "approved" | "rejected";
  active?: boolean;
  limit?: number;
  offset?: number;
  workos_organization_id?: string;
}

/**
 * Database-backed registry service
 */
export class RegistryDatabase {
  /**
   * Create a new registry entry
   */
  async createEntry(input: CreateRegistryEntryInput): Promise<RegistryEntry> {
    const result = await query<RegistryEntry>(
      `INSERT INTO registry_entries (
        entry_type, name, slug, url,
        card_manifest_url, card_format_id, metadata, tags,
        contact_name, contact_email, contact_website,
        approval_status, workos_organization_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *`,
      [
        input.entry_type,
        input.name,
        input.slug,
        input.url,
        input.card_manifest_url || null,
        input.card_format_id ? JSON.stringify(input.card_format_id) : null,
        JSON.stringify(input.metadata || {}),
        input.tags || [],
        input.contact_name || null,
        input.contact_email || null,
        input.contact_website || null,
        input.approval_status || "pending",
        input.workos_organization_id || null,
      ]
    );

    return this.deserializeEntry(result.rows[0]);
  }

  /**
   * Get entry by slug
   */
  async getEntryBySlug(slug: string): Promise<RegistryEntry | null> {
    const result = await query<RegistryEntry>(
      "SELECT * FROM registry_entries WHERE slug = $1",
      [slug]
    );

    const row = result.rows[0];
    return row ? this.deserializeEntry(row) : null;
  }

  /**
   * Get entry by ID
   */
  async getEntryById(id: string): Promise<RegistryEntry | null> {
    const result = await query<RegistryEntry>(
      "SELECT * FROM registry_entries WHERE id = $1",
      [id]
    );

    const row = result.rows[0];
    return row ? this.deserializeEntry(row) : null;
  }

  /**
   * Deserialize database row (parse JSONB fields)
   */
  private deserializeEntry(row: any): RegistryEntry {
    return {
      ...row,
      card_format_id:
        typeof row.card_format_id === "string"
          ? JSON.parse(row.card_format_id)
          : row.card_format_id,
      metadata:
        typeof row.metadata === "string"
          ? JSON.parse(row.metadata)
          : row.metadata,
    };
  }

  /**
   * List registry entries with filtering
   */
  async listEntries(
    options: ListRegistryEntriesOptions = {}
  ): Promise<RegistryEntry[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    // Build WHERE clause
    if (options.entry_type) {
      conditions.push(`entry_type = $${paramIndex++}`);
      params.push(options.entry_type);
    }

    if (options.approval_status) {
      conditions.push(`approval_status = $${paramIndex++}`);
      params.push(options.approval_status);
    }

    if (options.active !== undefined) {
      conditions.push(`active = $${paramIndex++}`);
      params.push(options.active);
    }

    if (options.tags && options.tags.length > 0) {
      conditions.push(`tags && $${paramIndex++}::text[]`);
      params.push(options.tags);
    }

    if (options.workos_organization_id) {
      conditions.push(`workos_organization_id = $${paramIndex++}`);
      params.push(options.workos_organization_id);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Build query
    const sql = `
      SELECT * FROM registry_entries
      ${whereClause}
      ORDER BY created_at DESC
      ${options.limit ? `LIMIT $${paramIndex++}` : ""}
      ${options.offset ? `OFFSET $${paramIndex++}` : ""}
    `;

    if (options.limit) params.push(options.limit);
    if (options.offset) params.push(options.offset);

    const result = await query<RegistryEntry>(sql, params);
    return result.rows.map((row) => this.deserializeEntry(row));
  }

  /**
   * Update registry entry
   */
  async updateEntry(
    slug: string,
    updates: Partial<CreateRegistryEntryInput>
  ): Promise<RegistryEntry | null> {
    const setClauses: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    // Build SET clause dynamically
    if (updates.name !== undefined) {
      setClauses.push(`name = $${paramIndex++}`);
      params.push(updates.name);
    }
    if (updates.url !== undefined) {
      setClauses.push(`url = $${paramIndex++}`);
      params.push(updates.url);
    }
    if (updates.metadata !== undefined) {
      setClauses.push(`metadata = $${paramIndex++}`);
      params.push(JSON.stringify(updates.metadata));
    }
    if (updates.tags !== undefined) {
      setClauses.push(`tags = $${paramIndex++}`);
      params.push(updates.tags);
    }
    if (updates.contact_name !== undefined) {
      setClauses.push(`contact_name = $${paramIndex++}`);
      params.push(updates.contact_name);
    }
    if (updates.contact_email !== undefined) {
      setClauses.push(`contact_email = $${paramIndex++}`);
      params.push(updates.contact_email);
    }
    if (updates.contact_website !== undefined) {
      setClauses.push(`contact_website = $${paramIndex++}`);
      params.push(updates.contact_website);
    }
    if (updates.approval_status !== undefined) {
      setClauses.push(`approval_status = $${paramIndex++}`);
      params.push(updates.approval_status);
    }

    if (setClauses.length === 0) {
      return this.getEntryBySlug(slug);
    }

    params.push(slug);
    const sql = `
      UPDATE registry_entries
      SET ${setClauses.join(", ")}
      WHERE slug = $${paramIndex}
      RETURNING *
    `;

    const result = await query<RegistryEntry>(sql, params);
    return result.rows[0] || null;
  }

  /**
   * Delete registry entry by slug
   */
  async deleteEntry(slug: string): Promise<boolean> {
    const result = await query(
      "DELETE FROM registry_entries WHERE slug = $1",
      [slug]
    );

    return (result.rowCount || 0) > 0;
  }

  /**
   * Delete registry entry by ID (for org-scoped deletion)
   */
  async deleteEntryById(id: string): Promise<boolean> {
    const result = await query(
      "DELETE FROM registry_entries WHERE id = $1",
      [id]
    );

    return (result.rowCount || 0) > 0;
  }

  /**
   * Delete registry entry only if it belongs to the specified organization
   * Returns false if entry doesn't exist or doesn't belong to the org
   */
  async deleteEntryByIdForOrg(id: string, workos_organization_id: string): Promise<boolean> {
    const result = await query(
      "DELETE FROM registry_entries WHERE id = $1 AND workos_organization_id = $2",
      [id, workos_organization_id]
    );

    return (result.rowCount || 0) > 0;
  }

  /**
   * Get entries by organization
   */
  async getEntriesByOrg(workos_organization_id: string, entry_type?: "agent" | "partner" | "product" | "format"): Promise<RegistryEntry[]> {
    return this.listEntries({
      workos_organization_id,
      entry_type,
    });
  }

  /**
   * Check if slug is available (for creating new entries)
   */
  async isSlugAvailable(slug: string, excludeId?: string): Promise<boolean> {
    let sql = 'SELECT 1 FROM registry_entries WHERE slug = $1';
    const params: unknown[] = [slug];

    if (excludeId) {
      sql += ' AND id != $2';
      params.push(excludeId);
    }

    sql += ' LIMIT 1';

    const result = await query(sql, params);
    return result.rows.length === 0;
  }

  /**
   * Convert registry entry to Agent format (for backward compatibility)
   */
  entryToAgent(entry: RegistryEntry): Agent {
    const metadata = entry.metadata || {};

    return {
      name: entry.name,
      url: entry.url,
      type: (metadata.agent_type || entry.tags[0] || "sales") as AgentType, // Get agent type from metadata or first tag
      protocol: metadata.protocol || "mcp",
      description: metadata.description || "",
      mcp_endpoint: metadata.mcp_endpoint || entry.url,
      contact: {
        name: entry.contact_name || "",
        email: entry.contact_email || "",
        website: entry.contact_website || "",
      },
      added_date: entry.created_at.toISOString().split("T")[0],
    };
  }

  /**
   * List agents (backward compatible with old Registry class)
   */
  async listAgents(type?: AgentType): Promise<Agent[]> {
    const options: ListRegistryEntriesOptions = {
      entry_type: "agent",
      approval_status: "approved",
      active: true,
    };

    // Filter by agent type if specified (uses tags)
    if (type) {
      options.tags = [type];
    }

    const entries = await this.listEntries(options);
    return entries.map((entry) => this.entryToAgent(entry));
  }

  /**
   * Get agent by name (backward compatible)
   */
  async getAgent(name: string): Promise<Agent | undefined> {
    const entry = await this.getEntryBySlug(name);
    return entry ? this.entryToAgent(entry) : undefined;
  }
}
