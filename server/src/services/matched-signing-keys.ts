/**
 * How a `signing_keys` pin combines when more than one
 * `authorized_agents[]` entry in one publisher's `adagents.json` matches the
 * same agent (#9016, docs/governance/property/adagents#agent-url-matching).
 *
 * Under AdCP 3.3 an origin-only entry and an entry with the agent's full URL
 * can both match one agent, and each one authorizes it (the scope union,
 * #9011). The pin follows the same reasoning:
 *
 *   - PINNED ONLY IF EVERY MATCHING ENTRY PINS. One matching entry with no
 *     `signing_keys` (absent or empty) already authorizes the agent with any
 *     key, so the agent is unpinned for that publisher.
 *   - THE ALLOWED KEYS ARE THE UNION. When every matching entry pins, the
 *     agent may sign with a key any of them pins.
 *
 * A narrower entry never adds a restriction another matching entry does not
 * impose. With a single matching entry this is that entry's own pin, so the
 * 3.2 exact-match path reads the same as before.
 *
 * Which entries "match" is the caller's call and is the set it authorizes
 * with: `AgentValidator` passes the entries that authorize the agent for the
 * requested scope; the registry directory, which has no scope, passes every
 * entry whose URL authorizes the agent (`agentUrlAuthorizedBy`).
 *
 * This is the combination WITHIN one publisher's file. A signature about
 * several publishers' inventory must still match every applicable
 * publisher's pin (docs/building/by-layer/L1/security#agent-resolution).
 */

/** Whether `entry` pins at least one signing key. An empty array does not. */
export function entryPinsSigningKeys(entry: { signing_keys?: unknown }): boolean {
  return Array.isArray(entry.signing_keys) && entry.signing_keys.length > 0;
}

/**
 * Whether the agent is pinned for the publisher, given the entries that
 * match it: true only when at least one entry matches and every one pins.
 */
export function everyMatchingEntryPins(entries: ReadonlyArray<{ signing_keys?: unknown }>): boolean {
  return entries.length > 0 && entries.every(entryPinsSigningKeys);
}

/**
 * The keys the agent may sign with for this publisher, given the entries that
 * match it: the union of their pins, or `undefined` (no restriction) when no
 * entry matches or any matching entry is unpinned.
 *
 * Keys are deduplicated by value only when they are identical, member order
 * aside. Two spellings of one public key that differ in any member, such as a
 * `revoked_at` on one of them, are both kept, so a revocation on one entry is
 * never dropped in favour of an unrevoked copy on another.
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
