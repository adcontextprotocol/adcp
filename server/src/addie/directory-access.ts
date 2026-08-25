import type { MemberContext } from './member-context.js';

export type SlackDirectoryAudience = 'dm' | 'mention' | 'channel';

/**
 * Scope directory access to everyone who can read the eventual Slack reply.
 * A DM is private to the caller and Addie. Channel replies are always
 * public-only because even a private or same-workspace channel can contain
 * Explorer-tier users, guests, or external Slack Connect participants.
 */
export function resolveSlackDirectoryContext(
  memberContext: MemberContext | null,
  audience: SlackDirectoryAudience | undefined,
): MemberContext | null {
  return audience === 'dm' ? memberContext : null;
}
