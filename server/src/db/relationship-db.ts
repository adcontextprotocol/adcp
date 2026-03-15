import { query, getClient } from './client.js';
import { createLogger } from '../logger.js';
import * as personEvents from './person-events-db.js';

const logger = createLogger('relationship-db');

export type RelationshipStage = 'prospect' | 'welcomed' | 'exploring' | 'participating' | 'contributing' | 'leading';
export type SentimentTrend = 'positive' | 'neutral' | 'negative' | 'disengaging';

export interface PersonRelationship {
  id: string;
  slack_user_id: string | null;
  workos_user_id: string | null;
  email: string | null;
  prospect_org_id: string | null;
  display_name: string | null;
  stage: RelationshipStage;
  stage_changed_at: Date;
  last_addie_message_at: Date | null;
  last_person_message_at: Date | null;
  last_interaction_channel: string | null;
  next_contact_after: Date | null;
  contact_preference: 'slack' | 'email' | null;
  slack_dm_channel_id: string | null;
  slack_dm_thread_ts: string | null;
  sentiment_trend: SentimentTrend;
  interaction_count: number;
  unreplied_outreach_count: number;
  opted_out: boolean;
  created_at: Date;
  updated_at: Date;
}

export const STAGE_ORDER: RelationshipStage[] = [
  'prospect', 'welcomed', 'exploring', 'participating', 'contributing', 'leading',
];

function stageIndex(stage: RelationshipStage): number {
  return STAGE_ORDER.indexOf(stage);
}

function rowToRelationship(row: Record<string, unknown>): PersonRelationship {
  return {
    id: row.id as string,
    slack_user_id: row.slack_user_id as string | null,
    workos_user_id: row.workos_user_id as string | null,
    email: row.email as string | null,
    prospect_org_id: row.prospect_org_id as string | null,
    display_name: row.display_name as string | null,
    stage: row.stage as RelationshipStage,
    stage_changed_at: new Date(row.stage_changed_at as string),
    last_addie_message_at: row.last_addie_message_at ? new Date(row.last_addie_message_at as string) : null,
    last_person_message_at: row.last_person_message_at ? new Date(row.last_person_message_at as string) : null,
    last_interaction_channel: row.last_interaction_channel as string | null,
    next_contact_after: row.next_contact_after ? new Date(row.next_contact_after as string) : null,
    contact_preference: row.contact_preference as 'slack' | 'email' | null,
    slack_dm_channel_id: row.slack_dm_channel_id as string | null,
    slack_dm_thread_ts: row.slack_dm_thread_ts as string | null,
    sentiment_trend: row.sentiment_trend as SentimentTrend,
    interaction_count: row.interaction_count as number,
    unreplied_outreach_count: (row.unreplied_outreach_count as number) ?? 0,
    opted_out: row.opted_out as boolean,
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
  };
}

/**
 * Resolve a person to a single person_relationships row.
 * Given any combination of identifiers, find an existing record or create one.
 * If found, merge any new identifiers onto the record.
 * Returns the person ID (UUID).
 */
export async function resolvePersonId(identifiers: {
  slack_user_id?: string;
  workos_user_id?: string;
  email?: string;
  prospect_org_id?: string;
  display_name?: string;
}): Promise<string> {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (identifiers.slack_user_id) {
      params.push(identifiers.slack_user_id);
      conditions.push(`slack_user_id = $${params.length}`);
    }
    if (identifiers.workos_user_id) {
      params.push(identifiers.workos_user_id);
      conditions.push(`workos_user_id = $${params.length}`);
    }
    if (identifiers.email) {
      params.push(identifiers.email);
      conditions.push(`email = $${params.length}`);
    }

    let existing: Record<string, unknown> | undefined;
    let mergedPersonIds: string[] = [];
    let identityLinkedData: Record<string, string> | null = null;

    if (conditions.length > 0) {
      const result = await client.query(
        `SELECT * FROM person_relationships WHERE ${conditions.join(' OR ')} FOR UPDATE`,
        params
      );

      if (result.rows.length > 1) {
        // Multiple rows matched different identifiers — need to merge.
        // Pick the oldest record as the winner (most history).
        const sorted = result.rows.sort(
          (a, b) => new Date(a.created_at as string).getTime() - new Date(b.created_at as string).getTime()
        );
        const winner = sorted[0];
        const losers = sorted.slice(1);

        // Absorb loser fields the winner doesn't have
        for (const loser of losers) {
          const fieldUpdates: string[] = [];
          const fieldParams: unknown[] = [];
          let fi = 1;

          // Identity fields
          if (!winner.slack_user_id && loser.slack_user_id) {
            fieldUpdates.push(`slack_user_id = $${fi++}`);
            fieldParams.push(loser.slack_user_id);
            winner.slack_user_id = loser.slack_user_id;
          }
          if (!winner.workos_user_id && loser.workos_user_id) {
            fieldUpdates.push(`workos_user_id = $${fi++}`);
            fieldParams.push(loser.workos_user_id);
            winner.workos_user_id = loser.workos_user_id;
          }
          if (!winner.email && loser.email) {
            fieldUpdates.push(`email = $${fi++}`);
            fieldParams.push(loser.email);
            winner.email = loser.email;
          }
          if (!winner.prospect_org_id && loser.prospect_org_id) {
            fieldUpdates.push(`prospect_org_id = $${fi++}`);
            fieldParams.push(loser.prospect_org_id);
          }
          if (!winner.display_name && loser.display_name) {
            fieldUpdates.push(`display_name = $${fi++}`);
            fieldParams.push(loser.display_name);
          }
          // Prefer non-null Slack DM thread
          if (!winner.slack_dm_channel_id && loser.slack_dm_channel_id) {
            fieldUpdates.push(`slack_dm_channel_id = $${fi++}`);
            fieldParams.push(loser.slack_dm_channel_id);
            fieldUpdates.push(`slack_dm_thread_ts = $${fi++}`);
            fieldParams.push(loser.slack_dm_thread_ts);
          }
          // Sum interaction counts
          const loserInteractions = Number(loser.interaction_count ?? 0);
          if (loserInteractions > 0) {
            fieldUpdates.push(`interaction_count = interaction_count + $${fi++}`);
            fieldParams.push(loserInteractions);
          }
          // Take the higher stage
          if (stageIndex(loser.stage as RelationshipStage) > stageIndex(winner.stage as RelationshipStage)) {
            fieldUpdates.push(`stage = $${fi++}`);
            fieldParams.push(loser.stage);
            fieldUpdates.push(`stage_changed_at = NOW()`);
          }
          // Take the more recent timestamps
          if (loser.last_person_message_at && (!winner.last_person_message_at ||
              new Date(loser.last_person_message_at as string) > new Date(winner.last_person_message_at as string))) {
            fieldUpdates.push(`last_person_message_at = $${fi++}`);
            fieldParams.push(loser.last_person_message_at);
          }
          if (loser.last_addie_message_at && (!winner.last_addie_message_at ||
              new Date(loser.last_addie_message_at as string) > new Date(winner.last_addie_message_at as string))) {
            fieldUpdates.push(`last_addie_message_at = $${fi++}`);
            fieldParams.push(loser.last_addie_message_at);
          }
          // Prefer non-null contact preference
          if (!winner.contact_preference && loser.contact_preference) {
            fieldUpdates.push(`contact_preference = $${fi++}`);
            fieldParams.push(loser.contact_preference);
          }

          if (fieldUpdates.length > 0) {
            fieldUpdates.push(`updated_at = NOW()`);
            fieldParams.push(winner.id);
            await client.query(
              `UPDATE person_relationships SET ${fieldUpdates.join(', ')} WHERE id = $${fi}`,
              fieldParams
            );
          }

          // Re-parent all events from loser to winner
          await client.query(
            `UPDATE person_events SET person_id = $1 WHERE person_id = $2`,
            [winner.id, loser.id]
          );
          // Re-parent threads
          await client.query(
            `UPDATE addie_threads SET person_id = $1 WHERE person_id = $2`,
            [winner.id, loser.id]
          );
          // Delete the loser row
          await client.query(
            `DELETE FROM person_relationships WHERE id = $1`,
            [loser.id]
          );

          logger.info(
            { winner_id: winner.id, loser_id: loser.id },
            'Merged duplicate person_relationships rows'
          );
        }

        existing = winner;
        // Stash merge info for event recording after COMMIT
        mergedPersonIds = losers.map(l => l.id as string);
      } else {
        existing = result.rows[0];
      }
    }

    if (existing) {
      const updates: string[] = [];
      const updateParams: unknown[] = [];
      let idx = 1;

      if (identifiers.slack_user_id && !existing.slack_user_id) {
        updates.push(`slack_user_id = $${idx++}`);
        updateParams.push(identifiers.slack_user_id);
      }
      if (identifiers.workos_user_id && !existing.workos_user_id) {
        updates.push(`workos_user_id = $${idx++}`);
        updateParams.push(identifiers.workos_user_id);
      }
      if (identifiers.email && !existing.email) {
        updates.push(`email = $${idx++}`);
        updateParams.push(identifiers.email);
      }
      if (identifiers.prospect_org_id && !existing.prospect_org_id) {
        updates.push(`prospect_org_id = $${idx++}`);
        updateParams.push(identifiers.prospect_org_id);
      }
      if (identifiers.display_name && !existing.display_name) {
        updates.push(`display_name = $${idx++}`);
        updateParams.push(identifiers.display_name);
      }

      if (updates.length > 0) {
        updates.push(`updated_at = NOW()`);
        updateParams.push(existing.id);
        await client.query(
          `UPDATE person_relationships SET ${updates.join(', ')} WHERE id = $${idx}`,
          updateParams
        );

        // Stash for event recording after COMMIT
        const merged: Record<string, string> = {};
        if (identifiers.slack_user_id && !existing.slack_user_id) merged.slack_user_id = identifiers.slack_user_id;
        if (identifiers.workos_user_id && !existing.workos_user_id) merged.workos_user_id = identifiers.workos_user_id;
        if (identifiers.email && !existing.email) merged.email = identifiers.email;
        if (Object.keys(merged).length > 0) {
          identityLinkedData = merged;
        }
      }

      await client.query('COMMIT');

      // Record events AFTER commit so they don't reference uncommitted data
      if (mergedPersonIds.length > 0) {
        personEvents.recordEvent(existing.id as string, 'identity_linked', {
          channel: 'system',
          data: { action: 'records_merged', merged_person_ids: mergedPersonIds },
        }).catch(err => logger.warn({ err, personId: existing!.id }, 'Failed to record records_merged event'));
      }
      if (identityLinkedData) {
        personEvents.recordEvent(existing.id as string, 'identity_linked', {
          channel: 'system',
          data: { merged_identifiers: identityLinkedData },
        }).catch(err => logger.warn({ err, personId: existing!.id }, 'Failed to record identity_linked event'));
      }

      return existing.id as string;
    }

    const result = await client.query(
      `INSERT INTO person_relationships (slack_user_id, workos_user_id, email, prospect_org_id, display_name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        identifiers.slack_user_id ?? null,
        identifiers.workos_user_id ?? null,
        identifiers.email ?? null,
        identifiers.prospect_org_id ?? null,
        identifiers.display_name ?? null,
      ]
    );

    await client.query('COMMIT');
    return result.rows[0].id as string;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Get a relationship by UUID. */
export async function getRelationship(personId: string): Promise<PersonRelationship | null> {
  const result = await query(
    `SELECT * FROM person_relationships WHERE id = $1`,
    [personId]
  );
  return result.rows[0] ? rowToRelationship(result.rows[0]) : null;
}

/** Lookup a relationship by Slack user ID. */
export async function getRelationshipBySlackId(slackUserId: string): Promise<PersonRelationship | null> {
  const result = await query(
    `SELECT * FROM person_relationships WHERE slack_user_id = $1`,
    [slackUserId]
  );
  return result.rows[0] ? rowToRelationship(result.rows[0]) : null;
}

/** Lookup a relationship by WorkOS user ID. */
export async function getRelationshipByWorkosId(workosUserId: string): Promise<PersonRelationship | null> {
  const result = await query(
    `SELECT * FROM person_relationships WHERE workos_user_id = $1`,
    [workosUserId]
  );
  return result.rows[0] ? rowToRelationship(result.rows[0]) : null;
}

/**
 * Advance a person's relationship stage. Only moves forward, never regresses.
 * Returns true if the stage was updated.
 */
export async function updateStage(personId: string, newStage: RelationshipStage): Promise<boolean> {
  const current = await getRelationship(personId);
  if (!current) return false;

  if (stageIndex(newStage) <= stageIndex(current.stage)) {
    return false;
  }

  const result = await query(
    `UPDATE person_relationships
     SET stage = $2, stage_changed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND stage = $3`,
    [personId, newStage, current.stage]
  );

  const updated = (result.rowCount ?? 0) > 0;
  if (updated) {
    personEvents.recordEvent(personId, 'stage_changed', {
      channel: 'system',
      data: { from: current.stage, to: newStage },
    }).catch(err => logger.warn({ err, personId }, 'Failed to record stage_changed event'));
  }
  return updated;
}

/** Record that Addie sent a message to this person. */
export async function recordAddieMessage(personId: string, channel: string): Promise<void> {
  await query(
    `UPDATE person_relationships
     SET last_addie_message_at = NOW(),
         last_interaction_channel = $2,
         interaction_count = interaction_count + 1,
         unreplied_outreach_count = unreplied_outreach_count + 1,
         updated_at = NOW()
     WHERE id = $1`,
    [personId, channel]
  );
}

/** Record that a person sent a message. */
export async function recordPersonMessage(personId: string, channel: string): Promise<void> {
  await query(
    `UPDATE person_relationships
     SET last_person_message_at = NOW(),
         last_interaction_channel = $2,
         unreplied_outreach_count = 0,
         updated_at = NOW()
     WHERE id = $1`,
    [personId, channel]
  );
}

/** Set when Addie should next reach out to this person. */
export async function setNextContactAfter(personId: string, date: Date | null): Promise<void> {
  await query(
    `UPDATE person_relationships
     SET next_contact_after = $2, updated_at = NOW()
     WHERE id = $1`,
    [personId, date]
  );
}

/** Save permanent Slack DM thread coordinates. */
export async function setSlackDmThread(personId: string, channelId: string, threadTs: string): Promise<void> {
  await query(
    `UPDATE person_relationships
     SET slack_dm_channel_id = $2, slack_dm_thread_ts = $3, updated_at = NOW()
     WHERE id = $1`,
    [personId, channelId, threadTs]
  );
}

/** Update the sentiment trend for a person. */
export async function updateSentiment(personId: string, sentiment: SentimentTrend): Promise<void> {
  await query(
    `UPDATE person_relationships
     SET sentiment_trend = $2, updated_at = NOW()
     WHERE id = $1`,
    [personId, sentiment]
  );
}

/**
 * Get people who are ready for proactive contact.
 * Ordered by: prospects first (welcome them), then by longest since last contact.
 */
export async function getEngagementCandidates(options: {
  limit: number;
  stage?: RelationshipStage;
}): Promise<PersonRelationship[]> {
  let sql = `
    SELECT * FROM person_relationships
    WHERE opted_out = FALSE
      AND (next_contact_after IS NULL OR next_contact_after <= NOW())
      AND (slack_user_id IS NOT NULL OR email IS NOT NULL)
  `;
  const params: unknown[] = [];

  if (options.stage) {
    params.push(options.stage);
    sql += ` AND stage = $${params.length}`;
  }

  sql += `
    ORDER BY
      CASE WHEN stage = 'prospect' THEN 0 ELSE 1 END ASC,
      COALESCE(last_addie_message_at, '1970-01-01'::timestamptz) ASC
  `;

  params.push(options.limit);
  sql += ` LIMIT $${params.length}`;

  const result = await query(sql, params);
  return result.rows.map(rowToRelationship);
}

/**
 * Evaluate whether a person should advance to the next relationship stage.
 * Queries relevant tables and calls updateStage if a transition is appropriate.
 */
export async function evaluateStageTransitions(personId: string): Promise<void> {
  const person = await getRelationship(personId);
  if (!person) return;

  const currentIndex = stageIndex(person.stage);

  if (currentIndex <= stageIndex('prospect') && person.last_addie_message_at !== null) {
    await updateStage(personId, 'welcomed');
  }

  if (stageIndex(person.stage) <= stageIndex('welcomed') || currentIndex <= stageIndex('welcomed')) {
    if (person.last_person_message_at !== null || person.workos_user_id !== null) {
      await updateStage(personId, 'exploring');
    }
  }

  if (person.workos_user_id) {
    const wgResult = await query<{ wg_count: number }>(
      `SELECT COUNT(DISTINCT wg.id) as wg_count
       FROM working_groups wg
       WHERE EXISTS(
         SELECT 1 FROM working_group_memberships wgm
         WHERE wgm.working_group_id = wg.id AND wgm.workos_user_id = $1
       )`,
      [person.workos_user_id]
    );
    const wgCount = Number(wgResult.rows[0]?.wg_count ?? 0);

    if (wgCount > 0) {
      await updateStage(personId, 'participating');
    }

    const slackResult = await query<{ slack_messages_30d: number }>(
      `SELECT COALESCE(SUM(message_count), 0) as slack_messages_30d
       FROM slack_activity_daily
       WHERE slack_user_id = (
         SELECT slack_user_id FROM slack_user_mappings WHERE workos_user_id = $1 LIMIT 1
       )
       AND activity_date > NOW() - INTERVAL '30 days'`,
      [person.workos_user_id]
    );
    const slackCount = Number(slackResult.rows[0]?.slack_messages_30d ?? 0);

    if (slackCount > 20) {
      await updateStage(personId, 'contributing');
    }

    const leaderResult = await query<{ is_leader: boolean; council_count: number }>(
      `SELECT
        EXISTS(SELECT 1 FROM working_group_leaders WHERE user_id = $1) as is_leader,
        (SELECT COUNT(DISTINCT wg.id) FROM working_groups wg
         WHERE wg.committee_type = 'council'
         AND EXISTS(
           SELECT 1 FROM working_group_memberships wgm
           WHERE wgm.working_group_id = wg.id AND wgm.workos_user_id = $1
         )) as council_count`,
      [person.workos_user_id]
    );
    const leader = leaderResult.rows[0];

    if (leader && (leader.is_leader || Number(leader.council_count) > 0)) {
      await updateStage(personId, 'leading');
    }
  }
}
