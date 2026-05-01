/**
 * Working-group content service.
 *
 * Shared by:
 *  - POST /api/working-groups/:slug/posts                      (web/API)
 *  - POST /api/working-groups/:slug/documents                  (web/API)
 *  - PUT  /api/working-groups/:slug/documents/:documentId      (web/API)
 *  - DELETE /api/working-groups/:slug/documents/:documentId    (web/API)
 *  - create_working_group_post Addie tool                      (chat)
 *  - add_committee_document Addie tool                         (chat)
 *  - update_committee_document Addie tool                      (chat)
 *  - delete_committee_document Addie tool                      (chat)
 *
 * Centralizes membership/leader auth checks, URL allowlist validation,
 * post + document side effects (Slack channel notification, doc index
 * refresh) so the route and the Addie tool produce identical outcomes.
 * Replaces a server-to-self HTTP loopback in callApi that was silently
 * rejected by CSRF middleware (issue #3736).
 */

import { getPool } from '../db/client.js';
import { createLogger } from '../logger.js';
import { WorkingGroupDatabase } from '../db/working-group-db.js';
import type { CommitteeDocument, CommitteeDocumentType } from '../types.js';
import { notifyPublishedPost } from '../notifications/slack.js';
import { sendChannelMessage, isSlackConfigured } from '../slack/client.js';
import { reindexDocument } from '../addie/jobs/committee-document-indexer.js';
import { refreshWorkingGroupDocs } from '../addie/mcp/docs-indexer.js';
import { isUuid } from '../utils/uuid.js';
import type { WorkingGroupServiceUser } from './working-group-membership-service.js';

const logger = createLogger('working-group-content-service');

const workingGroupDb = new WorkingGroupDatabase();

// ─── URL allowlist for committee documents ────────────────────────────
// Whitelist approach to prevent SSRF when crawling user-supplied
// document URLs. Mirrors the previous in-route helper in committees.ts;
// kept here so both the route and the Addie tool consume the same rules.

const ALLOWED_DOCUMENT_DOMAINS = ['docs.google.com', 'drive.google.com', 'sheets.google.com'];
const ALLOWED_FILE_HOSTING_DOMAINS = [
  'drive.google.com',
  'docs.google.com',
  'storage.googleapis.com',
  'dropbox.com',
  'www.dropbox.com',
  'dl.dropboxusercontent.com',
  'onedrive.live.com',
  '1drv.ms',
  'agenticadvertising.org',
  'www.agenticadvertising.org',
];
const ALLOWED_FILE_EXTENSIONS = ['.pdf', '.pptx', '.xlsx', '.docx'];

export function isAllowedDocumentUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (ALLOWED_DOCUMENT_DOMAINS.includes(parsed.hostname)) return true;
    const pathname = parsed.pathname.toLowerCase();
    if (
      ALLOWED_FILE_HOSTING_DOMAINS.includes(parsed.hostname) &&
      ALLOWED_FILE_EXTENSIONS.some((ext) => pathname.endsWith(ext))
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ─── Discriminated error variants ─────────────────────────────────────
// One union covers post + document failures so callers can pattern-match
// on `.code` instead of guessing from HTTP status (which is what bit us
// in the loopback bug).

export type WorkingGroupContentErrorCode =
  | 'group_not_found'
  | 'not_member'
  | 'not_leader'
  | 'leader_required_for_public_post'
  | 'missing_required_fields'
  | 'invalid_post_slug'
  | 'invalid_document_url'
  | 'invalid_document_id'
  | 'document_not_found'
  | 'duplicate_post_slug';

export interface WorkingGroupContentErrorMetaByCode {
  group_not_found: { slug: string };
  not_member: { slug: string };
  not_leader: { slug: string };
  leader_required_for_public_post: { slug: string };
  missing_required_fields: { slug: string; fields: string[] };
  invalid_post_slug: { slug: string; postSlug: string };
  invalid_document_url: { slug: string };
  invalid_document_id: { slug: string; documentId: string };
  document_not_found: { slug: string; documentId: string };
  duplicate_post_slug: { slug: string; postSlug: string };
}

export class WorkingGroupContentError<
  C extends WorkingGroupContentErrorCode = WorkingGroupContentErrorCode,
> extends Error {
  constructor(
    public readonly code: C,
    message: string,
    public readonly meta: WorkingGroupContentErrorMetaByCode[C],
  ) {
    super(message);
    this.name = 'WorkingGroupContentError';
  }

  is<K extends WorkingGroupContentErrorCode>(
    code: K,
  ): this is WorkingGroupContentError<K> & { meta: WorkingGroupContentErrorMetaByCode[K] } {
    return (this.code as string) === (code as string);
  }
}

function userDisplayName(user: WorkingGroupServiceUser): string {
  if (user.firstName && user.lastName) return `${user.firstName} ${user.lastName}`;
  return user.email;
}

// ─── Post creation ────────────────────────────────────────────────────

export type WorkingGroupPostContentType = 'article' | 'link';
const VALID_POST_CONTENT_TYPES: readonly WorkingGroupPostContentType[] = ['article', 'link'];

export interface CreateWorkingGroupPostInput {
  user: WorkingGroupServiceUser;
  slug: string;
  title: string;
  postSlug: string;
  content?: string | null;
  /** Caller-provided content type. Anything outside the allowlist is coerced to 'article'. */
  contentType?: string;
  category?: string | null;
  excerpt?: string | null;
  externalUrl?: string | null;
  externalSiteName?: string | null;
  /** Defaults to true. Non-leaders cannot set this to false. */
  isMembersOnly?: boolean;
}

export interface CreateWorkingGroupPostResult {
  // Returns the perspectives row as-is — the route already shapes the
  // response, and the Addie tool only needs title + slug for its message.
  post: Record<string, unknown>;
  groupName: string;
  groupSlug: string;
}

export async function createWorkingGroupPost(input: CreateWorkingGroupPostInput): Promise<CreateWorkingGroupPostResult> {
  const { user, slug, title, postSlug, content, contentType, category, excerpt, externalUrl, externalSiteName, isMembersOnly } = input;

  const group = await workingGroupDb.getWorkingGroupBySlug(slug);
  if (!group || group.status !== 'active') {
    throw new WorkingGroupContentError('group_not_found', `No working group found with slug: ${slug}`, { slug });
  }

  const isMember = await workingGroupDb.isMember(group.id, user.id);
  if (!isMember) {
    throw new WorkingGroupContentError('not_member', 'You must be a member of this working group to post', { slug });
  }

  const isLeader = group.leaders?.some((l) => l.canonical_user_id === user.id) ?? false;

  // Non-leaders cannot opt out of members-only. Reject any explicit
  // non-true value so the abuse signal surfaces in logs rather than
  // being silently coerced. Omitting the field is fine — defaults to
  // members-only.
  if (!isLeader && isMembersOnly !== undefined && isMembersOnly !== true) {
    throw new WorkingGroupContentError(
      'leader_required_for_public_post',
      'Only committee leaders can create public (non-members-only) posts',
      { slug },
    );
  }
  const finalMembersOnly = isLeader ? (isMembersOnly === undefined ? true : Boolean(isMembersOnly)) : true;

  const missing: string[] = [];
  if (!title) missing.push('title');
  if (!postSlug) missing.push('post_slug');
  if (missing.length > 0) {
    throw new WorkingGroupContentError('missing_required_fields', 'Title and slug are required', { slug, fields: missing });
  }

  const slugPattern = /^[a-z0-9-]+$/;
  if (!slugPattern.test(postSlug)) {
    throw new WorkingGroupContentError(
      'invalid_post_slug',
      'Slug must contain only lowercase letters, numbers, and hyphens',
      { slug, postSlug },
    );
  }

  const authorName = userDisplayName(user);
  const pool = getPool();
  const normalizedContentType: WorkingGroupPostContentType = VALID_POST_CONTENT_TYPES.includes(contentType as WorkingGroupPostContentType)
    ? (contentType as WorkingGroupPostContentType)
    : 'article';

  let inserted;
  try {
    const result = await pool.query(
      `INSERT INTO perspectives (
        working_group_id, slug, content_type, title, content, category, excerpt,
        external_url, external_site_name, author_name, author_user_id,
        status, published_at, is_members_only
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'published', NOW(), $12)
      RETURNING *`,
      [
        group.id,
        postSlug,
        normalizedContentType,
        title,
        content || null,
        category || null,
        excerpt || null,
        externalUrl || null,
        externalSiteName || null,
        authorName,
        user.id,
        finalMembersOnly,
      ],
    );
    inserted = result.rows[0];
  } catch (err) {
    if (err instanceof Error && err.message.includes('duplicate key')) {
      throw new WorkingGroupContentError(
        'duplicate_post_slug',
        'A post with this slug already exists in this working group',
        { slug, postSlug },
      );
    }
    throw err;
  }

  // Slack channel notification — fire-and-forget, doesn't gate the response.
  notifyPublishedPost({
    slackChannelId: group.slack_channel_id ?? undefined,
    workingGroupName: group.name,
    workingGroupSlug: slug,
    postTitle: title,
    postSlug,
    authorName,
    contentType: normalizedContentType,
    excerpt: excerpt || undefined,
    externalUrl: externalUrl || undefined,
    category: category || undefined,
    isMembersOnly: finalMembersOnly,
  }).catch((err) => {
    logger.warn({ err }, 'Failed to send Slack channel notification for working group post');
  });

  return { post: inserted, groupName: group.name, groupSlug: group.slug };
}

// ─── Document add ─────────────────────────────────────────────────────

export interface AddCommitteeDocumentInput {
  user: WorkingGroupServiceUser;
  slug: string;
  title: string;
  documentUrl: string;
  description?: string;
  documentType?: CommitteeDocumentType;
  displayOrder?: number;
  isFeatured?: boolean;
}

export interface AddCommitteeDocumentResult {
  document: Omit<CommitteeDocument, 'file_data' | 'last_content'>;
  groupName: string;
  groupSlug: string;
}

export async function addCommitteeDocument(input: AddCommitteeDocumentInput): Promise<AddCommitteeDocumentResult> {
  const { user, slug, title, documentUrl, description, documentType, displayOrder, isFeatured } = input;

  const group = await workingGroupDb.getWorkingGroupBySlug(slug);
  if (!group) {
    throw new WorkingGroupContentError('group_not_found', `No committee found with slug: ${slug}`, { slug });
  }

  const isMember = await workingGroupDb.isMember(group.id, user.id);
  if (!isMember) {
    throw new WorkingGroupContentError('not_member', 'Only members can add documents to this committee', { slug });
  }

  const missing: string[] = [];
  if (!title) missing.push('title');
  if (!documentUrl) missing.push('document_url');
  if (missing.length > 0) {
    throw new WorkingGroupContentError('missing_required_fields', 'Title and document_url are required', {
      slug,
      fields: missing,
    });
  }

  if (!isAllowedDocumentUrl(documentUrl)) {
    throw new WorkingGroupContentError(
      'invalid_document_url',
      'Only Google Docs, Sheets, Drive URLs, and direct links to PDFs/PPTX/XLSX/DOCX from trusted hosts are supported',
      { slug },
    );
  }

  const document = await workingGroupDb.createDocument({
    working_group_id: group.id,
    title,
    description,
    document_url: documentUrl,
    document_type: documentType,
    display_order: displayOrder ?? 0,
    is_featured: isFeatured ?? false,
    added_by_user_id: user.id,
  });

  logger.info({ documentId: document.id, groupSlug: slug, userId: user.id }, 'Committee document created');

  // Slack notification (fire-and-forget) and indexing trigger.
  if (group.slack_channel_id && isSlackConfigured()) {
    const docTypeLabel =
      documentType === 'google_sheet' || documentType === 'xlsx'
        ? 'Spreadsheet'
        : documentType === 'pptx'
          ? 'Presentation'
          : 'Document';
    const userName = userDisplayName(user) || 'A working group leader';
    const appUrl = process.env.APP_URL || 'https://agenticadvertising.org';
    const groupUrl = `${appUrl}/working-groups/${slug}`;
    const safeTitle = title.replace(/[|<>]/g, '-');
    sendChannelMessage(group.slack_channel_id, {
      text: `📄 New ${docTypeLabel} added to ${group.name}: ${title}`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text' as const, text: `📄 New ${docTypeLabel} Added`, emoji: true },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn' as const,
            text: `*<${documentUrl}|${safeTitle}>*${description ? `\n${description}` : ''}`,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn' as const,
            text: `Added by ${userName} · <${groupUrl}|View all ${group.name} resources>`,
          },
        },
      ],
    }).catch((err) => {
      logger.warn({ err, groupSlug: slug, documentId: document.id }, 'Failed to send Slack notification for new committee document');
    });
  }

  // Index immediately so Addie can reference the document right away.
  reindexDocument(document.id)
    .then(() => refreshWorkingGroupDocs())
    .catch((err) => logger.warn({ err, documentId: document.id }, 'Background indexing after document creation failed'));

  const { file_data: _fd, last_content: _lc, ...documentMeta } = document;
  return { document: documentMeta, groupName: group.name, groupSlug: group.slug };
}

// ─── Document update ──────────────────────────────────────────────────

export interface UpdateCommitteeDocumentInput {
  user: WorkingGroupServiceUser;
  slug: string;
  documentId: string;
  title?: string;
  description?: string;
  documentUrl?: string;
  documentType?: CommitteeDocumentType;
  displayOrder?: number;
  isFeatured?: boolean;
}

export interface UpdateCommitteeDocumentResult {
  document: Omit<CommitteeDocument, 'file_data' | 'last_content'>;
  groupName: string;
  groupSlug: string;
}

export async function updateCommitteeDocument(
  input: UpdateCommitteeDocumentInput,
): Promise<UpdateCommitteeDocumentResult> {
  const { user, slug, documentId, title, description, documentUrl, documentType, displayOrder, isFeatured } = input;

  if (!isUuid(documentId)) {
    throw new WorkingGroupContentError('invalid_document_id', 'Document ID must be a valid UUID', {
      slug,
      documentId,
    });
  }

  const group = await workingGroupDb.getWorkingGroupBySlug(slug);
  if (!group) {
    throw new WorkingGroupContentError('group_not_found', `No committee found with slug: ${slug}`, { slug });
  }

  const isMember = await workingGroupDb.isMember(group.id, user.id);
  if (!isMember) {
    throw new WorkingGroupContentError('not_member', 'Only members can update documents in this committee', { slug });
  }

  const existingDoc = await workingGroupDb.getDocumentById(documentId);
  if (!existingDoc || existingDoc.working_group_id !== group.id) {
    throw new WorkingGroupContentError('document_not_found', 'Document not found in this committee', {
      slug,
      documentId,
    });
  }

  if (documentUrl !== undefined && !isAllowedDocumentUrl(documentUrl)) {
    throw new WorkingGroupContentError(
      'invalid_document_url',
      'Only Google Docs, Sheets, Drive URLs, and direct links to PDFs/PPTX/XLSX/DOCX from trusted hosts are supported',
      { slug },
    );
  }

  const document = await workingGroupDb.updateDocument(documentId, {
    title,
    description,
    document_url: documentUrl,
    document_type: documentType,
    display_order: displayOrder,
    is_featured: isFeatured,
  });

  if (!document) {
    throw new WorkingGroupContentError('document_not_found', 'Document not found', { slug, documentId });
  }

  // Refresh in-memory search index so Addie sees updated metadata.
  refreshWorkingGroupDocs().catch((err) =>
    logger.warn({ err, documentId }, 'Background refresh after document update failed'),
  );

  const { file_data: _fd, last_content: _lc, ...documentMeta } = document;
  return { document: documentMeta, groupName: group.name, groupSlug: group.slug };
}

// ─── Document delete ──────────────────────────────────────────────────

export interface DeleteCommitteeDocumentInput {
  user: WorkingGroupServiceUser;
  slug: string;
  documentId: string;
}

export interface DeleteCommitteeDocumentResult {
  groupName: string;
  groupSlug: string;
}

/**
 * Delete requires committee leader privileges. Member-only callers get
 * `not_leader` so adapters can route them to a leader or an editorial
 * flow rather than guessing why deletion failed.
 */
export async function deleteCommitteeDocument(
  input: DeleteCommitteeDocumentInput,
): Promise<DeleteCommitteeDocumentResult> {
  const { user, slug, documentId } = input;

  if (!isUuid(documentId)) {
    throw new WorkingGroupContentError('invalid_document_id', 'Document ID must be a valid UUID', {
      slug,
      documentId,
    });
  }

  const group = await workingGroupDb.getWorkingGroupBySlug(slug);
  if (!group) {
    throw new WorkingGroupContentError('group_not_found', `No committee found with slug: ${slug}`, { slug });
  }

  const isLeader = await workingGroupDb.isLeader(group.id, user.id);
  if (!isLeader) {
    throw new WorkingGroupContentError('not_leader', 'Only committee leaders can delete documents', { slug });
  }

  const existingDoc = await workingGroupDb.getDocumentById(documentId);
  if (!existingDoc || existingDoc.working_group_id !== group.id) {
    throw new WorkingGroupContentError('document_not_found', 'Document not found in this committee', {
      slug,
      documentId,
    });
  }

  await workingGroupDb.deleteDocument(documentId);
  logger.info({ documentId, groupSlug: slug }, 'Committee document deleted');

  // Remove from in-memory search index.
  refreshWorkingGroupDocs().catch((err) =>
    logger.warn({ err, documentId }, 'Background refresh after document delete failed'),
  );

  return { groupName: group.name, groupSlug: group.slug };
}
