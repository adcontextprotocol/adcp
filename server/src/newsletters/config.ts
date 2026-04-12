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

// ─── Section Descriptors ──────────────────────────────────────────────

export interface SectionDescriptor {
  /** Property key on the content object (e.g. 'decisions', 'whatToWatch') */
  key: string;
  /** Display label in admin UI */
  label: string;
  /** Subtitle hint */
  hint?: string;
  /** Render admin-preview HTML from opaque content (server-side) */
  renderHtml: (content: unknown) => string;
  /** Item count for badge display */
  countFn?: (content: unknown) => number;
  /** Whether this section supports item-level edit/delete/reorder */
  supportsItemEdit?: boolean;
  /** Grid layout hint */
  layout?: 'full' | 'half';
}

export interface CustomSection {
  id: string;
  title: string;
  /** Markdown body */
  body: string;
  /** Insertion index among the newsletter's sections */
  position: number;
}

export interface ItemOperations {
  editItem: (content: unknown, index: number, body: Record<string, unknown>, editor: string) => unknown;
  deleteItem: (content: unknown, index: number, editor: string) => unknown;
  reorderItems: (content: unknown, indices: number[], editor: string) => unknown;
}

/** Check if a section key is hidden in the content */
export function isSectionHidden(content: unknown, key: string): boolean {
  const c = content as { hiddenSections?: string[] };
  return (c.hiddenSections || []).includes(key);
}

/** Get custom sections from content */
export function getCustomSections(content: unknown): CustomSection[] {
  const c = content as { customSections?: CustomSection[] };
  return c.customSections || [];
}

/** Get pasted content override, if any */
export function getPastedContent(content: unknown): string | undefined {
  const c = content as { pastedContent?: string };
  return c.pastedContent;
}

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

  // ─── Cover Image (optional) ──────────────────────────────────────────
  /** Store a cover image for a draft edition. Returns false if not a draft. */
  setCoverImage?(id: number, imageData: Buffer, promptUsed: string): Promise<boolean>;
  /** Get the cover image binary by edition date. */
  getCoverImage?(editionDate: string): Promise<Buffer | null>;
  /** Get cover image + prompt (for reuse when publishing as perspective). */
  getCoverImageWithPrompt?(editionDate: string): Promise<{ imageData: Buffer; promptUsed: string } | null>;
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
  /** URL prefix for public cover images, e.g. '/digest' → /digest/:date/cover.png */
  coverRoutePrefix?: string;

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
    recipient?: NewsletterRecipient | null,
  ) => { html: string; text: string };

  /** Render Slack announcement message */
  renderSlack: (content: unknown, editionDate: string) => SlackBlockMessage;
  /** Render Slack review message for editorial approval */
  renderReview: (content: unknown, editionDate: string) => SlackBlockMessage;

  /** Database adapter */
  db: NewsletterEditionDB;

  /** Fields editable via direct admin API (not LLM instruction) */
  editableFields: string[];

  /** Section descriptors for the admin UI */
  sections?: SectionDescriptor[];

  /** Optional: apply a free-form editing instruction via LLM */
  applyInstruction?: (content: unknown, instruction: string, editorName: string) => Promise<{ content: unknown; summary: string }>;

  /** Optional: item-level operations for array sections (keyed by section key) */
  itemOperations?: Record<string, ItemOperations>;

  /** Favicon/icon path for the admin page */
  adminIcon?: string;
}
