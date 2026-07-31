import crypto from 'node:crypto';

const CAPABILITY_VERSION = 1;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let ephemeralSecret: Buffer | null = null;

interface CapabilityPayload {
  v: number;
  aud: string;
  sub: string;
  exp: number;
}

function capabilitySecret(): Buffer {
  const configured =
    process.env.ANONYMOUS_SESSION_CAPABILITY_SECRET ||
    process.env.WORKOS_COOKIE_PASSWORD;
  if (configured && configured.length >= 32) {
    return Buffer.from(configured, 'utf8');
  }

  // Local/dev environments may run without WorkOS. An in-process secret keeps
  // capabilities cryptographically unforgeable, at the cost of invalidating
  // anonymous sessions when the process restarts. Production has the stable
  // WorkOS cookie secret (or can set the dedicated capability secret).
  ephemeralSecret ??= crypto.randomBytes(32);
  return ephemeralSecret;
}

function signature(encodedPayload: string): string {
  return crypto
    .createHmac('sha256', capabilitySecret())
    .update(encodedPayload)
    .digest('base64url');
}

export function issueAnonymousSessionCapability(
  audience: string,
  subject: string,
  ttlMs = DEFAULT_TTL_MS,
): string {
  const payload: CapabilityPayload = {
    v: CAPABILITY_VERSION,
    aud: audience,
    sub: subject,
    exp: Date.now() + ttlMs,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encodedPayload}.${signature(encodedPayload)}`;
}

export function verifyAnonymousSessionCapability(
  token: unknown,
  audience: string,
  subject?: string,
): CapabilityPayload | null {
  if (typeof token !== 'string') return null;
  const [encodedPayload, presentedSignature, extra] = token.split('.');
  if (!encodedPayload || !presentedSignature || extra !== undefined) return null;

  const expectedSignature = signature(encodedPayload);
  const expected = Buffer.from(expectedSignature, 'utf8');
  const presented = Buffer.from(presentedSignature, 'utf8');
  if (expected.length !== presented.length || !crypto.timingSafeEqual(expected, presented)) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    ) as Partial<CapabilityPayload>;
    if (
      payload.v !== CAPABILITY_VERSION ||
      payload.aud !== audience ||
      typeof payload.sub !== 'string' ||
      payload.sub.length === 0 ||
      typeof payload.exp !== 'number' ||
      payload.exp <= Date.now() ||
      (subject !== undefined && payload.sub !== subject)
    ) {
      return null;
    }
    return payload as CapabilityPayload;
  } catch {
    return null;
  }
}
