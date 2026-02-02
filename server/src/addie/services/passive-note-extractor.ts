/**
 * Passive Note Extractor Service
 *
 * Watches public channels Addie is in and extracts interesting tidbits
 * about what people say - stored as text notes, not structured insights.
 *
 * Key differences from insight-extractor.ts:
 * - Passive: doesn't respond, just observes
 * - Simpler: only extracts 'note' type insights
 * - Rate-limited: uses a queue to avoid overwhelming the LLM API
 * - Conservative: only extracts notable/interesting statements
 */

import { logger } from '../../logger.js';
import { InsightsDatabase, type InsightConfidence } from '../../db/insights-db.js';
import { isLLMConfigured, complete } from '../../utils/llm.js';
import { invalidateInsightsCache } from '../insights-cache.js';

const insightsDb = new InsightsDatabase();

// Rate limiting: process one message every 5 seconds
const RATE_LIMIT_MS = 5000;
const MIN_MESSAGE_LENGTH = 50;

// Queue for rate-limited processing
interface QueueItem {
  slackUserId: string;
  workosUserId?: string;
  channelId: string;
  channelName?: string;
  messageText: string;
  messageTs: string;
}

const queue: QueueItem[] = [];
let processing = false;

/**
 * Check if a message is worth analyzing for notes
 */
function shouldAnalyzeForNotes(text: string): boolean {
  // Too short
  if (text.length < MIN_MESSAGE_LENGTH) return false;

  // Mostly mentions or links
  const mentionCount = (text.match(/<[@#!][^>]+>/g) || []).length;
  if (mentionCount > 2) return false;

  // Pure questions to the group (not revealing anything about themselves)
  if (/^(does anyone|has anyone|can someone|who knows|what is|how do|where can)/i.test(text.trim())) {
    return false;
  }

  // Just a reaction or short acknowledgment
  if (/^(lol|haha|nice|great|thanks|agreed|yep|yes|no|ok|okay|cool|interesting)[!?.]*$/i.test(text.trim())) {
    return false;
  }

  return true;
}

/**
 * Build prompt for extracting a notable tidbit
 */
function buildNoteExtractionPrompt(message: string, channelName?: string): string {
  return `Analyze this public Slack message from ${channelName ? `#${channelName}` : 'a channel'}.

**Message:**
${message}

**Task:**
Determine if this message reveals something notable about the person who wrote it - their interests, what they're working on, their opinions, or their goals.

We're NOT looking for:
- Generic comments or reactions
- Questions to the group
- Casual chit-chat
- Technical troubleshooting

We ARE looking for:
- "I'm really interested in X"
- "We're building Y at my company"
- "Our focus is on Z"
- "I think the future is..."
- Strong opinions or perspectives on industry topics

If the message IS notable, summarize what it reveals about the person in ONE sentence.
If it's NOT notable, respond with null.

Return ONLY valid JSON:
{"note": "Mentioned being interested in X" | null}`;
}

/**
 * Extract a note from a message using Claude
 */
async function extractNote(item: QueueItem): Promise<string | null> {
  if (!isLLMConfigured()) {
    logger.warn('Passive note extractor: No API key configured');
    return null;
  }

  try {
    const prompt = buildNoteExtractionPrompt(item.messageText, item.channelName);

    const result = await complete({
      prompt,
      model: 'fast',
      maxTokens: 150,
      operationName: 'passive-note-extraction',
    });

    // Parse JSON response
    const cleaned = result.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);

    return parsed.note || null;
  } catch (error) {
    logger.warn({ error, slackUserId: item.slackUserId }, 'Passive note extraction failed');
    return null;
  }
}

/**
 * Store a note as an insight
 */
async function storeNote(
  slackUserId: string,
  workosUserId: string | undefined,
  note: string,
  channelName: string | undefined,
  messageTs: string
): Promise<void> {
  // Get the 'note' insight type ID
  const noteType = await insightsDb.getInsightTypeByName('note');
  if (!noteType) {
    logger.error('Note insight type not found - run migration 143_note_insight_type.sql');
    return;
  }

  // Format the note with channel context
  const formattedNote = channelName
    ? `${note} (in #${channelName})`
    : note;

  // Check for duplicate (same user, same basic note value)
  const existingInsights = await insightsDb.getInsightsForUser(slackUserId);
  const isDuplicate = existingInsights.some(
    i => i.insight_type_name === 'note' && i.value.toLowerCase().includes(note.toLowerCase().slice(0, 30))
  );

  if (isDuplicate) {
    logger.debug({ slackUserId, note }, 'Skipping duplicate note');
    return;
  }

  // Store the note
  await insightsDb.addInsight({
    slack_user_id: slackUserId,
    workos_user_id: workosUserId,
    insight_type_id: noteType.id,
    value: formattedNote,
    confidence: 'medium' as InsightConfidence, // Passive observation = medium confidence
    source_type: 'observation',
    source_thread_id: undefined,
    source_message_id: messageTs,
    extracted_from: undefined, // Don't store the full message for privacy
  });

  // Invalidate cache for this user
  invalidateInsightsCache(slackUserId);

  logger.info({ slackUserId, note: formattedNote }, 'Stored note from channel conversation');
}

/**
 * Process the next item in the queue
 */
async function processNext(): Promise<void> {
  if (processing || queue.length === 0) return;

  processing = true;
  const item = queue.shift()!;

  try {
    const note = await extractNote(item);
    if (note) {
      await storeNote(
        item.slackUserId,
        item.workosUserId,
        note,
        item.channelName,
        item.messageTs
      );
    }
  } catch (error) {
    logger.warn({ error, item }, 'Error processing passive note extraction');
  }

  // Schedule next item after rate limit delay
  setTimeout(() => {
    processing = false;
    processNext();
  }, RATE_LIMIT_MS);
}

/**
 * Queue a message for passive note extraction
 *
 * Call this from the message handler for public channel messages.
 * The message will be processed asynchronously with rate limiting.
 */
export function queueForNoteExtraction(params: {
  slackUserId: string;
  workosUserId?: string;
  channelId: string;
  channelName?: string;
  messageText: string;
  messageTs: string;
}): void {
  // Pre-filter before queueing
  if (!shouldAnalyzeForNotes(params.messageText)) {
    return;
  }

  // Deduplicate: don't queue if same user+message already in queue
  const isDuplicate = queue.some(
    q => q.slackUserId === params.slackUserId && q.messageTs === params.messageTs
  );
  if (isDuplicate) return;

  queue.push({
    slackUserId: params.slackUserId,
    workosUserId: params.workosUserId,
    channelId: params.channelId,
    channelName: params.channelName,
    messageText: params.messageText,
    messageTs: params.messageTs,
  });

  logger.debug({
    slackUserId: params.slackUserId,
    channelName: params.channelName,
    queueLength: queue.length,
  }, 'Queued message for passive note extraction');

  // Start processing if not already running
  processNext();
}

/**
 * Get current queue length (for monitoring)
 */
export function getQueueLength(): number {
  return queue.length;
}
