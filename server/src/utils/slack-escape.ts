/**
 * Escape user-controlled text before interpolating it into a Slack mrkdwn
 * block. Slack mrkdwn can't execute code, but it interprets `<!here>`,
 * `<!channel>`, and `<@USERID>` as pings — so a malicious submitter
 * embedding those strings in a title, excerpt, or member name could ping
 * the reviewer channel at submission time.
 *
 * Truncates the raw input to `maxLength` *first*, then escapes `&`, `<`,
 * `>`. Truncating first ensures `maxLength` caps the meaningful content —
 * not the expanded escape output — so an attacker can't flood the Slack
 * block by stuffing characters that balloon in size after escaping
 * (e.g. `<` → `&lt;` is a 4x expansion).
 *
 * For anything you are composing into a single line of a Slack message,
 * prefer `sanitizeSlackLine` — it also flattens newlines and defuses
 * broadcast tokens.
 */
export function escapeSlackText(raw: string, maxLength = 240): string {
  return escapeMrkdwn(truncate(raw, maxLength));
}

/**
 * Window `flattenToSingleLine` collapses before deciding whether it has to
 * look at the whole input. 32x the longest field we render is a fast path,
 * not a security boundary: both replacements below are single-character
 * classes, so they run in linear time.
 */
const FLATTEN_FAST_PATH_FACTOR = 32;

/**
 * Hard ceiling on what the second pass will scan. An agent authors its own
 * error message and can make it arbitrarily long; this bounds the work and
 * the transient allocation at roughly 400 KB for the largest field we
 * render, which is far past any legitimate message.
 */
const FLATTEN_SCAN_CEILING_FACTOR = 1024;

/**
 * Characters that must never reach a Slack message or a stored
 * notification. Newlines and tabs are also covered by the whitespace
 * collapse below; this adds the rest of C0/C1 plus DEL, which can smuggle
 * invisible structure past a human reader.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Flatten untrusted text to a single bounded line, **without** escaping it.
 *
 * `escapeSlackText` defuses mentions and links but leaves newlines intact,
 * so an agent-supplied string can still forge extra lines in a message
 * whose shape the reader trusts ("Reported: …" followed by a convincing
 * "Status: passing"). This collapses every control character and run of
 * whitespace to a single space, then truncates.
 *
 * Use this for values that a later stage escapes for its own surface — a
 * notification title or body, which is stored as plain text and escaped
 * separately for Slack (mrkdwn) and for the web list (HTML). Escaping here
 * too would double-encode the stored value. When you are writing straight
 * into a Slack message, use `sanitizeSlackLine` instead.
 */
export function flattenToSingleLine(raw: string, maxLength = 160): string {
  const fastPathLimit = maxLength * FLATTEN_FAST_PATH_FACTOR;
  if (raw.length <= fastPathLimit) return truncate(collapse(raw), maxLength);

  const fromWindow = collapse(raw.slice(0, fastPathLimit));
  if (fromWindow.length >= maxLength) return truncate(fromWindow, maxLength);

  // The window was mostly padding. Without this second pass an agent could
  // bury its own error behind 12 KB of spaces and leave the owner a
  // notification body that renders empty and reads as a platform bug
  // (adcp#8320). One more linear pass, with its own ceiling.
  return truncate(collapse(raw.slice(0, maxLength * FLATTEN_SCAN_CEILING_FACTOR)), maxLength);
}

/**
 * Sanitize an untrusted value for interpolation into a *single-line* Slack
 * surface — a DM line, a channel message's `text` fallback, a block header,
 * or an identifier inside a section line. Flattens, escapes the mrkdwn
 * metacharacters, and defuses broadcast tokens.
 *
 * What survives on purpose: `*bold*`, `_italic_`, `~strike~` and backtick
 * spans. Those restyle text but cannot ping anyone or forge a destination,
 * and escaping them would mangle legitimate copy. Because the value is
 * flattened first, the residue cannot span lines either.
 */
export function sanitizeSlackLine(raw: string, maxLength = 160): string {
  return defuseBroadcastTokens(escapeMrkdwn(flattenToSingleLine(raw, maxLength)));
}

/**
 * Stricter form for the label half of Slack link syntax (`<url|LABEL>`).
 * Escaping leaves `|` alone, and a `|` inside the label starts another
 * field — so a submitter could still relabel the link. Angle brackets are
 * already entities by this point; the pipe is what is left to drop.
 */
export function sanitizeSlackLinkLabel(raw: string, maxLength = 160): string {
  return sanitizeSlackLine(raw, maxLength).replace(/\|/g, '');
}

/**
 * Slack link *targets* cannot be escaped — a `>` closes the link and
 * leaves the remainder as top-level mrkdwn, and a `|` adds another field.
 * Callers drop the link rather than render a broken one.
 */
export function isSafeSlackLinkTarget(url: string): boolean {
  return /^https?:\/\/[^\s<>|'"\\]+$/.test(url);
}

/**
 * Insert a zero-width space inside `!channel` / `!here` / `!everyone` so
 * the broadcast token stays defused even if something downstream unescapes
 * the angle brackets. Human-readable either way.
 */
function defuseBroadcastTokens(value: string): string {
  return value.replace(/!(channel|here|everyone)/gi, '!\u200b$1');
}

function collapse(value: string): string {
  return value
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(raw: string, maxLength: number): string {
  return raw.length > maxLength ? `${raw.slice(0, maxLength)}…` : raw;
}

function escapeMrkdwn(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
