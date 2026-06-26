const SECRET_MARKER = '[redacted-verification-token]';

const TOKEN_ASSIGNMENT_RE =
  /\b((?:verification[_ -]?token|dns[_ -]?txt[_ -]?value|txt[_ -]?value|secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*)(`?)[^\s`'"]{12,}(\2)/gi;
const MARKDOWN_VALUE_RE =
  /^(\s*[-*]?\s*(?:Value|TXT value|Verification token)\s*:\s*)`?[^`\r\n]{12,}`?/gim;
const WORKOS_DOMAIN_TOKEN_RE =
  /\b(?:wos|workos)[a-z0-9._=-]{8,}(?:verification|verify|domain)[a-z0-9._=-]*\b/gi;
const COMMON_SECRET_RE =
  /\b(?:sk_(?:live|test)_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g;
const AUTH_HEADER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi;
const MAX_REDACTION_INPUT_LENGTH = 20_000;

export function redactSupportSecrets(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const bounded = value.length > MAX_REDACTION_INPUT_LENGTH
    ? value.slice(0, MAX_REDACTION_INPUT_LENGTH)
    : value;
  return bounded
    .replace(MARKDOWN_VALUE_RE, `$1\`${SECRET_MARKER}\``)
    .replace(TOKEN_ASSIGNMENT_RE, (_match, prefix: string, quote: string) =>
      `${prefix}${quote || ''}${SECRET_MARKER}${quote || ''}`,
    )
    .replace(WORKOS_DOMAIN_TOKEN_RE, SECRET_MARKER)
    .replace(COMMON_SECRET_RE, '[redacted-secret]')
    .replace(AUTH_HEADER_RE, (_match, scheme: string) => `${scheme} [redacted-secret]`);
}
