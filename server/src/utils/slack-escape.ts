/**
 * Escape user-controlled text before interpolating it into a Slack mrkdwn
 * block. Slack mrkdwn can't execute code, but it interprets `<!here>`,
 * `<!channel>`, and `<@USERID>` as pings — so a malicious submitter
 * embedding those strings in a title, excerpt, or member name could ping
 * the reviewer channel at submission time.
 *
 * Escapes `<`, `>`, and `&` (the three characters Slack uses to delimit
 * formatting commands), then truncates with an ellipsis if over `maxLength`.
 */
export function escapeSlackText(raw: string, maxLength = 240): string {
  const escaped = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped.length > maxLength ? `${escaped.slice(0, maxLength)}…` : escaped;
}
