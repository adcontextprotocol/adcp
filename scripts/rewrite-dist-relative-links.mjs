#!/usr/bin/env node
/**
 * Depth-aware rewrite of relative links that escape the `docs/` tree.
 *
 * When a source file at `docs/<inner>/<file>.md` is mirrored to
 * `dist/docs/<version>/<inner>/<file>.md`, the dist file is exactly 2 path
 * segments deeper than the source. Any relative link in the source that
 * escapes `docs/` (i.e., uses more `../` segments than its inner depth)
 * needs 2 extra `../` segments to land on the same target from the dist
 * mirror.
 *
 * Examples (source → dist rewrite):
 *   docs/contributing/file.md (depth 1 in docs):
 *     `../sibling/file.md`      → unchanged (still inside docs)
 *     `../../static/foo.yaml`   → `../../../../static/foo.yaml` (+2 ../ )
 *     `../../../scripts/x.sh`   → `../../../../../scripts/x.sh` (+2 ../ )
 *
 *   docs/file.md (depth 0):
 *     `../static/foo.yaml`      → `../../../static/foo.yaml` (+2 ../ )
 *
 *   docs/a/b/file.md (depth 2):
 *     `../../sibling.md`        → unchanged (still inside docs)
 *     `../../../static/foo`     → `../../../../../static/foo` (+2 ../ )
 *
 * Usage: node scripts/rewrite-dist-relative-links.mjs <file>
 *   <file> must be under `dist/docs/<version>/` so source depth can be inferred.
 *
 * Exit codes: 0 on success (whether or not the file changed). Prints `changed`
 * or `unchanged` so the calling shell script can count diffs.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Compute how many path segments the source file sits at within `docs/`.
 * For dist path `dist/docs/3.0.1/contributing/storyboard-authoring.md`,
 * the source path is `docs/contributing/storyboard-authoring.md` and the
 * depth-within-docs is 1 (the `contributing/` directory).
 */
export function sourceDepthInDocs(distFile) {
  // Strip everything up to and including `dist/docs/<version>/`.
  const norm = distFile.replace(/\\/g, '/');
  const m = norm.match(/dist\/docs\/[^/]+\/(.*)$/);
  if (!m) {
    throw new Error(`Not a dist/docs/<version>/ path: ${distFile}`);
  }
  const innerPath = m[1]; // e.g., "contributing/storyboard-authoring.md"
  const dirSegments = innerPath.split('/').slice(0, -1); // drop filename
  return dirSegments.length;
}

/**
 * Rewrite escaping `../` links in markdown/MDX content.
 *
 * Matches `](...)` and `href="..."` link bodies that begin with one or more
 * `../` segments. Rewrites only links whose `../` count is exactly `sourceDepth + 1`
 * — the *minimal escape* of `docs/` from a source file at that depth. Two
 * properties fall out of this:
 *
 * 1. **Correctness.** A link with the minimal-escape count is exactly the link
 *    that lands on a repo-root sibling like `static/`, `compliance/`, etc.,
 *    when read from source. That is the link that breaks when the file is
 *    mirrored into `dist/docs/<version>/` (which adds 2 path segments) and
 *    needs +2 `../` to land on the same target.
 *
 * 2. **Idempotence.** Post-rewrite, the same link has count `sourceDepth + 3`
 *    (the +2 we added). On a second pass the count no longer matches
 *    `sourceDepth + 1` and the rule is a no-op. Running the script twice on
 *    the same dist file produces the same content.
 *
 * Links with `count != sourceDepth + 1` are left alone:
 *   - count <= sourceDepth: stays inside `docs/`, target also mirrors, no
 *     rewrite needed.
 *   - count > sourceDepth + 1: either over-escaping (target outside repo, a
 *     source-side bug — don't paper over) or already-rewritten content.
 */
export function rewriteContent(content, sourceDepth) {
  // Pattern matches the *prefix* of a relative link starting with `../`s.
  // Group 1 = the lead-in `](` or `href="` (also accepts `\``  for inline-code links).
  // Group 2 = the run of `../` segments.
  const re = /(\]\(|href="|`)((?:\.\.\/)+)/g;
  const minimalEscape = sourceDepth + 1;

  return content.replace(re, (match, lead, dotdots) => {
    const count = (dotdots.match(/\.\.\//g) || []).length;
    if (count === minimalEscape) {
      // Link minimally escapes `docs/` — needs +2 `../` for the dist mirror.
      return `${lead}${dotdots}../../`;
    }
    return match;
  });
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: rewrite-dist-relative-links.mjs <file>');
    process.exit(2);
  }

  const depth = sourceDepthInDocs(file);
  const before = readFileSync(file, 'utf8');
  const after = rewriteContent(before, depth);

  if (before === after) {
    console.log('unchanged');
    return;
  }
  writeFileSync(file, after);
  console.log('changed');
}

// Only run main() when executed directly, not when imported by tests.
// Use pathToFileURL for a robust comparison that handles symlinks and
// case-insensitive filesystems correctly (vs. naive string comparison).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
