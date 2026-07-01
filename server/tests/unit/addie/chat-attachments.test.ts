import { describe, expect, it } from 'vitest';
import {
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_MAX_COUNT,
  CHAT_ATTACHMENT_MAX_TOTAL_BYTES,
  ChatAttachmentValidationError,
  validateChatAttachments,
  summarizeAttachmentsForMessage,
} from '../../../src/addie/chat-attachments.js';

const tinyPng = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]).toString('base64');
const tinyPdf = Buffer.from('%PDF-1.7').toString('base64');

function pngDataUrl(data = tinyPng): string {
  return `data:image/png;base64,${data}`;
}

function oversizedPng(bytes: number): string {
  const buffer = Buffer.alloc(bytes);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  return buffer.toString('base64');
}

describe('chat attachment validation', () => {
  it('accepts supported image attachments', () => {
    const result = validateChatAttachments([
      {
        type: 'image',
        media_type: 'image/png',
        filename: '../screenshot.png',
        data: tinyPng,
      },
    ]);

    expect(result).toEqual([
      {
        type: 'image',
        media_type: 'image/png',
        filename: 'screenshot.png',
        data: tinyPng,
        size_bytes: 8,
      },
    ]);
  });

  it('normalizes data URL attachment payloads', () => {
    const result = validateChatAttachments([
      {
        type: 'image',
        media_type: 'image/png',
        filename: 'screenshot.png',
        data: pngDataUrl(),
      },
    ]);

    expect(result[0]?.data).toBe(tinyPng);
  });

  it('accepts PDFs as document attachments', () => {
    const result = validateChatAttachments([
      {
        type: 'document',
        media_type: 'application/pdf',
        filename: 'deck.pdf',
        data: tinyPdf,
      },
    ]);

    expect(result[0]).toMatchObject({
      type: 'document',
      media_type: 'application/pdf',
      filename: 'deck.pdf',
    });
  });

  it('rejects unsupported media types', () => {
    expect(() => validateChatAttachments([
      {
        type: 'image',
        media_type: 'image/svg+xml',
        filename: 'bad.svg',
        data: tinyPng,
      },
    ])).toThrow(ChatAttachmentValidationError);
  });

  it('rejects non-array attachment payloads', () => {
    expect(() => validateChatAttachments({})).toThrow('Attachments must be an array');
  });

  it('rejects too many attachments', () => {
    expect(() => validateChatAttachments(Array.from({ length: CHAT_ATTACHMENT_MAX_COUNT + 1 }, (_, index) => ({
      type: 'image',
      media_type: 'image/png',
      filename: `image-${index}.png`,
      data: tinyPng,
    })))).toThrow(`Attach up to ${CHAT_ATTACHMENT_MAX_COUNT} files per message`);
  });

  it('rejects attachments over the per-file size limit', () => {
    try {
      validateChatAttachments([
        {
          type: 'image',
          media_type: 'image/png',
          filename: 'large.png',
          data: oversizedPng(CHAT_ATTACHMENT_MAX_BYTES + 1),
        },
      ]);
      throw new Error('Expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ChatAttachmentValidationError);
      expect((error as ChatAttachmentValidationError).statusCode).toBe(413);
      expect((error as Error).message).toBe('Attachment must be under 5MB');
    }
  });

  it('rejects attachments over the total size limit', () => {
    try {
      validateChatAttachments(Array.from({ length: CHAT_ATTACHMENT_MAX_COUNT }, (_, index) => ({
        type: 'image',
        media_type: 'image/png',
        filename: `large-${index}.png`,
        data: oversizedPng(Math.floor(CHAT_ATTACHMENT_MAX_TOTAL_BYTES / CHAT_ATTACHMENT_MAX_COUNT) + 1),
      })));
      throw new Error('Expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ChatAttachmentValidationError);
      expect((error as ChatAttachmentValidationError).statusCode).toBe(413);
      expect((error as Error).message).toBe('Attachments must total under 6MB');
    }
  });

  it('rejects invalid base64 payloads', () => {
    expect(() => validateChatAttachments([
      {
        type: 'image',
        media_type: 'image/png',
        filename: 'bad.png',
        data: 'not base64!',
      },
    ])).toThrow('Attachment data must be base64-encoded');
  });

  it('rejects document attachments without a PDF header', () => {
    expect(() => validateChatAttachments([
      {
        type: 'document',
        media_type: 'application/pdf',
        filename: 'not-a-pdf.pdf',
        data: tinyPng,
      },
    ])).toThrow('Attachment content does not match its media type');
  });

  it('rejects image attachments whose bytes do not match the declared type', () => {
    expect(() => validateChatAttachments([
      {
        type: 'image',
        media_type: 'image/png',
        filename: 'not-a-png.png',
        data: Buffer.from('not a png').toString('base64'),
      },
    ])).toThrow('Attachment content does not match its media type');
  });

  it('summarizes attachment counts for persisted message text', () => {
    const attachments = validateChatAttachments([
      { type: 'image', media_type: 'image/png', filename: 'screen.png', data: tinyPng },
      { type: 'document', media_type: 'application/pdf', filename: 'brief.pdf', data: tinyPdf },
    ]);

    expect(summarizeAttachmentsForMessage(attachments)).toBe('[Attached 2 files]');
  });
});
