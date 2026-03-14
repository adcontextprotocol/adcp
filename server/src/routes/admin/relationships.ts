/**
 * Admin relationship routes
 *
 * Provides visibility into the person_relationships and person_events tables.
 * Use with ADMIN_API_KEY for programmatic access.
 *
 * Routes (order matters — static paths before parameterized):
 * - GET /api/admin/relationships                          — List all people
 * - GET /api/admin/relationships/events/recent            — Recent events across all people
 * - GET /api/admin/relationships/stats                    — Aggregate stats
 * - GET /api/admin/relationships/lookup/slack/:slackUserId — Lookup by Slack ID
 * - GET /api/admin/relationships/lookup/email/:email      — Lookup by email
 * - GET /api/admin/relationships/lookup/workos/:workosUserId — Lookup by WorkOS ID
 * - GET /api/admin/relationships/:personId                — Single person detail
 * - GET /api/admin/relationships/:personId/timeline       — Full event timeline
 */

import { Router } from 'express';
import { getPool } from '../../db/client.js';
import { createLogger } from '../../logger.js';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';
import * as relationshipDb from '../../db/relationship-db.js';
import * as personEvents from '../../db/person-events-db.js';

const logger = createLogger('admin-relationships');

// Valid relationship stages for input validation
const VALID_STAGES = ['prospect', 'welcomed', 'exploring', 'participating', 'contributing', 'leading'];

export function setupRelationshipRoutes(apiRouter: Router): void {

  // ─── Static routes first ────────────────────────────────────────────────────

  // GET /api/admin/relationships — List all people
  apiRouter.get('/relationships', requireAuth, requireAdmin, async (req, res) => {
    try {
      const pool = getPool();
      const stage = req.query.stage as string | undefined;
      const search = req.query.search as string | undefined;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const offset = parseInt(req.query.offset as string) || 0;

      // Validate stage if provided
      if (stage && !VALID_STAGES.includes(stage)) {
        return res.status(400).json({ error: `Invalid stage. Must be one of: ${VALID_STAGES.join(', ')}` });
      }

      // Build WHERE clause once, shared between count and data queries
      const conditions: string[] = ['1=1'];
      const params: unknown[] = [];

      if (stage) {
        params.push(stage);
        conditions.push(`pr.stage = $${params.length}`);
      }

      if (search) {
        params.push(`%${search}%`);
        conditions.push(`(pr.display_name ILIKE $${params.length} OR pr.email ILIKE $${params.length} OR pr.slack_user_id ILIKE $${params.length})`);
      }

      const whereClause = conditions.join(' AND ');

      // Count query
      const countResult = await pool.query(
        `SELECT COUNT(*) as total FROM person_relationships pr WHERE ${whereClause}`,
        params
      );

      // Data query with event counts
      const dataParams = [...params];
      dataParams.push(limit);
      const limitIdx = dataParams.length;
      dataParams.push(offset);
      const offsetIdx = dataParams.length;

      const result = await pool.query(
        `SELECT pr.*,
          (SELECT COUNT(*) FROM person_events pe WHERE pe.person_id = pr.id) as event_count,
          (SELECT COUNT(*) FROM person_events pe WHERE pe.person_id = pr.id AND pe.event_type = 'message_sent') as messages_sent,
          (SELECT COUNT(*) FROM person_events pe WHERE pe.person_id = pr.id AND pe.event_type = 'message_received') as messages_received
        FROM person_relationships pr
        WHERE ${whereClause}
        ORDER BY pr.updated_at DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        dataParams
      );

      res.json({
        people: result.rows.map(formatPersonRow),
        total: parseInt(countResult.rows[0]?.total ?? '0'),
        limit,
        offset,
      });
    } catch (error) {
      logger.error({ error }, 'Error listing relationships');
      res.status(500).json({ error: 'Failed to list relationships' });
    }
  });

  // GET /api/admin/relationships/events/recent — Recent events across all people
  apiRouter.get('/relationships/events/recent', requireAuth, requireAdmin, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const eventTypes = req.query.types
        ? (req.query.types as string).split(',')
        : undefined;
      const channel = req.query.channel as string | undefined;

      const events = await personEvents.getRecentEvents({
        limit,
        eventTypes: eventTypes as personEvents.PersonEventType[] | undefined,
        channel,
      });

      // Enrich events with display names
      if (events.length > 0) {
        const pool = getPool();
        const personIds = [...new Set(events.map(e => e.person_id))];
        const nameResult = await pool.query(
          `SELECT id, display_name, slack_user_id, email FROM person_relationships WHERE id = ANY($1)`,
          [personIds]
        );
        const nameMap = new Map(nameResult.rows.map(r => [r.id, r]));

        const enriched = events.map(e => ({
          ...e,
          person_display_name: nameMap.get(e.person_id)?.display_name ?? null,
          person_slack_user_id: nameMap.get(e.person_id)?.slack_user_id ?? null,
        }));

        return res.json({ events: enriched });
      }

      res.json({ events });
    } catch (error) {
      logger.error({ error }, 'Error getting recent events');
      res.status(500).json({ error: 'Failed to get recent events' });
    }
  });

  // GET /api/admin/relationships/stats — Aggregate stats
  apiRouter.get('/relationships/stats', requireAuth, requireAdmin, async (req, res) => {
    try {
      const pool = getPool();

      const [stageStats, activityStats, channelStats] = await Promise.all([
        pool.query(`
          SELECT stage, COUNT(*) as count,
            COUNT(*) FILTER (WHERE opted_out) as opted_out_count,
            AVG(interaction_count) as avg_interactions,
            AVG(unreplied_outreach_count) as avg_unreplied
          FROM person_relationships
          GROUP BY stage
          ORDER BY CASE stage
            WHEN 'prospect' THEN 1 WHEN 'welcomed' THEN 2
            WHEN 'exploring' THEN 3 WHEN 'participating' THEN 4
            WHEN 'contributing' THEN 5 WHEN 'leading' THEN 6
          END
        `),

        pool.query(`
          SELECT
            event_type,
            COUNT(*) FILTER (WHERE occurred_at > NOW() - INTERVAL '7 days') as last_7d,
            COUNT(*) FILTER (WHERE occurred_at > NOW() - INTERVAL '30 days') as last_30d,
            COUNT(*) as total
          FROM person_events
          GROUP BY event_type
          ORDER BY total DESC
        `),

        pool.query(`
          SELECT
            channel,
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE occurred_at > NOW() - INTERVAL '7 days') as last_7d
          FROM person_events
          WHERE event_type IN ('message_sent', 'message_received')
          GROUP BY channel
        `),
      ]);

      res.json({
        stages: stageStats.rows.map(row => ({
          stage: row.stage,
          count: parseInt(row.count),
          opted_out: parseInt(row.opted_out_count),
          avg_interactions: parseFloat(Number(row.avg_interactions).toFixed(1)),
          avg_unreplied: parseFloat(Number(row.avg_unreplied).toFixed(1)),
        })),
        activity: activityStats.rows.map(row => ({
          event_type: row.event_type,
          last_7d: parseInt(row.last_7d),
          last_30d: parseInt(row.last_30d),
          total: parseInt(row.total),
        })),
        channels: channelStats.rows.map(row => ({
          channel: row.channel,
          total: parseInt(row.total),
          last_7d: parseInt(row.last_7d),
        })),
      });
    } catch (error) {
      logger.error({ error }, 'Error getting relationship stats');
      res.status(500).json({ error: 'Failed to get stats' });
    }
  });

  // GET /api/admin/relationships/lookup/slack/:slackUserId — Lookup by Slack ID
  apiRouter.get('/relationships/lookup/slack/:slackUserId', requireAuth, requireAdmin, async (req, res) => {
    try {
      const relationship = await relationshipDb.getRelationshipBySlackId(req.params.slackUserId);
      if (!relationship) {
        return res.status(404).json({ error: 'Person not found for Slack ID' });
      }

      const events = await personEvents.getPersonTimeline(relationship.id, { limit: 20 });
      res.json({ relationship, recent_events: events });
    } catch (error) {
      logger.error({ error }, 'Error looking up by Slack ID');
      res.status(500).json({ error: 'Failed to lookup' });
    }
  });

  // GET /api/admin/relationships/lookup/email/:email — Lookup by email
  apiRouter.get('/relationships/lookup/email/:email', requireAuth, requireAdmin, async (req, res) => {
    try {
      const pool = getPool();
      const result = await pool.query(
        `SELECT id FROM person_relationships WHERE email = $1 LIMIT 1`,
        [req.params.email]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Person not found for email' });
      }

      const personId = result.rows[0].id;
      const relationship = await relationshipDb.getRelationship(personId);
      const events = await personEvents.getPersonTimeline(personId, { limit: 20 });
      res.json({ relationship, recent_events: events });
    } catch (error) {
      logger.error({ error }, 'Error looking up by email');
      res.status(500).json({ error: 'Failed to lookup' });
    }
  });

  // GET /api/admin/relationships/lookup/workos/:workosUserId — Lookup by WorkOS ID
  apiRouter.get('/relationships/lookup/workos/:workosUserId', requireAuth, requireAdmin, async (req, res) => {
    try {
      const relationship = await relationshipDb.getRelationshipByWorkosId(req.params.workosUserId);
      if (!relationship) {
        return res.status(404).json({ error: 'Person not found for WorkOS ID' });
      }

      const events = await personEvents.getPersonTimeline(relationship.id, { limit: 20 });
      res.json({ relationship, recent_events: events });
    } catch (error) {
      logger.error({ error }, 'Error looking up by WorkOS ID');
      res.status(500).json({ error: 'Failed to lookup' });
    }
  });

  // ─── Parameterized routes last ──────────────────────────────────────────────

  // GET /api/admin/relationships/:personId — Single person with recent events
  apiRouter.get('/relationships/:personId', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { personId } = req.params;

      // Basic UUID format validation
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(personId)) {
        return res.status(400).json({ error: 'Invalid person ID format' });
      }

      const relationship = await relationshipDb.getRelationship(personId);

      if (!relationship) {
        return res.status(404).json({ error: 'Person not found' });
      }

      // Get recent events (last 50)
      const events = await personEvents.getPersonTimeline(personId, { limit: 50 });

      // Get message counts
      const pool = getPool();
      const counts = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE event_type = 'message_sent') as sent,
          COUNT(*) FILTER (WHERE event_type = 'message_received') as received,
          COUNT(*) FILTER (WHERE event_type = 'outreach_skipped') as skipped,
          COUNT(*) FILTER (WHERE event_type = 'stage_changed') as stage_changes
        FROM person_events WHERE person_id = $1
      `, [personId]);

      res.json({
        relationship,
        events,
        counts: {
          messages_sent: parseInt(counts.rows[0]?.sent ?? '0'),
          messages_received: parseInt(counts.rows[0]?.received ?? '0'),
          outreach_skipped: parseInt(counts.rows[0]?.skipped ?? '0'),
          stage_changes: parseInt(counts.rows[0]?.stage_changes ?? '0'),
        },
      });
    } catch (error) {
      logger.error({ error }, 'Error getting relationship');
      res.status(500).json({ error: 'Failed to get relationship' });
    }
  });

  // GET /api/admin/relationships/:personId/timeline — Full timeline
  apiRouter.get('/relationships/:personId/timeline', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { personId } = req.params;

      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(personId)) {
        return res.status(400).json({ error: 'Invalid person ID format' });
      }

      const since = req.query.since ? new Date(req.query.since as string) : undefined;
      const until = req.query.until ? new Date(req.query.until as string) : undefined;
      const limit = Math.min(parseInt(req.query.limit as string) || 200, 1000);
      const eventTypes = req.query.types
        ? (req.query.types as string).split(',')
        : undefined;

      const events = await personEvents.getPersonTimeline(personId, {
        since,
        until,
        limit,
        eventTypes: eventTypes as personEvents.PersonEventType[] | undefined,
      });

      res.json({ person_id: personId, events, count: events.length });
    } catch (error) {
      logger.error({ error }, 'Error getting timeline');
      res.status(500).json({ error: 'Failed to get timeline' });
    }
  });
}

// Format a person_relationships row for API output
function formatPersonRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    slack_user_id: row.slack_user_id,
    workos_user_id: row.workos_user_id,
    email: row.email,
    display_name: row.display_name,
    prospect_org_id: row.prospect_org_id,
    stage: row.stage,
    stage_changed_at: row.stage_changed_at,
    sentiment_trend: row.sentiment_trend,
    interaction_count: row.interaction_count,
    unreplied_outreach_count: row.unreplied_outreach_count,
    opted_out: row.opted_out,
    contact_preference: row.contact_preference,
    last_addie_message_at: row.last_addie_message_at,
    last_person_message_at: row.last_person_message_at,
    last_interaction_channel: row.last_interaction_channel,
    next_contact_after: row.next_contact_after,
    created_at: row.created_at,
    updated_at: row.updated_at,
    // Enriched fields from subqueries
    event_count: parseInt((row.event_count as string) ?? '0'),
    messages_sent: parseInt((row.messages_sent as string) ?? '0'),
    messages_received: parseInt((row.messages_received as string) ?? '0'),
  };
}
