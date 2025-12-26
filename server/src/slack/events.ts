/**
 * Slack Events API handlers
 *
 * Handles events from Slack like team_join, member_joined_channel
 */

import { logger } from '../logger.js';
import { SlackDatabase } from '../db/slack-db.js';
import type { SlackUser } from './types.js';

const slackDb = new SlackDatabase();

// Slack event types
export interface SlackTeamJoinEvent {
  type: 'team_join';
  user: SlackUser;
}

export interface SlackMemberJoinedChannelEvent {
  type: 'member_joined_channel';
  user: string; // user ID
  channel: string; // channel ID
  channel_type: string;
  team: string;
  inviter?: string;
}

export type SlackEvent = SlackTeamJoinEvent | SlackMemberJoinedChannelEvent | { type: string };

export interface SlackEventPayload {
  type: 'event_callback' | 'url_verification';
  challenge?: string;
  token?: string;
  team_id?: string;
  event?: SlackEvent;
  event_id?: string;
  event_time?: number;
}

/**
 * Handle team_join event - new user joined workspace
 * Auto-adds them to our database for mapping
 */
export async function handleTeamJoin(event: SlackTeamJoinEvent): Promise<void> {
  const user = event.user;

  if (!user?.id) {
    logger.warn('team_join event missing user data');
    return;
  }

  logger.info(
    { userId: user.id, email: user.profile?.email, name: user.profile?.real_name },
    'New user joined Slack workspace'
  );

  try {
    const email = user.profile?.email || null;
    const displayName = user.profile?.display_name || user.profile?.display_name_normalized || null;
    const realName = user.profile?.real_name || user.real_name || null;

    // Upsert the user into our database
    await slackDb.upsertSlackUser({
      slack_user_id: user.id,
      slack_email: email,
      slack_display_name: displayName,
      slack_real_name: realName,
      slack_is_bot: user.is_bot || false,
      slack_is_deleted: user.deleted || false,
    });

    // Note: Auto-mapping requires WorkOS lookup which is done via the admin API.
    // New users will appear as "suggested match" if their email matches an AAO user.
    logger.info({ email }, 'New Slack user added, may be auto-linked if email matches');
  } catch (error) {
    logger.error({ error, userId: user.id }, 'Failed to process team_join event');
  }
}

/**
 * Handle member_joined_channel event
 * Can be used for paid-only channel enforcement
 */
export async function handleMemberJoinedChannel(event: SlackMemberJoinedChannelEvent): Promise<void> {
  logger.debug(
    { userId: event.user, channel: event.channel },
    'User joined channel'
  );

  // TODO: Check if channel is paid-only and verify user has subscription
  // For now, just log the event
}

/**
 * Main event dispatcher
 */
export async function handleSlackEvent(payload: SlackEventPayload): Promise<void> {
  const event = payload.event;

  if (!event) {
    logger.warn('Slack event payload missing event object');
    return;
  }

  switch (event.type) {
    case 'team_join':
      await handleTeamJoin(event as SlackTeamJoinEvent);
      break;

    case 'member_joined_channel':
      await handleMemberJoinedChannel(event as SlackMemberJoinedChannelEvent);
      break;

    default:
      logger.debug({ eventType: event.type }, 'Unhandled Slack event type');
  }
}
