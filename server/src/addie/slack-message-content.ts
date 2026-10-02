import type { SlackFile } from '../slack/types.js';

export interface SlackAttachment {
  author_name?: string;
  pretext?: string;
  text?: string;
  footer?: string;
  fallback?: string;
  title?: string;
  title_link?: string;
}

export interface SlackMessageContent {
  text?: string;
  attachments?: SlackAttachment[];
  files?: SlackFile[];
}

export function extractForwardedContent(attachments?: SlackAttachment[]): string {
  const descriptions = (attachments ?? []).map(attachment => [
    attachment.author_name ? `From: ${attachment.author_name}` : '',
    attachment.pretext,
    attachment.text,
    attachment.footer ? `(${attachment.footer})` : '',
  ].filter(Boolean).join('\n')).filter(Boolean);
  return descriptions.length ? `\n\n[Forwarded message]\n${descriptions.join('\n---\n')}` : '';
}

export function extractFileInfo(files?: SlackFile[]): string {
  const descriptions = (files ?? []).map(file => {
    const parts = [`File: ${file.name || file.title || 'Unnamed file'}`, `File ID: ${file.id}`];
    if (file.filetype) parts.push(`Type: ${file.filetype.toUpperCase()}`);
    if (file.size) parts.push(`Size: ${Math.round(file.size / 1024)}KB`);
    // The permalink is a Slack UI page; read_slack_file needs the download URL.
    const url = file.url_private_download || file.url_private || file.permalink;
    if (url) parts.push(`Link: ${url}`);
    return parts.join(' | ');
  });
  return descriptions.length ? `\n\n[Shared files]\n${descriptions.join('\n')}` : '';
}

/** Used for both incoming events and history, including file-only messages. */
export function extractSlackMessageContent(message: SlackMessageContent): string {
  return (message.text || '') + extractForwardedContent(message.attachments) + extractFileInfo(message.files);
}

export function isSupportedSlackMessageSubtype(subtype?: string): boolean {
  return !subtype || subtype === 'file_share';
}
