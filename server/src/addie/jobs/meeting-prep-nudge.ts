/**
 * Meeting Prep Nudge Job
 *
 * Runs every 4 hours during business hours. Finds scheduled meetings
 * happening in the next 20-30 hours that have agenda content, extracts
 * the most interesting spec question, and DMs working group leaders
 * offering to explore it before the call.
 */

import { createLogger } from '../../logger.js';
import { query } from '../../db/client.js';
import { sendDirectMessage } from '../../slack/client.js';
import { WorkingGroupDatabase } from '../../db/working-group-db.js';
import { SlackDatabase } from '../../db/slack-db.js';
import { complete, isLLMConfigured } from '../../utils/llm.js';
import type { Meeting } from '../../types.js';

const logger = createLogger('meeting-prep-nudge');

/** Cap DMs per run to prevent burst scenarios from bulk meeting creation. */
const MAX_NUDGES_PER_RUN = 10;

interface MeetingPrepNudgeResult {
  meetingsChecked: number;
  nudgesSent: number;
}

interface MeetingWithWg extends Meeting {
  working_group_name: string;
  working_group_slug: string;
}

/**
 * Find scheduled meetings in the next 20-30 hours with agenda content
 * that haven't been nudged yet.
 */
async function findMeetingsToNudge(): Promise<MeetingWithWg[]> {
  const from = new Date(Date.now() + 20 * 60 * 60 * 1000);
  const to = new Date(Date.now() + 30 * 60 * 60 * 1000);

  const result = await query<MeetingWithWg>(
    `SELECT m.*, wg.name as working_group_name, wg.slug as working_group_slug
     FROM meetings m
     JOIN working_groups wg ON wg.id = m.working_group_id
     WHERE m.status = 'scheduled'
       AND m.start_time >= $1
       AND m.start_time <= $2
       AND m.agenda IS NOT NULL
       AND TRIM(m.agenda) != ''
       AND (m.metadata->>'prep_nudged_at' IS NULL)
     ORDER BY m.start_time ASC`,
    [from.toISOString(), to.toISOString()]
  );

  return result.rows;
}

/**
 * Use LLM to extract the most interesting spec/protocol question from a meeting agenda.
 * Returns null if the agenda has no spec-related questions worth exploring.
 */
async function extractSpecQuestion(agenda: string, groupName: string): Promise<string | null> {
  if (!isLLMConfigured()) return null;

  // Truncate agenda to limit prompt injection surface
  const truncatedAgenda = agenda.slice(0, 2000);

  const result = await complete({
    system: `You analyze working group meeting agendas for the AgenticAdvertising.org community, which develops the AdCP (Ad Context Protocol) for agentic advertising.

Extract the single most interesting or technically complex spec/protocol question from this agenda. Look for:
- Open questions about how the protocol should handle edge cases
- Interpretation disputes or ambiguities in the spec
- Architecture decisions that need discussion
- Implementation questions that others might benefit from pre-exploration

If there are no spec-related questions worth exploring (e.g., the agenda is purely administrative), respond with exactly "NONE".

Otherwise, respond with just the question, framed conversationally as something worth thinking about before the meeting. Keep it to 1-2 sentences.`,
    prompt: `Working group: ${groupName}\n\n<agenda>\n${truncatedAgenda}\n</agenda>\n\nExtract the most interesting spec question from the agenda above.`,
    maxTokens: 200,
    model: 'fast',
    operationName: 'meeting-prep-extract-question',
  });

  const text = result.text.trim();
  if (text === 'NONE' || text.length < 10) return null;
  return text;
}

/**
 * Mark a meeting as nudged to prevent duplicate nudges.
 */
async function markMeetingNudged(meetingId: string): Promise<void> {
  await query(
    `UPDATE meetings
     SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
         updated_at = NOW()
     WHERE id = $2`,
    [JSON.stringify({ prep_nudged_at: new Date().toISOString() }), meetingId]
  );
}

/**
 * Resolve a leader's user_id to a Slack user ID.
 * Leaders can be stored with either a Slack ID (U...) or WorkOS ID (user_...).
 */
async function resolveSlackUserId(userId: string, slackDb: SlackDatabase): Promise<string | null> {
  if (userId.startsWith('U') || userId.startsWith('W')) return userId;
  const mapping = await slackDb.getByWorkosUserId(userId);
  return mapping?.slack_user_id || null;
}

export async function runMeetingPrepNudgeJob(): Promise<MeetingPrepNudgeResult> {
  const result: MeetingPrepNudgeResult = { meetingsChecked: 0, nudgesSent: 0 };

  const meetings = await findMeetingsToNudge();
  result.meetingsChecked = meetings.length;

  if (meetings.length === 0) {
    logger.debug('No meetings need prep nudges');
    return result;
  }

  const workingGroupDb = new WorkingGroupDatabase();
  const slackDb = new SlackDatabase();

  for (const meeting of meetings) {
    if (result.nudgesSent >= MAX_NUDGES_PER_RUN) {
      logger.info({ remaining: meetings.length - result.meetingsChecked }, 'Hit nudge cap, deferring remaining');
      break;
    }

    try {
      const question = await extractSpecQuestion(meeting.agenda!, meeting.working_group_name);
      if (!question) {
        // Agenda has no spec questions worth exploring — mark nudged to skip next time
        await markMeetingNudged(meeting.id);
        continue;
      }

      // Ensure the extracted question ends with punctuation for clean message formatting
      const trimmedQuestion = question.endsWith('?') || question.endsWith('.') ? question : `${question}.`;

      const leaders = await workingGroupDb.getLeaders(meeting.working_group_id);

      for (const leader of leaders) {
        if (!leader.user_id) continue;

        const slackUserId = await resolveSlackUserId(leader.user_id, slackDb);
        if (!slackUserId) {
          logger.debug({ leader: leader.name, userId: leader.user_id }, 'Could not resolve Slack ID for leader');
          continue;
        }

        const firstName = leader.name?.split(' ')[0] || 'there';
        const message = `Hi ${firstName} -- the ${meeting.working_group_name} meeting tomorrow has an interesting topic on the agenda: ${trimmedQuestion} Want to think through it together before the call? I can pull up the relevant spec sections and we can work through it here.`;

        try {
          await sendDirectMessage(slackUserId, { text: message });
          result.nudgesSent++;
        } catch (err) {
          logger.warn({ error: err, leader: leader.name, meeting: meeting.title }, 'Failed to send prep nudge DM');
        }
      }

      await markMeetingNudged(meeting.id);
    } catch (err) {
      logger.error({ error: err, meetingId: meeting.id, meeting: meeting.title }, 'Failed to process meeting for prep nudge');
    }
  }

  if (result.nudgesSent > 0) {
    logger.info({ nudgesSent: result.nudgesSent, meetingsChecked: result.meetingsChecked }, 'Meeting prep nudges sent');
  }

  return result;
}
