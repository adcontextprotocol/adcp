/**
 * Newsletter Configuration
 *
 * Shared interface that parameterizes all newsletter infrastructure:
 * admin CRUD, email layout, preview, send pipeline, perspective publishing,
 * illustration generation, and feedback collection.
 *
 * Content shape and assembly are newsletter-specific — the shared infra
 * treats content as opaque JSONB and delegates rendering to the config.
 */

import type { SlackBlockMessage } from '../slack/types.js';

// ─── Palette ───────────────────────────────────────────────────────────

export interface NewsletterPalette {
  /** Primary accent color: links, headers, borders */
  primary: string;
  /** Light background for callout boxes */
  light: string;
  /** Dark text color */
  dark: string;
}

// ─── Cadence ───────────────────────────────────────────────────────────

export interface NewsletterCadence {
  /** Hour (ET) to generate draft */
  generateHourET: number;
  /** Hour (ET) to send approved editions */
  sendHourET: number;
  /** Returns true if the given date (or today) is a send day for this newsletter */
  shouldRunToday: (dateOverride?: Date) => boolean;
}

// ─── Recipient ─────────────────────────────────────────────────────────

export interface NewsletterRecipient {
  workos_user_id: string;
  email: string;
  first_name: string | null;
  has_slack: boolean;
  persona: string | null;
  journey_stage: string | null;
}

// ─── Edition Record ────────────────────────────────────────────────────

export interface EditionRecord {
  id: number;
  edition_date: Date;
  status: 'draft' | 'approved' | 'sent' | 'skipped';
  content: unknown;
  approved_by: string | null;
  approved_at: Date | null;
  review_channel_id: string | null;
  review_message_ts: string | null;
  perspective_id: string | null;
  created_at: Date;
  sent_at: Date | null;
  send_stats: unknown | null;
}

export interface SendStats {
  email_count: number;
  slack_count: number;
  by_segment?: Record<string, number>;
}

// ─── Edition DB Interface ──────────────────────────────────────────────

export interface NewsletterEditionDB {
  createEdition(editionDate: string, content: unknown): Promise<EditionRecord | null>;
  getByDate(editionDate: string): Promise<EditionRecord | null>;
  getCurrent(lookbackDays?: number): Promise<EditionRecord | null>;
  approve(id: number, approvedBy: string): Promise<EditionRecord | null>;
  updateContent(id: number, content: unknown): Promise<EditionRecord | null>;
  markSent(id: number, stats: SendStats): Promise<boolean>;
  setReviewMessage(id: number, channelId: string, messageTs: string): Promise<void>;
  getByReviewMessage(channelId: string, messageTs: string): Promise<EditionRecord | null>;
  setPerspectiveId(id: number, perspectiveId: string): Promise<void>;
  getRecent(limit: number): Promise<EditionRecord[]>;
  getRecipients(): Promise<NewsletterRecipient[]>;
  getUserWorkingGroupMap(): Promise<Map<string, string[]>>;
}

// ─── Newsletter Config ─────────────────────────────────────────────────

export interface NewsletterConfig {
  /** Machine identifier: 'the_prompt', 'the_build' */
  id: string;
  /** Display name: "The Prompt", "The Build" */
  name: string;
  /** Author agent name: "Addie", "Sage" */
  author: string;
  /** Author title for perspective byline */
  authorTitle: string;
  /** System user ID for creating perspectives */
  authorSystemId: string;
  /** Email category for opt-out */
  emailCategory: string;
  /** From address for emails (e.g. 'Addie from AgenticAdvertising.org <addie@updates.agenticadvertising.org>') */
  fromEmail?: string;
  /** Color palette for email and illustrations */
  palette: NewsletterPalette;
  /** Cadence configuration */
  cadence: NewsletterCadence;
  /** Slug prefix for perspectives: "the-prompt" -> /perspectives/the-prompt-2026-04-01 */
  perspectiveSlugPrefix: string;
  /** Perspective category label */
  perspectiveCategory: string;
  /** Illustration style prompt for cover images */
  illustrationStylePrompt: string;
  /** Cast members for cover illustrations */
  illustrationCast: string[];
  /** Sign-off block for emails */
  signOff: { text: string; attribution: string; domain: string };
  /** Slack announcement channel env var */
  announcementChannelEnvVar: string;

  /** Build content for a new edition */
  buildContent: () => Promise<unknown>;
  /** Check if there's enough content to justify sending */
  hasMinimumContent: (content: unknown) => boolean;
  /** Generate subject line from content */
  generateSubject: (content: unknown) => string;
  /** Build full markdown for perspective body */
  buildMarkdown: (content: unknown) => string;
  /** Extract tags for perspective */
  extractTags: (content: unknown) => string[];

  /** Render email HTML + text for a recipient */
  renderEmail: (
    content: unknown,
    trackingId: string,
    editionDate: string,
    segment: string,
    firstName?: string,
    userWGs?: string[],
    personaCluster?: string,
  ) => { html: string; text: string };

  /** Render Slack announcement message */
  renderSlack: (content: unknown, editionDate: string) => SlackBlockMessage;
  /** Render Slack review message for editorial approval */
  renderReview: (content: unknown, editionDate: string) => SlackBlockMessage;

  /** Database adapter */
  db: NewsletterEditionDB;

  /** Fields editable via direct admin API (not LLM instruction) */
  editableFields: string[];
}
