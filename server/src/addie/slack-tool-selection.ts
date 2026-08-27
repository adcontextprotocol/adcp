export type SlackToolSource = 'dm' | 'mention' | 'channel';
export type SystemChannelRole = 'prospect' | 'escalation' | 'billing' | 'error' | 'admin';

export const ADMIN_CHANNEL_WG_SLUG = 'aao-admin';

/** Tool sets required by server-owned channel configuration. */
export const SYSTEM_CHANNEL_TOOL_SETS: Readonly<Record<SystemChannelRole, readonly string[]>> = {
  prospect: ['admin_prospects', 'outreach'],
  // Escalation tools are already in ALWAYS_AVAILABLE_ADMIN_TOOLS.
  escalation: [],
  billing: ['billing'],
  error: ['admin_workflows'],
  // Generic admin channels rely on the router's bounded domain selection.
  admin: [],
};

export interface SlackToolSetSelectionInput {
  routerSelectedSets?: readonly string[];
  routerAvailable: boolean;
  source: SlackToolSource;
  isAdmin: boolean;
  workingGroupSlug?: string | null;
  systemRole?: SystemChannelRole | null;
  /** Active certification modules override normal routing only in DMs. */
  hasActiveCertification?: boolean;
}

export function hasActiveCertificationProgress(
  progress: readonly { status: string }[],
): boolean {
  return progress.some((entry) => entry.status === 'in_progress');
}

function appendUnique(target: string[], values: readonly string[]): void {
  for (const value of values) {
    if (!target.includes(value)) target.push(value);
  }
}

/** Apply server-owned Slack routing rules after the router proposes sets. */
export function selectSlackToolSets(input: SlackToolSetSelectionInput): string[] {
  if (input.source === 'dm' && input.hasActiveCertification) {
    return ['certification', 'knowledge'];
  }

  const selected = input.routerAvailable
    ? [...(input.routerSelectedSets ?? [])]
    : ['knowledge'];

  if (input.isAdmin && input.systemRole) {
    appendUnique(selected, SYSTEM_CHANNEL_TOOL_SETS[input.systemRole] ?? []);
  }

  return selected;
}

/** Normalize Slack conversation privacy, including DM shapes that omit is_private. */
export function resolveSlackChannelPrivacy(channel: {
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
}): boolean | null {
  if (channel.is_im === true || channel.is_mpim === true) return true;
  return typeof channel.is_private === 'boolean' ? channel.is_private : null;
}

/** Resolve privacy-sensitive channel context without exposing resolver errors. */
export async function resolveRequiredSlackChannelContext<
  T extends { viewing_channel_is_private?: boolean },
>(
  channelId: string,
  resolver: (id: string) => Promise<T>,
): Promise<T | null> {
  try {
    const context = await resolver(channelId);
    return typeof context.viewing_channel_is_private === 'boolean'
      ? context
      : null;
  } catch {
    return null;
  }
}
