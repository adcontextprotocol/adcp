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
 * - The sender is continuing a conversation with Addie — walking backwards
 *   past the sender's own consecutive messages and then past Addie's
 *   consecutive responses, the next message is from the sender (meaning
 *   Addie was responding to them). If it's a different human, the sender
 *   is talking to that person, not Addie.
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

  // Walk backwards: skip the sender's consecutive messages, then skip Addie's
  // consecutive responses, and check who's underneath. If it's the sender
  // again, Addie was responding to them (back-and-forth). If it's another
  // human, the sender is talking to that person.
  const prior = threadMessages.filter(msg => msg.ts < currentMessageTs && msg.user);
  let i = prior.length - 1;

  while (i >= 0 && prior[i].user === currentUserId) {
    i--;
  }
  while (i >= 0 && prior[i].user === botUserId) {
    i--;
  }

  if (i < 0) {
    return prior.some(msg => msg.user === botUserId);
  }

  return prior[i].user === currentUserId;
}
