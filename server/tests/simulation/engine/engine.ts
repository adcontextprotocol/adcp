/**
 * SimulationEngine — seeds profiles, runs outreach cycles, simulates user actions.
 *
 * Uses a real PostgreSQL database (local Docker), mocked external services,
 * and the person_events table as the single source of truth for timeline output.
 */

import type { Pool } from 'pg';
import { SimulationClock } from './clock.js';
import type { Interceptors } from './interceptors.js';
import type {
  SimPersonProfile,
  SimulatedAction,
  TimelineEvent,
  OutreachCycleResult,
  SimulationReport,
} from './types.js';
import type { RelationshipStage, PersonRelationship } from '../../../src/db/relationship-db.js';

export class SimulationEngine {
  readonly clock: SimulationClock;
  private pool: Pool;
  private interceptors: Interceptors;
  private timeline: TimelineEvent[] = [];
  private seededProfiles: Map<string, { archetypeId: string; personId: string; description: string; startStage: RelationshipStage }> = new Map();
  private outreachCycleCount = 0;
  private startTime: Date;

  constructor(options: {
    pool: Pool;
    clock: SimulationClock;
    interceptors: Interceptors;
  }) {
    this.pool = options.pool;
    this.clock = options.clock;
    this.interceptors = options.interceptors;
    this.startTime = options.clock.now();
  }

  // -------------------------------------------------------------------------
  // Profile Seeding
  // -------------------------------------------------------------------------

  /**
   * Seed a person profile into the database.
   * Returns the person_id (UUID).
   */
  async seedProfile(profile: SimPersonProfile): Promise<string> {
    const r = profile.relationship;

    // Seed organization if provided
    if (profile.organization) {
      const org = profile.organization;
      await this.pool.query(
        `INSERT INTO organizations (workos_organization_id, name, domain, company_type, persona, prospect_contact_email, prospect_contact_name, prospect_owner)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (workos_organization_id) DO NOTHING`,
        [
          org.workos_organization_id,
          org.name,
          org.domain ?? null,
          org.company_type ?? null,
          org.persona ?? null,
          org.prospect_contact_email ?? null,
          org.prospect_contact_name ?? null,
          org.prospect_owner ?? 'addie',
        ]
      );
    }

    // Seed person_relationships
    const result = await this.pool.query(
      `INSERT INTO person_relationships (
        slack_user_id, workos_user_id, email, prospect_org_id,
        display_name, stage, stage_changed_at,
        sentiment_trend, interaction_count, unreplied_outreach_count,
        opted_out, contact_preference,
        last_addie_message_at, last_person_message_at, next_contact_after,
        slack_dm_channel_id, slack_dm_thread_ts
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING id`,
      [
        r.slack_user_id ?? null,
        r.workos_user_id ?? null,
        r.email ?? null,
        r.prospect_org_id ?? null,
        r.display_name ?? null,
        r.stage,
        r.last_addie_message_at ? new Date(r.last_addie_message_at) : this.clock.now(),
        r.sentiment_trend ?? 'neutral',
        r.interaction_count ?? 0,
        r.unreplied_outreach_count ?? 0,
        r.opted_out ?? false,
        r.contact_preference ?? null,
        r.last_addie_message_at ? new Date(r.last_addie_message_at) : null,
        r.last_person_message_at ? new Date(r.last_person_message_at) : null,
        r.next_contact_after ? new Date(r.next_contact_after) : null,
        r.slack_dm_channel_id ?? null,
        r.slack_dm_thread_ts ?? null,
      ]
    );

    const personId = result.rows[0].id as string;

    // Seed message history
    if (profile.messageHistory && profile.messageHistory.length > 0) {
      // Create a thread for this person
      const threadResult = await this.pool.query(
        `INSERT INTO addie_threads (channel, external_id, user_type, user_id, user_display_name, person_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING thread_id`,
        [
          'slack',
          `SIM_DM_${r.slack_user_id ?? personId}:sim_thread`,
          r.slack_user_id ? 'slack' : 'workos',
          r.slack_user_id ?? r.workos_user_id ?? personId,
          r.display_name ?? 'Sim User',
          personId,
        ]
      );
      const threadId = threadResult.rows[0].thread_id;

      for (const msg of profile.messageHistory) {
        const msgTime = new Date(
          this.clock.nowMs() +
          (msg.relativeTime.days ?? 0) * 86400000 +
          (msg.relativeTime.hours ?? 0) * 3600000
        );

        await this.pool.query(
          `INSERT INTO addie_thread_messages (thread_id, role, content, created_at)
           VALUES ($1, $2, $3, $4)`,
          [threadId, msg.role, msg.content, msgTime]
        );
      }
    }

    // Seed person_events for initial state
    await this.pool.query(
      `INSERT INTO person_events (person_id, event_type, channel, data, occurred_at)
       VALUES ($1, 'stage_changed', 'system', $2, $3)`,
      [personId, JSON.stringify({ from: null, to: r.stage, source: 'seed' }), this.clock.now()]
    );

    this.seededProfiles.set(personId, {
      archetypeId: profile.id,
      personId,
      description: profile.description,
      startStage: r.stage,
    });

    return personId;
  }

  /**
   * Seed multiple profiles. Returns map of archetypeId -> personId.
   */
  async seedProfiles(profiles: SimPersonProfile[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const profile of profiles) {
      const personId = await this.seedProfile(profile);
      result.set(profile.id, personId);
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Run Outreach Cycle
  // -------------------------------------------------------------------------

  /**
   * Run one relationship orchestrator cycle.
   * Imports and calls the actual relationship orchestrator cycle.
   */
  async runOutreachCycle(options?: { limit?: number }): Promise<OutreachCycleResult> {
    this.outreachCycleCount++;
    const cycleStartEvents = this.timeline.length;

    // Sync PG clock to simulation time
    await this.syncPgClock();

    // Import dynamically to ensure mocks are in place
    const { runRelationshipOrchestratorCycle } = await import('../../../src/addie/services/relationship-orchestrator.js');

    const result = await runRelationshipOrchestratorCycle({
      limit: options?.limit ?? 10,
      forceRun: true, // Skip business hours check
    });

    // Read events generated during this cycle from the DB
    const newEvents = await this.readNewEvents(cycleStartEvents);
    this.timeline.push(...newEvents);

    return {
      processed: result.processed,
      sent: result.sent,
      skipped: result.skipped,
      errors: result.errors,
      events: newEvents,
    };
  }

  // -------------------------------------------------------------------------
  // Simulate User Actions
  // -------------------------------------------------------------------------

  /**
   * Simulate a user action and update the database accordingly.
   */
  async simulateUserAction(personId: string, action: SimulatedAction): Promise<void> {
    await this.syncPgClock();

    const person = await this.getRelationship(personId);
    if (!person) throw new Error(`Person ${personId} not found`);

    const { recordPersonMessage, evaluateStageTransitions } = await import('../../../src/db/relationship-db.js');
    const personEventsDb = await import('../../../src/db/person-events-db.js');

    switch (action.type) {
      case 'slack_message': {
        await recordPersonMessage(personId, 'slack');
        await personEventsDb.recordEvent(personId, 'message_received', {
          channel: 'slack',
          data: { text: action.text, source: 'simulation' },
        });

        // Also add to thread messages if there's a thread
        const threads = await this.pool.query(
          `SELECT thread_id FROM addie_threads WHERE person_id = $1 LIMIT 1`,
          [personId]
        );
        if (threads.rows[0]) {
          await this.pool.query(
            `INSERT INTO addie_thread_messages (thread_id, role, content, created_at)
             VALUES ($1, 'user', $2, $3)`,
            [threads.rows[0].thread_id, action.text, this.clock.now()]
          );
        }

        await evaluateStageTransitions(personId);
        this.addTimelineEvent(personId, person, 'message_received', 'slack', { text: action.text });
        break;
      }

      case 'email_reply': {
        await recordPersonMessage(personId, 'email');
        await personEventsDb.recordEvent(personId, 'message_received', {
          channel: 'email',
          data: { text: action.text, source: 'simulation' },
        });
        await evaluateStageTransitions(personId);
        this.addTimelineEvent(personId, person, 'message_received', 'email', { text: action.text });
        break;
      }

      case 'link_account': {
        await this.pool.query(
          `UPDATE person_relationships SET workos_user_id = $2, updated_at = NOW() WHERE id = $1`,
          [personId, action.workosUserId]
        );
        await personEventsDb.recordEvent(personId, 'identity_linked', {
          channel: 'system',
          data: { workos_user_id: action.workosUserId },
        });
        await evaluateStageTransitions(personId);
        this.addTimelineEvent(personId, person, 'user_action', 'web', { action: 'link_account' });
        break;
      }

      case 'join_working_group': {
        // Insert working group membership if we have workos_user_id
        if (person.workos_user_id) {
          const wg = await this.pool.query(
            `SELECT id FROM working_groups WHERE slug = $1 LIMIT 1`,
            [action.groupSlug]
          );
          if (wg.rows[0]) {
            await this.pool.query(
              `INSERT INTO working_group_memberships (working_group_id, workos_user_id, status)
               VALUES ($1, $2, 'active')
               ON CONFLICT DO NOTHING`,
              [wg.rows[0].id, person.workos_user_id]
            );
          }
        }
        await personEventsDb.recordEvent(personId, 'group_joined', {
          channel: 'system',
          data: { group_slug: action.groupSlug },
        });
        await evaluateStageTransitions(personId);
        this.addTimelineEvent(personId, person, 'user_action', 'system', {
          action: 'join_working_group',
          group: action.groupSlug,
        });
        break;
      }

      case 'opt_out': {
        await this.pool.query(
          `UPDATE person_relationships SET opted_out = TRUE, updated_at = NOW() WHERE id = $1`,
          [personId]
        );
        await personEventsDb.recordEvent(personId, 'opted_out', {
          channel: 'system',
          data: { source: 'simulation' },
        });
        this.addTimelineEvent(personId, person, 'user_action', 'system', { action: 'opt_out' });
        break;
      }

      case 'opt_in': {
        await this.pool.query(
          `UPDATE person_relationships SET opted_out = FALSE, updated_at = NOW() WHERE id = $1`,
          [personId]
        );
        await personEventsDb.recordEvent(personId, 'opted_in', {
          channel: 'system',
          data: { source: 'simulation' },
        });
        this.addTimelineEvent(personId, person, 'user_action', 'system', { action: 'opt_in' });
        break;
      }

      case 'web_chat_message': {
        await recordPersonMessage(personId, 'web');
        await personEventsDb.recordEvent(personId, 'message_received', {
          channel: 'web',
          data: { text: action.text, source: 'simulation' },
        });
        await evaluateStageTransitions(personId);
        this.addTimelineEvent(personId, person, 'message_received', 'web', { text: action.text });
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Time
  // -------------------------------------------------------------------------

  /** Advance simulation time. */
  advanceTime(duration: { days?: number; hours?: number; minutes?: number }): Date {
    return this.clock.advance(duration);
  }

  // -------------------------------------------------------------------------
  // Inspect State
  // -------------------------------------------------------------------------

  /** Get current relationship state for a person. */
  async getRelationship(personId: string): Promise<PersonRelationship | null> {
    const { getRelationship } = await import('../../../src/db/relationship-db.js');
    return getRelationship(personId);
  }

  /** Get the full timeline. */
  getTimeline(personId?: string): TimelineEvent[] {
    if (!personId) return [...this.timeline];
    return this.timeline.filter(e => e.personId === personId);
  }

  /** Get events from the person_events DB table. */
  async getPersonEvents(personId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT * FROM person_events WHERE person_id = $1 ORDER BY occurred_at ASC`,
      [personId]
    );
    return result.rows;
  }

  /** Count messages sent to a person in the last N days. */
  async countMessagesSent(personId: string, withinDays?: number): Promise<number> {
    let sql = `SELECT COUNT(*) as count FROM person_events WHERE person_id = $1 AND event_type = 'message_sent'`;
    const params: unknown[] = [personId];

    if (withinDays) {
      params.push(withinDays);
      sql += ` AND occurred_at > NOW() - make_interval(days => $${params.length})`;
    }

    const result = await this.pool.query(sql, params);
    return Number(result.rows[0]?.count ?? 0);
  }

  /** Get simulation report. */
  async generateReport(): Promise<SimulationReport> {
    const profiles = [];

    for (const [personId, info] of this.seededProfiles) {
      const current = await this.getRelationship(personId);
      const personTimeline = this.getTimeline(personId);

      profiles.push({
        id: info.archetypeId,
        description: info.description,
        personId,
        startStage: info.startStage,
        endStage: current?.stage ?? info.startStage,
        messagesReceived: personTimeline.filter(e => e.type === 'message_received').length,
        messagesSent: personTimeline.filter(e => e.type === 'message_sent').length,
        stageTransitions: personTimeline
          .filter(e => e.type === 'stage_changed')
          .map(e => ({
            from: e.details.from as string,
            to: e.details.to as string,
            at: e.timestamp,
          })),
      });
    }

    return {
      duration: {
        start: this.startTime,
        end: this.clock.now(),
        simDays: (this.clock.nowMs() - this.startTime.getTime()) / 86400000,
      },
      profiles,
      outreachCycles: this.outreachCycleCount,
      totalDecisions: this.timeline.filter(e => e.type === 'outreach_decided').length,
      totalSent: this.timeline.filter(e => e.type === 'message_sent').length,
      totalSkipped: this.timeline.filter(e => e.type === 'outreach_skipped' || e.type === 'compose_skipped').length,
      timeline: [...this.timeline],
    };
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  /** Clean up simulation data from the database. */
  async cleanup(): Promise<void> {
    const personIds = Array.from(this.seededProfiles.keys());
    if (personIds.length === 0) return;

    const placeholders = personIds.map((_, i) => `$${i + 1}`).join(', ');

    // Delete in dependency order
    await this.pool.query(
      `DELETE FROM person_events WHERE person_id IN (${placeholders})`,
      personIds
    );
    await this.pool.query(
      `DELETE FROM addie_thread_messages WHERE thread_id IN (
        SELECT thread_id FROM addie_threads WHERE person_id IN (${placeholders})
      )`,
      personIds
    );
    await this.pool.query(
      `DELETE FROM addie_threads WHERE person_id IN (${placeholders})`,
      personIds
    );
    await this.pool.query(
      `DELETE FROM person_relationships WHERE id IN (${placeholders})`,
      personIds
    );

    this.timeline = [];
    this.seededProfiles.clear();
  }

  // -------------------------------------------------------------------------
  // Internal Helpers
  // -------------------------------------------------------------------------

  /**
   * Sync PostgreSQL session time to simulation clock.
   * Uses SET LOCAL to override NOW() within the current transaction scope.
   */
  private async syncPgClock(): Promise<void> {
    await this.pool.query(
      `SELECT set_config('app.sim_time', $1, false)`,
      [this.clock.now().toISOString()]
    );
  }

  /** Read new person_events written since the last check. */
  private async readNewEvents(sinceTimelineLength: number): Promise<TimelineEvent[]> {
    const personIds = Array.from(this.seededProfiles.keys());
    if (personIds.length === 0) return [];

    const placeholders = personIds.map((_, i) => `$${i + 1}`).join(', ');
    const result = await this.pool.query(
      `SELECT pe.*, pr.display_name
       FROM person_events pe
       JOIN person_relationships pr ON pr.id = pe.person_id
       WHERE pe.person_id IN (${placeholders})
       ORDER BY pe.occurred_at ASC`,
      personIds
    );

    // Convert DB events to timeline events, skipping ones we already have
    const allDbEvents = result.rows.map(row => this.dbEventToTimeline(row));
    // Return only events beyond what we had
    return allDbEvents.slice(sinceTimelineLength > 0 ? this.timeline.length : 0);
  }

  private dbEventToTimeline(row: Record<string, unknown>): TimelineEvent {
    const eventType = row.event_type as string;
    const data = (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) as Record<string, unknown>;

    let type: TimelineEvent['type'];
    switch (eventType) {
      case 'outreach_decided': type = 'outreach_decided'; break;
      case 'outreach_skipped': type = 'outreach_skipped'; break;
      case 'message_sent': type = 'message_sent'; break;
      case 'message_received': type = 'message_received'; break;
      case 'stage_changed': type = 'stage_changed'; break;
      case 'message_composed':
        type = data.action === 'skip' ? 'compose_skipped' : 'outreach_decided';
        break;
      default: type = 'user_action';
    }

    return {
      timestamp: new Date(row.occurred_at as string),
      personId: row.person_id as string,
      personName: (row.display_name as string) ?? 'Unknown',
      type,
      channel: row.channel as string | undefined,
      details: data,
    };
  }

  private addTimelineEvent(
    personId: string,
    person: PersonRelationship,
    type: TimelineEvent['type'],
    channel: string | undefined,
    details: Record<string, unknown>
  ): void {
    this.timeline.push({
      timestamp: this.clock.now(),
      personId,
      personName: person.display_name ?? 'Unknown',
      type,
      channel,
      details,
    });
  }
}
