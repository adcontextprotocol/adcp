/**
 * Slack slash command handlers
 *
 * Handles /aao commands from Slack users
 */

import { WorkOS } from '@workos-inc/node';
import { logger } from '../logger.js';
import { SlackDatabase } from '../db/slack-db.js';
import { OrganizationDatabase } from '../db/organization-db.js';
import type { SlackSlashCommand } from './types.js';

// Initialize WorkOS client for user membership lookups
const workos = process.env.WORKOS_API_KEY ? new WorkOS(process.env.WORKOS_API_KEY) : null;

const slackDb = new SlackDatabase();
const orgDb = new OrganizationDatabase();

// Slack Block Kit types - simplified for command responses
// Using Record<string, unknown> for flexibility with Slack's dynamic block structure
type SlackBlockElement = Record<string, unknown>;

export interface CommandResponse {
  response_type?: 'in_channel' | 'ephemeral';
  text: string;
  blocks?: SlackBlockElement[];
}

/**
 * Parse the slash command and route to appropriate handler
 */
export async function handleSlashCommand(command: SlackSlashCommand): Promise<CommandResponse> {
  const subcommand = command.text.trim().toLowerCase().split(/\s+/)[0] || 'help';

  logger.info(
    { command: command.command, subcommand, userId: command.user_id, userName: command.user_name },
    'Processing Slack command'
  );

  switch (subcommand) {
    case 'status':
      return handleStatusCommand(command);
    case 'whoami':
      return handleWhoamiCommand(command);
    case 'link':
      return handleLinkCommand(command);
    case 'help':
    default:
      return handleHelpCommand(command);
  }
}

/**
 * /aao help - Show available commands
 */
async function handleHelpCommand(_command: SlackSlashCommand): Promise<CommandResponse> {
  return {
    response_type: 'ephemeral',
    text: 'AAO Slack Commands',
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: 'AAO Slack Commands',
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Available commands:',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*`/aao status`*\nCheck your AAO membership and subscription status',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*`/aao whoami`*\nShow your linked AAO account info',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*`/aao link`*\nGet instructions to link your Slack account to AAO',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*`/aao help`*\nShow this help message',
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'Need help? Contact us at <https://agenticadvertising.org|agenticadvertising.org>',
          },
        ],
      },
    ],
  };
}

/**
 * /aao status - Check subscription status
 */
async function handleStatusCommand(command: SlackSlashCommand): Promise<CommandResponse> {
  try {
    // Look up user mapping
    const mapping = await slackDb.getBySlackUserId(command.user_id);

    if (!mapping || !mapping.workos_user_id) {
      return {
        response_type: 'ephemeral',
        text: 'Your Slack account is not linked to an AAO account',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: ':warning: *Your Slack account is not linked to an AAO account*',
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: 'To check your status, first link your Slack account to your AAO account.\n\nUse `/aao link` for instructions, or sign up at <https://agenticadvertising.org|agenticadvertising.org>',
            },
          },
        ],
      };
    }

    // Get all organizations for this user
    const userOrgs = await getOrganizationsForUser(mapping.workos_user_id);

    if (userOrgs.length === 0) {
      return {
        response_type: 'ephemeral',
        text: 'Account linked but no organizations found',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: ':link: *Account Linked*',
            },
          },
          {
            type: 'section',
            fields: [
              {
                type: 'mrkdwn',
                text: `*Slack Account:*\n${command.user_name}`,
              },
              {
                type: 'mrkdwn',
                text: `*AAO Account:*\nLinked`,
              },
            ],
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: ':x: *Organizations:* None found\n\nVisit <https://agenticadvertising.org/dashboard|your dashboard> to join or create an organization.',
            },
          },
        ],
      };
    }

    // Build organization blocks - show all orgs the user belongs to
    const orgBlocks: SlackBlockElement[] = userOrgs.map(org => {
      const statusEmoji = org.status === 'active' ? ':white_check_mark:' : ':large_orange_circle:';
      const statusText = org.status === 'active' ? 'Active' : (org.status === 'none' ? 'No subscription' : org.status);
      const planText = org.product_name ? ` (${org.product_name})` : '';

      return {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${statusEmoji} *${org.org_name}*\nSubscription: ${statusText}${planText}${org.renews_at ? `\nRenews: ${org.renews_at}` : ''}`,
        },
      };
    });

    // Check if any org has an active subscription
    const hasActiveSubscription = userOrgs.some(org => org.status === 'active');
    const headerEmoji = hasActiveSubscription ? ':white_check_mark:' : ':large_orange_circle:';

    return {
      response_type: 'ephemeral',
      text: `Your AAO Status`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${headerEmoji} *Your AAO Status*`,
          },
        },
        {
          type: 'divider',
        },
        ...orgBlocks,
        {
          type: 'divider',
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'View Dashboard',
                emoji: true,
              },
              url: 'https://agenticadvertising.org/dashboard',
            },
          ],
        },
      ],
    };
  } catch (error) {
    logger.error({ error, userId: command.user_id }, 'Error handling status command');
    return {
      response_type: 'ephemeral',
      text: 'Sorry, there was an error checking your status. Please try again later.',
    };
  }
}

/**
 * /aao whoami - Show linked account info
 */
async function handleWhoamiCommand(command: SlackSlashCommand): Promise<CommandResponse> {
  try {
    const mapping = await slackDb.getBySlackUserId(command.user_id);

    if (!mapping) {
      return {
        response_type: 'ephemeral',
        text: 'Your Slack account is not in our system yet',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: ':question: *Account Not Found*\n\nYour Slack account is not yet synced with AAO. An admin may need to sync Slack users first.',
            },
          },
        ],
      };
    }

    if (!mapping.workos_user_id) {
      return {
        response_type: 'ephemeral',
        text: 'Your Slack account is not linked to an AAO account',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: ':link: *Account Not Linked*',
            },
          },
          {
            type: 'section',
            fields: [
              {
                type: 'mrkdwn',
                text: `*Slack User:*\n${mapping.slack_real_name || mapping.slack_display_name || command.user_name}`,
              },
              {
                type: 'mrkdwn',
                text: `*Slack Email:*\n${mapping.slack_email || 'Not available'}`,
              },
            ],
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: 'Use `/aao link` to link your Slack account to your AAO account.',
            },
          },
        ],
      };
    }

    // Get all organizations for this user
    const userOrgs = await getOrganizationsForUser(mapping.workos_user_id);

    // Build organization list text
    const orgsText = userOrgs.length > 0
      ? userOrgs.map(org => org.org_name).join(', ')
      : 'None';

    return {
      response_type: 'ephemeral',
      text: 'Your AAO account info',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: ':white_check_mark: *Account Linked*',
          },
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*Slack User:*\n${mapping.slack_real_name || mapping.slack_display_name || command.user_name}`,
            },
            {
              type: 'mrkdwn',
              text: `*Slack Email:*\n${mapping.slack_email || 'Not available'}`,
            },
          ],
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*AAO Organizations:*\n${orgsText}`,
            },
            {
              type: 'mrkdwn',
              text: `*Linked:*\n${mapping.mapping_source === 'email_auto' ? 'Automatic (email match)' : 'Manual'}`,
            },
          ],
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Linked on ${mapping.mapped_at ? new Date(mapping.mapped_at).toLocaleDateString() : 'Unknown date'}`,
            },
          ],
        },
      ],
    };
  } catch (error) {
    logger.error({ error, userId: command.user_id }, 'Error handling whoami command');
    return {
      response_type: 'ephemeral',
      text: 'Sorry, there was an error getting your account info. Please try again later.',
    };
  }
}

/**
 * /aao link - Instructions to link accounts
 *
 * If the user doesn't have an AAO account, sends them to signup with their
 * slack_user_id so they can be auto-linked after registration.
 */
async function handleLinkCommand(command: SlackSlashCommand): Promise<CommandResponse> {
  try {
    const mapping = await slackDb.getBySlackUserId(command.user_id);

    if (mapping?.workos_user_id) {
      return {
        response_type: 'ephemeral',
        text: 'Your account is already linked',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: ':white_check_mark: *Your Slack account is already linked to AAO*\n\nUse `/aao status` to check your subscription status.',
            },
          },
        ],
      };
    }

    // Build login URL with slack_user_id for auto-linking after authentication
    const loginUrl = `https://agenticadvertising.org/auth/login?slack_user_id=${encodeURIComponent(command.user_id)}`;

    return {
      response_type: 'ephemeral',
      text: 'Link your Slack account to AAO',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: ':link: *Link Your Slack Account to AAO*',
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'Click the button below to sign in to AAO. Your Slack account will be automatically linked.',
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Sign In to AAO',
                emoji: true,
              },
              url: loginUrl,
              style: 'primary',
            },
          ],
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: "Don't have an account? You can sign up on the next page.",
            },
          ],
        },
      ],
    };
  } catch (error) {
    logger.error({ error, userId: command.user_id }, 'Error handling link command');
    return {
      response_type: 'ephemeral',
      text: 'Sorry, there was an error. Please try again later.',
    };
  }
}

interface OrgInfo {
  org_name: string;
  status: string;
  product_name?: string;
  renews_at?: string;
}

/**
 * Helper to get all organizations a WorkOS user belongs to
 */
async function getOrganizationsForUser(workosUserId: string): Promise<OrgInfo[]> {
  try {
    if (!workos) {
      logger.warn('WorkOS client not initialized, cannot get organization info');
      return [];
    }

    // Get the user's actual organization memberships from WorkOS
    const memberships = await workos.userManagement.listOrganizationMemberships({
      userId: workosUserId,
    });

    if (memberships.data.length === 0) {
      logger.debug({ workosUserId }, 'User has no organization memberships');
      return [];
    }

    // Get the WorkOS org IDs the user belongs to
    const userWorkosOrgIds = new Set(memberships.data.map(m => m.organizationId));

    // Get all organizations from our database
    const orgs = await orgDb.listOrganizations();

    // Find all orgs that the user belongs to
    const userOrgs: OrgInfo[] = [];
    for (const org of orgs) {
      if (org.workos_organization_id && userWorkosOrgIds.has(org.workos_organization_id)) {
        const renewsAt = org.subscription_current_period_end
          ? new Date(org.subscription_current_period_end).toLocaleDateString()
          : undefined;

        userOrgs.push({
          org_name: org.name,
          status: org.subscription_status || 'none',
          product_name: org.subscription_product_name || undefined,
          renews_at: renewsAt,
        });
      }
    }

    return userOrgs;
  } catch (error) {
    logger.error({ error, workosUserId }, 'Error getting organization info');
    return [];
  }
}
