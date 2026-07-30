const MAX_EXTERNAL_HTTP_URL_LENGTH = 2048;

export class InvalidExternalHttpUrlError extends Error {
  constructor(message = 'must be a valid HTTP or HTTPS URL') {
    super(message);
    this.name = 'InvalidExternalHttpUrlError';
  }
}

/**
 * Normalize an optional browser-facing external URL.
 *
 * `undefined` means "leave unchanged" and null/blank means "clear it".
 * Only absolute HTTP(S) URLs without embedded credentials are accepted.
 */
export function normalizeOptionalExternalHttpUrl(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new InvalidExternalHttpUrlError();

  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_EXTERNAL_HTTP_URL_LENGTH) {
    throw new InvalidExternalHttpUrlError(`must be ${MAX_EXTERNAL_HTTP_URL_LENGTH} characters or fewer`);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new InvalidExternalHttpUrlError();
  }

  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username
    || parsed.password
    || !parsed.hostname
  ) {
    throw new InvalidExternalHttpUrlError('must be an HTTP or HTTPS URL without embedded credentials');
  }

  return parsed.toString();
}
