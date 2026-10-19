/**
 * Forward-introduced specialisms — declared specialisms that postdate the
 * compliance bundle a hosted run is graded against.
 *
 * `@adcp/sdk`'s `resolveStoryboardsForCapabilities` fails closed on a declared
 * specialism that has no bundle in the selected compliance cache, and that
 * throw happens before a single storyboard runs, so the whole run is recorded
 * `not_completed` (adcp#8269). For a specialism AdCP only introduced in a
 * *later* release that verdict is wrong: the declaration is not an
 * agent-configuration fault, there is simply nothing in this release to grade.
 * The run should grade everything else and report the specialism as not
 * applicable for the target.
 *
 * The SDK exposes no option to exclude a specialism from resolution, but it
 * does read its index from `ResolveOptions.complianceDir`. So a tolerated run
 * is handed an overlay of the target cache: a private copy of the released
 * artifact whose `index.json` additionally lists the forward-introduced
 * specialisms with no parent protocol and no bundle directory. The resolver
 * then finds the entry (no throw), loads zero storyboards for it, and selects,
 * runs and grades everything else exactly as it would have without the
 * overlay. Released artifacts under `dist/compliance/<semver>/` are never
 * modified; the playbook allows transforming a scratch copy.
 *
 * The copy is a copy and not a symlink farm on purpose. The SDK resolves a
 * storyboard's declared `prerequisites.test_kit` and then requires the
 * *physical* path to sit under the physical compliance root
 * (`realpathSync`, `@adcp/sdk/.../storyboard/test-kit.js`). Symlinked entries
 * resolve back into `dist/`, fail that check, and throw mid-run — which would
 * void the run all over again.
 *
 * A specialism id that no AdCP release defines — including one a later release
 * *removed* — is not forward-introduced and keeps the existing fail-closed
 * behaviour, so a typo or a hostile declaration cannot silence grading.
 */

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  bundledComplianceVersions,
  compareComplianceVersions,
  hostedComplianceTarget,
  type HostedComplianceTarget,
} from '../services/hosted-compliance-version.js';
import { createLogger } from '../logger.js';

const logger = createLogger('forward-introduced-specialisms');

/**
 * Shape of a specialism id in `enums/specialism.json`. Only ids that match are
 * written into an overlay index, so a corrupted or hostile catalog entry can
 * never become a path segment or a long string in a generated file.
 */
const SPECIALISM_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Exact compliance cache version, the only precision the release comparison is
 * defined for. A line alias such as the `3.0` a badge row carries sorts below
 * every release, so an alias is resolved to that line's bundle first rather
 * than compared directly.
 */
const EXACT_COMPLIANCE_VERSION_RE = /^[1-9][0-9]*\.[0-9]+\.[0-9]+(?:-(?:beta|rc)\.[0-9]+)?$/;

interface ComplianceIndexFile {
  specialisms?: Array<{ id?: unknown }>;
}

function repoPath(...parts: string[]): string {
  return resolve(process.cwd(), ...parts);
}

const specialismIdsByVersion = new Map<string, ReadonlySet<string>>();

/** Specialism ids defined by one bundled compliance cache. */
function specialismIdsForComplianceVersion(version: string): ReadonlySet<string> {
  const cached = specialismIdsByVersion.get(version);
  if (cached) return cached;

  const ids = new Set<string>();
  try {
    const index = JSON.parse(
      readFileSync(join(repoPath('dist', 'compliance', version), 'index.json'), 'utf8'),
    ) as ComplianceIndexFile;
    for (const specialism of index.specialisms ?? []) {
      if (typeof specialism?.id === 'string' && SPECIALISM_ID_RE.test(specialism.id)) {
        ids.add(specialism.id);
      }
    }
  } catch (err) {
    // An unreadable cache must not make its specialisms look forward-introduced.
    // Returning an empty set only ever shrinks the tolerated set.
    logger.warn({ err, version }, 'Could not read compliance index while mapping specialism releases');
  }

  specialismIdsByVersion.set(version, ids);
  return ids;
}

const EMPTY_SPECIALISM_SET: ReadonlySet<string> = new Set<string>();
const forwardIntroducedByVersion = new Map<string, ReadonlySet<string>>();

/**
 * Specialisms AdCP introduced after `targetVersion`, which may be an exact
 * cache version (`3.0.28`) or a release-line alias (`3.0`): defined by a bundled
 * release newer than the target and by no release up to and including it.
 *
 * Only released bundles under `dist/compliance/` count. The working tree's
 * `static/compliance/source/specialisms/` is deliberately not consulted: a
 * specialism directory scaffolded for a future release but never cut would
 * otherwise silence `unknown_specialism` for every target, including the
 * newest one.
 */
export function forwardIntroducedSpecialisms(targetVersion: string): ReadonlySet<string> {
  const cached = forwardIntroducedByVersion.get(targetVersion);
  if (cached) return cached;
  if (!EXACT_COMPLIANCE_VERSION_RE.test(targetVersion)) {
    // Badge rows and explicit targets carry a line alias (`3.0`). Resolve it
    // to that line's bundle; anything that does not resolve tolerates nothing.
    let resolved: ReadonlySet<string> = EMPTY_SPECIALISM_SET;
    try {
      resolved = forwardIntroducedSpecialisms(hostedComplianceTarget(targetVersion).version);
    } catch (err) {
      logger.debug({ err, targetVersion }, 'No hosted compliance bundle for compliance target alias');
    }
    forwardIntroducedByVersion.set(targetVersion, resolved);
    return resolved;
  }

  const targetIds = specialismIdsForComplianceVersion(targetVersion);
  if (targetIds.size === 0) {
    // The target's own index is missing or unreadable. Seeding the known set
    // from it would make every specialism that release defines look
    // forward-introduced, so refuse to tolerate anything instead.
    forwardIntroducedByVersion.set(targetVersion, EMPTY_SPECIALISM_SET);
    return EMPTY_SPECIALISM_SET;
  }

  const knownByTargetRelease = new Set<string>(targetIds);
  const introducedLater = new Set<string>();
  // A cache directory carrying some other prerelease label sorts below every
  // release, so its specialisms land in the known set rather than the later
  // one. That only ever shrinks what is tolerated, which is the safe direction.
  for (const version of bundledComplianceVersions()) {
    const ids = specialismIdsForComplianceVersion(version);
    const target = compareComplianceVersions(version, targetVersion) <= 0
      ? knownByTargetRelease
      : introducedLater;
    for (const id of ids) target.add(id);
  }

  const forward: ReadonlySet<string> = new Set(
    [...introducedLater].filter(id => !knownByTargetRelease.has(id)).sort(),
  );
  forwardIntroducedByVersion.set(targetVersion, forward);
  return forward;
}

/** Whether `specialism` was introduced after the release `targetVersion` belongs to. */
export function isForwardIntroducedSpecialism(targetVersion: string, specialism: string): boolean {
  return forwardIntroducedSpecialisms(targetVersion).has(specialism);
}

/** Declared specialisms this target's bundle cannot grade because they postdate it. */
export function declaredSpecialismsNotApplicableForTarget(
  targetVersion: string,
  declaredSpecialisms: readonly unknown[] | undefined,
): string[] {
  const forward = forwardIntroducedSpecialisms(targetVersion);
  const notApplicable = new Set<string>();
  for (const declared of declaredSpecialisms ?? []) {
    if (typeof declared === 'string' && forward.has(declared)) notApplicable.add(declared);
  }
  return [...notApplicable].sort();
}

const overlayDirByVersion = new Map<string, string>();

/**
 * A compliance cache directory for `target` whose index also lists every
 * specialism introduced after it, so capability resolution reports them as an
 * empty bundle instead of throwing. Returns `undefined` when the target is the
 * newest release (nothing to tolerate) or the overlay cannot be created, in
 * which case callers keep the existing fail-closed behaviour.
 *
 * The overlay is created at most once per process per target version, inside a
 * `mkdtemp` directory so no other local user can pre-create or swap the path
 * the grader loads storyboards from. It is a few megabytes per graded line
 * (2 MB for 3.0, 4 MB for 3.1; the newest line needs none), and the process
 * has at most one per line, so it is left for the container's temp lifecycle
 * rather than reference-counted.
 */
export function complianceDirToleratingForwardIntroducedSpecialisms(
  target: HostedComplianceTarget,
): string | undefined {
  const forward = forwardIntroducedSpecialisms(target.version);
  if (forward.size === 0) return undefined;

  const cached = overlayDirByVersion.get(target.version);
  if (cached) return cached;

  try {
    const overlayDir = mkdtempSync(join(tmpdir(), 'adcp-compliance-overlay-'));
    cpSync(target.complianceDir, overlayDir, { recursive: true });

    const index = JSON.parse(
      readFileSync(join(target.complianceDir, 'index.json'), 'utf8'),
    ) as ComplianceIndexFile & Record<string, unknown>;
    index.specialisms = [
      ...(index.specialisms ?? []),
      // No `protocol`: the resolver only demands a declared parent protocol for
      // specialisms it can actually grade, and this release defines neither the
      // bundle nor (necessarily) the protocol it would roll up to.
      // `preview` keeps the entry inside the index's documented status
      // vocabulary (stable | preview | deprecated) and is the closest honest
      // fit: claimable, no graded verdict. Nothing on the grading path reads
      // it; the title carries the real reason.
      ...[...forward].map(id => ({
        id,
        protocol: '',
        title: 'Not defined in this compliance release',
        status: 'preview',
        required_tools: [],
        path: `specialisms/${id}/`,
      })),
    ];
    writeFileSync(join(overlayDir, 'index.json'), JSON.stringify(index), 'utf8');

    overlayDirByVersion.set(target.version, overlayDir);
    return overlayDir;
  } catch (err) {
    logger.error(
      { err, version: target.version },
      'Could not stage a compliance overlay for forward-introduced specialisms',
    );
    return undefined;
  }
}
