/**
 * Check if a thread has multiple human participants.
 * Used to avoid auto-responding when humans are talking to each other.
 */
export function isMultiPartyThread(
  messages: Array<{ user?: string }>,
  botUserId: string
): boolean {
  const uniqueHumans = new Set(
    messages
      .map(msg => msg.user)
      .filter((user): user is string => !!user && user !== botUserId)
  );
  return uniqueHumans.size >= 2;
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

  // Find the most recent human message before the current one (skip bot messages).
  // If it's from the same person, they're continuing a conversation with Addie.
  const lastHuman = threadMessages
    .filter(msg => msg.ts !== currentMessageTs && msg.user && msg.user !== botUserId)
    .at(-1);

  return lastHuman?.user === currentUserId;
}
