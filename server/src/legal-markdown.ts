import DOMPurify from 'isomorphic-dompurify';
import { Marked } from 'marked';

const legalMarkdown = new Marked();

const LEGAL_MARKDOWN_SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'strong', 'em', 'a', 'ul', 'ol', 'li',
    'h1', 'h2', 'h3', 'h4', 'blockquote', 'pre', 'code',
    'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  ],
  ALLOWED_ATTR: ['href', 'title'],
  ALLOW_DATA_ATTR: false,
  // Legal notices commonly use email contacts. Keep those and secure/internal
  // links, while rejecting plain HTTP, protocol-relative, and active schemes.
  ALLOWED_URI_REGEXP: /^(?:https:|mailto:|\/(?!\/)|#)/i,
};

/** Render administrator-authored legal Markdown for insertion into a public page. */
export function renderLegalMarkdown(markdown: string): string {
  const rendered = legalMarkdown.parse(markdown, { async: false }) as string;
  return DOMPurify.sanitize(rendered, LEGAL_MARKDOWN_SANITIZE_CONFIG);
}
