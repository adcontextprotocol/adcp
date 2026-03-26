import { Marked } from 'marked';

/**
 * Marked instance configured for email rendering.
 * Raw HTML tokens in the source markdown are escaped instead of passed through,
 * preventing injection when rendering untrusted or AI-generated content.
 */
const markedEmail = new Marked({
  renderer: {
    html(token) {
      return escapeHtml(token.text);
    },
  },
});

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/** Convert markdown to email-safe HTML. Raw HTML in the source is escaped. */
export function markdownToEmailHtml(markdown: string): string {
  return markedEmail.parse(markdown, { async: false }) as string;
}

/** Inline variant — no wrapping `<p>` tags. Use for short snippets embedded in a sentence. */
export function markdownToEmailHtmlInline(markdown: string): string {
  return markedEmail.parseInline(markdown, { async: false }) as string;
}
