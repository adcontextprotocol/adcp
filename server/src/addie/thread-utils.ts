/**
 * Check if a thread has multiple human participants.
 * Used to avoid auto-responding when humans are talking to each other.
 *
 * Pass currentUserId to count the current sender even if their message
 * hasn't yet appeared in the thread history (race condition with Slack API).
 */
export function isMultiPartyThread(
  messages: Array<{ user?: string }>,
  botUserId: string,
  currentUserId?: string
): boolean {
  const uniqueHumans = new Set(
    messages
      .map(msg => msg.user)
      .filter((user): user is string => !!user && user !== botUserId)
  );
  if (currentUserId && currentUserId !== botUserId) {
    uniqueHumans.add(currentUserId);
  }
  return uniqueHumans.size >= 2;
}

/**
 * Returns true if the message explicitly addresses a user other than the bot.
 * A message starts with `<@UOTHER>` (not Addie's bot ID).
 *
 * Used to prevent Addie from responding in threads where she participated
 * but the current message is directed at someone else — regardless of how
 * many humans are in the thread.
 */
export function isAddressedToAnotherUser(messageText: string, botUserId: string): boolean {
  const match = /^<@(U[A-Z0-9]+)>/.exec(messageText.trim());
  return !!(match && match[1] !== botUserId);
}

/**
 * In a multi-party thread, determine whether a message is directed at Addie.
 *
 * Returns true if:
 * - The message mentions "Addie" by name (word boundary, case-insensitive)
 * - The sender is continuing a back-and-forth with Addie — the most recent
 *   human message (skipping Addie's messages) is also from the same sender.
 *   This check is NOT self-reinforcing because Addie's own responses don't
 *   change who the last human speaker was.
 *
 * Returns false if:
 * - The message starts with a Slack @mention of another user (not the bot),
 *   indicating it is addressed to them, not to Addie.
 */
export function isDirectedAtAddie(
  messageText: string,
  threadMessages: Array<{ user?: string; ts: string }>,
  currentMessageTs: string,
  currentUserId: string,
  botUserId: string
): boolean {
  if (/\baddie\b/i.test(messageText)) {
    return true;
  }

  // If the message starts with a Slack @mention of another user, it's addressed to them.
  const startsWithMention = /^<@(U[A-Z0-9]+)>/.exec(messageText.trim());
  if (startsWithMention && startsWithMention[1] !== botUserId) {
    return false;
  }

  // Find the most recent human message before the current one (skip bot messages).
  // If it's from the same person, they're continuing a conversation with Addie.
  const lastHuman = threadMessages
    .filter(msg => msg.ts !== currentMessageTs && msg.user && msg.user !== botUserId)
    .at(-1);

  return lastHuman?.user === currentUserId;
}
