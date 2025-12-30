/**
 * Slack Events API handlers
 *
 * Handles events from Slack like team_join, member_joined_channel, message
 * Also routes events to Addie (AAO's Community Agent) for Assistant and @mention handling
 */

import { logger } from '../logger.js';
import { SlackDatabase } from '../db/slack-db.js';
import type { SlackUser } from './types.js';
import {
  isAddieReady,
  handleAssistantThreadStarted,
  handleAssistantMessage,
  handleAppMention,
  type AssistantThreadStartedEvent,
  type AppMentionEvent,
  type AssistantMessageEvent,
} from '../addie/index.js';

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

export interface SlackMessageEvent {
  type: 'message';
  subtype?: string;
  user?: string;
  bot_id?: string; // Present when message is from a bot
  channel: string;
  ts: string;
  thread_ts?: string;
  text?: string;
  channel_type?: string;
}

export interface SlackReactionAddedEvent {
  type: 'reaction_added';
  user: string;
  reaction: string;
  item: {
    type: string;
    channel: string;
    ts: string;
  };
  item_user?: string;
  event_ts: string;
}

// Slack Assistant event types
export interface SlackAssistantThreadStartedEvent {
  type: 'assistant_thread_started';
  assistant_thread: {
    user_id: string;
    context: {
      channel_id: string;
      team_id: string;
      enterprise_id?: string;
    };
  };
  event_ts: string;
  channel: string;
}

export interface SlackAppMentionEvent {
  type: 'app_mention';
  user: string;
  text: string;
  ts: string;
  channel: string;
  thread_ts?: string;
  event_ts: string;
}

export type SlackEvent =
  | SlackTeamJoinEvent
  | SlackMemberJoinedChannelEvent
  | SlackMessageEvent
  | SlackReactionAddedEvent
  | SlackAssistantThreadStartedEvent
  | SlackAppMentionEvent
  | { type: string };

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
 * Records channel join activity for engagement tracking
 */
export async function handleMemberJoinedChannel(event: SlackMemberJoinedChannelEvent): Promise<void> {
  logger.debug(
    { userId: event.user, channel: event.channel },
    'User joined channel'
  );

  try {
    // Get user's org mapping if they're linked
    const mapping = await slackDb.getBySlackUserId(event.user);
    let organizationId: string | undefined;

    if (mapping?.workos_user_id) {
      // Note: Would need to lookup org from WorkOS - for now just record without org
      // This could be enhanced with a cache or join table
    }

    await slackDb.recordActivity({
      slack_user_id: event.user,
      activity_type: 'channel_join',
      channel_id: event.channel,
      activity_timestamp: new Date(),
      organization_id: organizationId,
      metadata: {
        channel_type: event.channel_type,
        inviter: event.inviter,
      },
    });
  } catch (error) {
    logger.error({ error, userId: event.user }, 'Failed to record channel join activity');
  }
}

/**
 * Handle message event
 * Records message activity for engagement tracking
 * Also routes DM messages to Addie for Assistant thread handling
 */
export async function handleMessage(event: SlackMessageEvent): Promise<void> {
  // Skip bot messages (including Addie's own messages), message edits/deletes, etc.
  // The bot_id field is present when a bot sends a message
  if (event.subtype || !event.user || event.bot_id) {
    if (event.bot_id) {
      logger.debug({ bot_id: event.bot_id, channel: event.channel }, 'Ignoring bot message');
    }
    return;
  }

  // Route DM messages to Addie if ready (Assistant thread messages)
  if (event.channel_type === 'im' && isAddieReady() && event.text) {
    logger.debug(
      { userId: event.user, channel: event.channel },
      'Routing DM to Addie'
    );
    await handleAssistantMessage(
      {
        type: 'message',
        user: event.user,
        text: event.text,
        ts: event.ts,
        thread_ts: event.thread_ts || event.ts,
        channel_type: 'im',
      } as AssistantMessageEvent,
      event.channel
    );
    // Don't return - still record the activity below
  }

  logger.debug(
    { userId: event.user, channel: event.channel, hasThread: !!event.thread_ts },
    'User sent message'
  );

  try {
    // Get user's org mapping if they're linked
    const mapping = await slackDb.getBySlackUserId(event.user);
    let organizationId: string | undefined;

    if (mapping?.workos_user_id) {
      // Note: Would need to lookup org from WorkOS - for now just record without org
    }

    // Determine if this is a thread reply or a new message
    const isThreadReply = event.thread_ts && event.thread_ts !== event.ts;
    const activityType = isThreadReply ? 'thread_reply' : 'message';

    await slackDb.recordActivity({
      slack_user_id: event.user,
      activity_type: activityType,
      channel_id: event.channel,
      activity_timestamp: new Date(parseFloat(event.ts) * 1000),
      organization_id: organizationId,
      metadata: {
        channel_type: event.channel_type,
        is_thread_reply: isThreadReply,
        message_length: event.text?.length || 0,
      },
    });
  } catch (error) {
    logger.error({ error, userId: event.user }, 'Failed to record message activity');
  }
}

/**
 * Handle reaction_added event
 * Records reaction activity for engagement tracking
 */
export async function handleReactionAdded(event: SlackReactionAddedEvent): Promise<void> {
  logger.debug(
    { userId: event.user, reaction: event.reaction, channel: event.item.channel },
    'User added reaction'
  );

  try {
    // Get user's org mapping if they're linked
    const mapping = await slackDb.getBySlackUserId(event.user);
    let organizationId: string | undefined;

    if (mapping?.workos_user_id) {
      // Note: Would need to lookup org from WorkOS - for now just record without org
    }

    await slackDb.recordActivity({
      slack_user_id: event.user,
      activity_type: 'reaction',
      channel_id: event.item.channel,
      activity_timestamp: new Date(parseFloat(event.event_ts) * 1000),
      organization_id: organizationId,
      metadata: {
        reaction: event.reaction,
        item_type: event.item.type,
      },
    });
  } catch (error) {
    logger.error({ error, userId: event.user }, 'Failed to record reaction activity');
  }
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

    case 'message':
      await handleMessage(event as SlackMessageEvent);
      break;

    case 'reaction_added':
      await handleReactionAdded(event as SlackReactionAddedEvent);
      break;

    // Addie (AAO Community Agent) events
    case 'assistant_thread_started':
      if (isAddieReady()) {
        const assistantEvent = event as SlackAssistantThreadStartedEvent;
        await handleAssistantThreadStarted({
          type: 'assistant_thread_started',
          assistant_thread: assistantEvent.assistant_thread,
          event_ts: assistantEvent.event_ts,
          channel_id: assistantEvent.channel,
        } as AssistantThreadStartedEvent);
      } else {
        logger.debug('Addie not ready, ignoring assistant_thread_started');
      }
      break;

    case 'app_mention':
      if (isAddieReady()) {
        const mentionEvent = event as SlackAppMentionEvent;
        await handleAppMention({
          type: 'app_mention',
          user: mentionEvent.user,
          text: mentionEvent.text,
          ts: mentionEvent.ts,
          channel: mentionEvent.channel,
          thread_ts: mentionEvent.thread_ts,
          event_ts: mentionEvent.event_ts,
        } as AppMentionEvent);
      } else {
        logger.debug('Addie not ready, ignoring app_mention');
      }
      break;

    default:
      logger.debug({ eventType: event.type }, 'Unhandled Slack event type');
  }
}
