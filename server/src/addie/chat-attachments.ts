import { isAllowedImageType, type AllowedImageType } from './mcp/url-tools.js';

export const CHAT_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const CHAT_ATTACHMENT_MAX_TOTAL_BYTES = 6 * 1024 * 1024;
export const CHAT_ATTACHMENT_MAX_COUNT = 4;

export type ChatAttachmentMediaType = AllowedImageType | 'application/pdf';

export interface AddieInputAttachment {
  type: 'image' | 'document';
  media_type: ChatAttachmentMediaType;
  data: string;
  filename?: string;
  size_bytes: number;
}

export class ChatAttachmentValidationError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'ChatAttachmentValidationError';
    this.statusCode = statusCode;
  }
}

function sanitizeFilename(filename: unknown): string | undefined {
  if (typeof filename !== 'string') return undefined;
  const cleaned = filename
    .split(/[\\/]/)
    .pop()
    ?.replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 120);
  return cleaned || undefined;
}

function normalizeBase64Data(rawData: string): { data: string; bytes: number; decoded: Buffer } {
  const withoutPrefix = rawData.startsWith('data:')
    ? rawData.slice(rawData.indexOf(',') + 1)
    : rawData;
  const data = withoutPrefix.replace(/\s/g, '');

  if (!data) {
    throw new ChatAttachmentValidationError('Attachment data is required');
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new ChatAttachmentValidationError('Attachment data must be base64-encoded');
  }

  const decoded = Buffer.from(data, 'base64');
  const canonicalDecoded = decoded.toString('base64').replace(/=+$/, '');
  const canonicalInput = data.replace(/=+$/, '');
  if (canonicalDecoded !== canonicalInput) {
    throw new ChatAttachmentValidationError('Attachment data must be valid base64');
  }

  return { data, bytes: decoded.byteLength, decoded };
}

function validateAttachmentType(type: unknown, mediaType: unknown): Pick<AddieInputAttachment, 'type' | 'media_type'> {
  if (typeof mediaType !== 'string') {
    throw new ChatAttachmentValidationError('Attachment media type is required');
  }

  if (type === 'image') {
    if (!isAllowedImageType(mediaType)) {
      throw new ChatAttachmentValidationError('Unsupported image type. Use PNG, JPEG, GIF, or WebP.');
    }
    return { type: 'image', media_type: mediaType };
  }

  if (type === 'document') {
    if (mediaType !== 'application/pdf') {
      throw new ChatAttachmentValidationError('Unsupported document type. Use PDF.');
    }
    return { type: 'document', media_type: mediaType };
  }

  throw new ChatAttachmentValidationError('Unsupported attachment type');
}

function assertAttachmentSignature(decoded: Buffer, mediaType: ChatAttachmentMediaType): void {
  const matchesMediaType =
    (
      mediaType === 'application/pdf' &&
      decoded.subarray(0, 5).toString('ascii') === '%PDF-'
    ) ||
    (
      mediaType === 'image/png' &&
      decoded.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) ||
    (
      mediaType === 'image/jpeg' &&
      decoded[0] === 0xff &&
      decoded[1] === 0xd8
    ) ||
    (
      mediaType === 'image/gif' &&
      decoded.subarray(0, 4).toString('ascii') === 'GIF8'
    ) ||
    (
      mediaType === 'image/webp' &&
      decoded.subarray(0, 4).toString('ascii') === 'RIFF' &&
      decoded.subarray(8, 12).toString('ascii') === 'WEBP'
    );

  if (!matchesMediaType) {
    throw new ChatAttachmentValidationError('Attachment content does not match its media type');
  }
}

export function validateChatAttachments(rawAttachments: unknown): AddieInputAttachment[] {
  if (rawAttachments === undefined || rawAttachments === null) return [];
  if (!Array.isArray(rawAttachments)) {
    throw new ChatAttachmentValidationError('Attachments must be an array');
  }
  if (rawAttachments.length > CHAT_ATTACHMENT_MAX_COUNT) {
    throw new ChatAttachmentValidationError(`Attach up to ${CHAT_ATTACHMENT_MAX_COUNT} files per message`);
  }

  let totalBytes = 0;
  return rawAttachments.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ChatAttachmentValidationError('Invalid attachment');
    }

    const candidate = raw as Record<string, unknown>;
    const { type, media_type } = validateAttachmentType(candidate.type, candidate.media_type);

    if (typeof candidate.data !== 'string') {
      throw new ChatAttachmentValidationError('Attachment data is required');
    }
    const { data, bytes, decoded } = normalizeBase64Data(candidate.data);
    assertAttachmentSignature(decoded, media_type);
    if (bytes > CHAT_ATTACHMENT_MAX_BYTES) {
      throw new ChatAttachmentValidationError('Attachment must be under 5MB', 413);
    }

    totalBytes += bytes;
    if (totalBytes > CHAT_ATTACHMENT_MAX_TOTAL_BYTES) {
      throw new ChatAttachmentValidationError('Attachments must total under 6MB', 413);
    }

    return {
      type,
      media_type,
      data,
      filename: sanitizeFilename(candidate.filename),
      size_bytes: bytes,
    };
  });
}

export function summarizeAttachmentsForMessage(attachments: AddieInputAttachment[]): string {
  if (attachments.length === 0) return '';
  return `[Attached ${attachments.length} ${attachments.length === 1 ? 'file' : 'files'}]`;
}
