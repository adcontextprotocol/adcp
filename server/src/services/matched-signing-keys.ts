/**
 * How a `signing_keys` pin combines when more than one
 * `authorized_agents[]` entry in one publisher's `adagents.json` authorizes
 * the same agent for the same message (#9016,
 * docs/governance/property/adagents#agent-url-matching).
 *
 * Under AdCP 3.3 an origin-only entry and an entry with the agent's full URL
 * can both match one agent, and each one authorizes it (the scope union,
 * #9011). The pin follows the same reasoning, over the entries that BOTH match
 * the agent's URL AND authorize the message's scope (the entry resolves, is
 * inside its effective window, matches the country, covers the property). An
 * entry that authorizes nothing for this message neither pins nor unpins it.
 *
 *   - PINNED ONLY IF EVERY SUCH ENTRY PINS. One of them with no
 *     `signing_keys` (absent or empty) already authorizes the message with
 *     any key, so the publisher does not pin the agent for it.
 *   - THE ALLOWED KEYS ARE THE UNION of their pins.
 *   - PER PROPERTY. A message about several of the publisher's properties
 *     gets one pin per property, and the key must satisfy each
 *     (`intersectSigningKeyPins`), as it must satisfy each publisher's.
 *   - REVOCATION. A `revoked_at` on any copy of a key applies; the earliest
 *     wins whatever the entry order. Copies that differ only in `revoked_at`
 *     are therefore all kept, never collapsed into the unrevoked one.
 *
 * With a single authorizing entry this is that entry's own pin, so the 3.2
 * exact-match path reads the same as before.
 */

/** Whether `entry` pins at least one signing key. An empty array does not. */
export function entryPinsSigningKeys(entry: { signing_keys?: unknown }): boolean {
  return Array.isArray(entry.signing_keys) && entry.signing_keys.length > 0;
}

/**
 * Whether the publisher pins the agent, given the entries that authorize it
 * for the message: true only when at least one does and every one pins.
 */
export function everyMatchingEntryPins(entries: ReadonlyArray<{ signing_keys?: unknown }>): boolean {
  return entries.length > 0 && entries.every(entryPinsSigningKeys);
}

/**
 * The keys the agent may sign with, given the entries that authorize it for
 * the message (one property): the union of their pins, or `undefined` (no
 * restriction) when none authorizes it or any of them is unpinned.
 *
 * Identical keys (member order aside) appear once; copies that differ in any
 * member, such as `revoked_at`, are all kept so a revocation is never lost.
 */
export function combinedSigningKeys<K>(
  entries: ReadonlyArray<{ signing_keys?: readonly K[] | null }>,
): K[] | undefined {
  if (!everyMatchingEntryPins(entries)) return undefined;
  const seen = new Set<string>();
  const keys: K[] = [];
  for (const entry of entries) {
    for (const key of entry.signing_keys ?? []) {
      const id = stableJson(key);
      if (seen.has(id)) continue;
      seen.add(id);
      keys.push(key);
    }
  }
  return keys;
}

/**
 * The keys a message about several properties may be signed with, given one
 * pin per property (`undefined` = that property is unpinned): a key must be
 * allowed by every pinned property. `undefined` when no property is pinned;
 * `[]` (accept no key) when the pinned properties share no key.
 *
 * Keys are matched by their public material, ignoring `revoked_at`, and every
 * copy of a surviving key is kept, so the earliest revocation still applies.
 */
export function intersectSigningKeyPins<K>(pins: ReadonlyArray<readonly K[] | undefined>): K[] | undefined {
  const pinned = pins.filter((pin): pin is readonly K[] => pin !== undefined);
  if (pinned.length === 0) return undefined;
  const identitiesIn = (pin: readonly K[]) => new Set(pin.map(keyIdentity));
  const shared = pinned.map(identitiesIn).reduce((acc, ids) => new Set([...acc].filter(id => ids.has(id))));
  return combinedSigningKeys(pinned.map(pin => ({ signing_keys: pin.filter(key => shared.has(keyIdentity(key))) })))
    ?? [];
}

/** A key's identity for intersection: every member except `revoked_at`. */
function keyIdentity(key: unknown): string {
  if (!key || typeof key !== 'object' || Array.isArray(key)) return stableJson(key);
  const { revoked_at: _revokedAt, ...rest } = key as Record<string, unknown>;
  return stableJson(rest);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort()
      .map(name => `${JSON.stringify(name)}:${stableJson(record[name])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
