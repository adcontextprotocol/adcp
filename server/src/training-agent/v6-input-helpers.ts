/**
 * Pick named fields off the v6 framework's `ctx.input` envelope so v5
 * handlers see fields the v6 platform-method signature destructures away.
 *
 * Why this exists: the v6 SDK's typed platform-method signatures drop
 * spec-meaningful modifiers from the request envelope before invoking
 * the method (`sync_creatives_request` loses `assignments[]`, `dry_run`,
 * etc.). The framework exposes the original envelope as a
 * `Readonly<Record<string, unknown>>` on `ctx.input`. Our v6 shims
 * forward to v5 handlers that DO read those fields, so we have to lift
 * them back out and pass them through.
 *
 * Per SDK guidance, treat `ctx.input` as buyer-controlled and untrusted:
 * read named fields only, never log wholesale. The v5 handler validates
 * shape — we only need to thread the value through.
 */
export function pickFromInput<K extends string>(
  input: Readonly<Record<string, unknown>> | undefined,
  fields: readonly K[],
): Partial<Record<K, unknown>> {
  if (!input) return {};
  const out: Partial<Record<K, unknown>> = {};
  for (const key of fields) {
    if (key in input) out[key] = input[key];
  }
  return out;
}
