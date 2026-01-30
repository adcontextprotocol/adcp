/**
 * Slack Events API handlers
 *
 * Handles events from Slack like team_join, member_joined_channel, message
 * Also routes events to Addie (AAO's Community Agent) for Assistant and @mention handling
 */

import { logger } from '../logger.js';
import { SlackDatabase } from '../db/slack-db.js';
import { AddieDatabase } from '../db/addie-db.js';
import { WorkingGroupDatabase } from '../db/working-group-db.js';
import { getPool } from '../db/client.js';
import type { SlackUser } from './types.js';
import { getSlackUser, getChannelInfo } from './client.js';
import { syncUserToChaptersFromSlackChannels } from './sync.js';
import { invalidateUnifiedUsersCache } from '../cache/unified-users.js';
import { invalidateMemberContextCache } from '../addie/index.js';
import { invalidateWebAdminStatusCache } from '../addie/mcp/admin-tools.js';
import {
  isAddieReady,
  handleAssistantThreadStarted,
  handleAssistantMessage,
  handleAppMention,
  type AssistantThreadStartedEvent,
  type AppMentionEvent,
  type AssistantMessageEvent,
} from '../addie/index.js';
import { queueForNoteExtraction } from '../addie/services/passive-note-extractor.js';

const slackDb = new SlackDatabase();
const addieDb = new AddieDatabase();
const workingGroupDb = new WorkingGroupDatabase();

// Slack event types
export interface SlackTeamJoinEvent {
  type: 'team_join';
  user: SlackUser;
}

export interface SlackUserChangeEvent {
  type: 'user_change';
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
  | SlackUserChangeEvent
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
 * Auto-adds them to our database and auto-maps by email if they have a web account
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
      slack_tz_offset: user.tz_offset ?? null,
    });

    // Auto-map by email if they have a web account
    if (email) {
      await tryAutoMapByEmail(user.id, email);
    }

    logger.info({ email }, 'New Slack user added');
  } catch (error) {
    logger.error({ error, userId: user.id }, 'Failed to process team_join event');
  }
}

/**
 * Handle user_change event - user profile was updated
 * Updates our database with the new profile data
 */
export async function handleUserChange(event: SlackUserChangeEvent): Promise<void> {
  const user = event.user;

  if (!user?.id) {
    logger.warn('user_change event missing user data');
    return;
  }

  logger.debug(
    { userId: user.id, email: user.profile?.email, name: user.profile?.real_name },
    'Slack user profile changed'
  );

  try {
    const email = user.profile?.email || null;
    const displayName = user.profile?.display_name || user.profile?.display_name_normalized || null;
    const realName = user.profile?.real_name || user.real_name || null;

    // Upsert the user into our database with updated profile
    await slackDb.upsertSlackUser({
      slack_user_id: user.id,
      slack_email: email,
      slack_display_name: displayName,
      slack_real_name: realName,
      slack_is_bot: user.is_bot || false,
      slack_is_deleted: user.deleted || false,
      slack_tz_offset: user.tz_offset ?? null,
    });

    // Invalidate caches since user data changed
    invalidateUnifiedUsersCache();
    invalidateMemberContextCache(user.id);

    logger.debug({ userId: user.id }, 'Slack user profile updated');
  } catch (error) {
    logger.error({ error, userId: user.id }, 'Failed to process user_change event');
  }
}

/**
 * Try to auto-map a Slack user to a web user by email
 * Maps them if the email matches and neither account is already mapped
 */
async function tryAutoMapByEmail(slackUserId: string, email: string): Promise<void> {
  try {
    const pool = getPool();

    // Look up the web user by email
    const result = await pool.query<{ workos_user_id: string }>(
      `SELECT workos_user_id FROM organization_memberships WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [email]
    );

    if (result.rows.length === 0) {
      logger.debug({ email }, 'No web account found for Slack user email');
      return;
    }

    const workosUserId = result.rows[0].workos_user_id;

    // Check if this WorkOS user is already mapped to a different Slack user
    const existingWorkosMapping = await slackDb.getByWorkosUserId(workosUserId);
    if (existingWorkosMapping) {
      logger.debug(
        { email, workosUserId, existingSlackUserId: existingWorkosMapping.slack_user_id },
        'Web user already mapped to different Slack account'
      );
      return;
    }

    // Check if this Slack user is already mapped (race condition guard)
    const existingSlackMapping = await slackDb.getBySlackUserId(slackUserId);
    if (existingSlackMapping?.workos_user_id) {
      logger.debug(
        { slackUserId, existingWorkosUserId: existingSlackMapping.workos_user_id },
        'Slack user already mapped to a web account'
      );
      return;
    }

    // Map the user
    await slackDb.mapUser({
      slack_user_id: slackUserId,
      workos_user_id: workosUserId,
      mapping_source: 'email_auto',
    });

    logger.info({ slackUserId, workosUserId, email }, 'Auto-mapped Slack user to web account by email');

    // Sync user to chapters based on their Slack channel memberships
    const chapterSyncResult = await syncUserToChaptersFromSlackChannels(workosUserId, slackUserId);
    if (chapterSyncResult.chapters_joined > 0) {
      logger.info(
        { workosUserId, chaptersJoined: chapterSyncResult.chapters_joined },
        'Auto-synced user to chapters from Slack channels'
      );
    }

    // Invalidate caches
    invalidateUnifiedUsersCache();
    invalidateMemberContextCache(slackUserId);
  } catch (error) {
    logger.error({ error, slackUserId, email }, 'Failed to auto-map Slack user by email');
  }
}

/**
 * Handle member_joined_channel event
 * Records channel join activity for engagement tracking
 * Also auto-adds users to working groups (chapters/events) when they join linked Slack channels
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

    // Check if this channel is linked to a working group (chapter or event)
    // and auto-add the user if they have a WorkOS mapping
    if (mapping?.workos_user_id) {
      const isPrivateChannel = event.channel_type === 'G';
      await autoAddToWorkingGroup(event.channel, mapping.workos_user_id, mapping, isPrivateChannel);
    }
  } catch (error) {
    logger.error({ error, userId: event.user }, 'Failed to record channel join activity');
  }
}

/**
 * Auto-add user to a working group when they join its Slack channel
 * This enables "join channel = join group" for all committee types
 *
 * For private committees, we only auto-add if the Slack channel is also private,
 * since Slack already enforces access control for private channels.
 */
async function autoAddToWorkingGroup(
  channelId: string,
  workosUserId: string,
  slackMapping: { slack_email?: string | null; slack_real_name?: string | null; slack_display_name?: string | null },
  isPrivateSlackChannel: boolean
): Promise<void> {
  try {
    // Check if this channel is linked to a working group
    const workingGroup = await workingGroupDb.getWorkingGroupBySlackChannelId(channelId);

    if (!workingGroup) {
      // Channel not linked to any working group
      return;
    }

    // Skip auto-add for private committees unless the Slack channel is also private
    // (private Slack channels already enforce access control)
    if (workingGroup.is_private && !isPrivateSlackChannel) {
      logger.debug(
        { workingGroupId: workingGroup.id, name: workingGroup.name },
        'Skipping auto-add: committee is private but Slack channel is public'
      );
      return;
    }

    // Check if already a member
    const isMember = await workingGroupDb.isMember(workingGroup.id, workosUserId);
    if (isMember) {
      logger.debug(
        { workingGroupId: workingGroup.id, userId: workosUserId },
        'User already a member of working group'
      );
      return;
    }

    // Set interest level for industry gatherings (other committee types don't track interest)
    const interestLevel = workingGroup.committee_type === 'industry_gathering' ? 'interested' : undefined;
    const interestSource = 'slack_join';

    await workingGroupDb.addMembershipWithInterest({
      working_group_id: workingGroup.id,
      workos_user_id: workosUserId,
      user_email: slackMapping.slack_email || undefined,
      user_name: slackMapping.slack_real_name || slackMapping.slack_display_name || undefined,
      interest_level: interestLevel,
      interest_source: interestSource,
    });
    invalidateWebAdminStatusCache(workosUserId);

    logger.info(
      {
        workingGroupId: workingGroup.id,
        workingGroupName: workingGroup.name,
        userId: workosUserId,
        type: workingGroup.committee_type,
      },
      'Auto-added user to working group via Slack channel join'
    );
  } catch (error) {
    logger.error(
      { error, channelId, userId: workosUserId },
      'Failed to auto-add user to working group'
    );
  }
}

/**
 * Handle message event
 * Records message activity for engagement tracking
 * Also routes DM messages to Addie for Assistant thread handling
 * Indexes public channel messages for Addie's local search
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

    // Index channel messages for Addie's local search
    // Public channels: always index
    // Private channels (group): only index if linked to a working group (for fast local access checks)
    const isPublicChannel = event.channel_type === 'channel';
    const isPrivateChannel = event.channel_type === 'group';

    let shouldIndex = false;
    if (isPublicChannel) {
      shouldIndex = true;
    } else if (isPrivateChannel) {
      // Only index private channels that have a working group (enables fast local access checks)
      const workingGroup = await workingGroupDb.getWorkingGroupBySlackChannelId(event.channel);
      shouldIndex = !!workingGroup;
      if (!shouldIndex) {
        logger.debug({ channelId: event.channel }, 'Skipping private channel without working group');
      }
    }

    if (shouldIndex && event.text && event.text.length > 20) {
      await indexMessageForSearch(event);

      // Queue for passive note extraction (async, rate-limited)
      // This extracts interesting tidbits from channel conversations
      const channel = await getChannelInfo(event.channel);
      queueForNoteExtraction({
        slackUserId: event.user,
        workosUserId: mapping?.workos_user_id ?? undefined,
        channelId: event.channel,
        channelName: channel?.name,
        messageText: event.text,
        messageTs: event.ts,
      });
    }
  } catch (error) {
    logger.error({ error, userId: event.user }, 'Failed to record message activity');
  }
}

/**
 * Index a Slack message for local full-text search
 * Fetches user/channel info and stores in addie_knowledge
 */
async function indexMessageForSearch(event: SlackMessageEvent): Promise<void> {
  try {
    // Fetch user and channel info in parallel
    const [user, channel] = await Promise.all([
      getSlackUser(event.user!),
      getChannelInfo(event.channel),
    ]);

    if (!user || !channel) {
      logger.debug(
        { userId: event.user, channelId: event.channel },
        'Skipping message index: could not fetch user or channel info'
      );
      return;
    }

    // Construct permalink
    // Format: https://workspace.slack.com/archives/CHANNEL_ID/pTIMESTAMP
    // The timestamp needs dots removed
    const tsForLink = event.ts.replace('.', '');
    const permalink = `https://agenticads.slack.com/archives/${event.channel}/p${tsForLink}`;

    await addieDb.indexSlackMessage({
      channel_id: event.channel,
      channel_name: channel.name || 'unknown',
      user_id: event.user!,
      username: user.profile?.display_name || user.profile?.real_name || user.name || 'unknown',
      ts: event.ts,
      text: event.text!,
      permalink,
    });

    logger.debug(
      { channelName: channel.name, username: user.name },
      'Indexed Slack message for search'
    );
  } catch (error) {
    // Don't fail the main event handler if indexing fails
    logger.error({ error, channelId: event.channel }, 'Failed to index Slack message for search');
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

    case 'user_change':
      await handleUserChange(event as SlackUserChangeEvent);
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
