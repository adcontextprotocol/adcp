#!/usr/bin/env node
// Prove that a release's committed schema and compliance trees are exactly the
// trees inside that release's signed protocol tarball.
//
// CDN recovery (RELEASING.md "Recovering a release's CDN artifacts") republishes
// hundreds of individual objects for a historical version. Nothing in R2 is
// signed, so the only cryptographic authority available is the cosign signature
// over `dist/protocol/<version>.tgz`. `build-protocol-tarball.cjs` stages that
// tarball by copying `dist/schemas/<version>` and `dist/compliance/<version>`
// verbatim, so proving tree parity makes that one signature transitively cover
// every object recovery is about to write — every byte except the value of one
// bounded timestamp field in the two files named below, which the bundle build
// re-pins and which is therefore constrained by shape and size rather than by
// the signature.
//
// Usage:
//   node check-protocol-bundle-parity.cjs <version> <released-root> <bundle-root>
//
//   released-root  directory holding dist/schemas/<version> and
//                  dist/compliance/<version>, materialized from the tag's
//                  Git blobs
//   bundle-root    the extracted `adcp-<version>/` directory from the tarball
//
// Exits non-zero, with no partial success, on any divergence.

const fs = require("node:fs");
const path = require("node:path");

const STABLE_SEMVER = /^\d+\.\d+\.\d+$/;
// Bounded fractional seconds. The published bytes for the two files below are
// the committed ones, so this field's value is the only thing the release
// signature does not cover; an unbounded fraction would let a release PR
// commit a multi-megabyte "timestamp" that passes parity and is then
// unfixable under the no-overwrite rule.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
// Belt and braces on the same bound, in bytes rather than shape.
const MAX_PINNED_DELTA_BYTES = 64;

// The only divergence `build-protocol-tarball.cjs` is allowed to introduce.
// `pinGeneratedAt` rewrites the staged copy's build timestamp, which is written
// by a later build step than the one that wrote the committed tree. Its sibling
// `pinPublishedVersion` only runs when the bundle is republished under a
// different version, which a release build never does, so nothing else may
// differ. Keyed by surface so a compliance file named manifest.json, or a
// schema file named index.json, gets no exemption.
const PINNED_BUILD_TIMESTAMP_FILES = new Map([
  ["schemas", "manifest.json"],
  ["compliance", "index.json"],
]);

function fail(message) {
  throw new Error(message);
}

// Reject anything that is not a plain file or directory, so a symlink cannot
// smuggle bytes from outside the compared tree into the comparison or the
// upload that follows it.
function walk(root, surface) {
  const files = [];
  const visit = (relative) => {
    const absolute = path.join(root, relative || ".");
    const metadata = fs.lstatSync(absolute);
    if (metadata.isSymbolicLink())
      fail(`Symlinked ${surface} entry: ${relative}`);
    if (metadata.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort())
        visit(relative ? path.join(relative, name) : name);
      return;
    }
    if (!metadata.isFile()) fail(`Unsupported ${surface} entry: ${relative}`);
    files.push(relative);
  };
  visit("");
  if (files.length === 0) fail(`Empty ${surface} tree: ${root}`);
  return files;
}

function parsePinnedDocument(bytes, label) {
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch {
    return fail(`Pinned build-timestamp file is not JSON: ${label}`);
  }
  if (
    !document ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    typeof document.generated_at !== "string" ||
    !ISO_TIMESTAMP.test(document.generated_at)
  )
    fail(`Pinned build-timestamp file has no ISO generated_at: ${label}`);
  return document;
}

// Byte equality after substituting exactly the one value the bundle build is
// allowed to rewrite. Deep JSON equality would also accept reordered keys and
// reformatted bytes; this does not.
function matchesExceptPinnedTimestamp(releasedBytes, bundleBytes, label) {
  if (Math.abs(releasedBytes.length - bundleBytes.length) > MAX_PINNED_DELTA_BYTES)
    fail(`Pinned build-timestamp file differs by more than a timestamp: ${label}`);
  const released = parsePinnedDocument(releasedBytes, label);
  const bundle = parsePinnedDocument(bundleBytes, label);
  const needle = Buffer.from(
    `"generated_at": ${JSON.stringify(bundle.generated_at)}`,
    "utf8",
  );
  const replacement = Buffer.from(
    `"generated_at": ${JSON.stringify(released.generated_at)}`,
    "utf8",
  );
  const first = bundleBytes.indexOf(needle);
  if (first === -1) return false;
  if (bundleBytes.indexOf(needle, first + needle.length) !== -1)
    fail(`Ambiguous generated_at occurrences in ${label}`);
  const normalized = Buffer.concat([
    bundleBytes.subarray(0, first),
    replacement,
    bundleBytes.subarray(first + needle.length),
  ]);
  return normalized.equals(releasedBytes);
}

function compareSurface(surface, releasedRoot, bundleRoot) {
  for (const [label, root] of [
    [`released ${surface}`, releasedRoot],
    [`bundled ${surface}`, bundleRoot],
  ])
    if (!fs.existsSync(root)) fail(`Missing ${label} tree: ${root}`);

  const released = walk(releasedRoot, `released ${surface}`);
  const bundle = walk(bundleRoot, `bundled ${surface}`);
  const bundled = new Set(bundle);
  const expected = new Set(released);
  const extra = bundle.filter((file) => !expected.has(file));
  const missing = released.filter((file) => !bundled.has(file));
  if (missing.length || extra.length)
    fail(
      `Bundled ${surface} tree does not match the released tree` +
        (missing.length ? `; missing ${missing.slice(0, 5).join(", ")}` : "") +
        (extra.length ? `; unexpected ${extra.slice(0, 5).join(", ")}` : ""),
    );

  const pinned = PINNED_BUILD_TIMESTAMP_FILES.get(surface);
  for (const file of released) {
    const releasedBytes = fs.readFileSync(path.join(releasedRoot, file));
    const bundleBytes = fs.readFileSync(path.join(bundleRoot, file));
    if (releasedBytes.equals(bundleBytes)) continue;
    const label = `${surface}/${file}`;
    if (
      file === pinned &&
      matchesExceptPinnedTimestamp(releasedBytes, bundleBytes, label)
    )
      continue;
    fail(`Released ${label} differs from the signed protocol bundle`);
  }
  return released.length;
}

function checkBundleParity(version, releasedRoot, bundleRoot) {
  if (!STABLE_SEMVER.test(version || ""))
    fail("Bundle parity requires an exact stable semver version.");
  const counts = {};
  for (const surface of ["schemas", "compliance"]) {
    counts[surface] = compareSurface(
      surface,
      path.join(releasedRoot, "dist", surface, version),
      path.join(bundleRoot, surface),
    );
  }
  return counts;
}

if (require.main === module) {
  const [version, releasedRoot, bundleRoot] = process.argv.slice(2);
  if (!version || !releasedRoot || !bundleRoot) {
    console.error(
      "Usage: check-protocol-bundle-parity.cjs <version> <released-root> <bundle-root>",
    );
    process.exitCode = 2;
  } else {
    try {
      const counts = checkBundleParity(version, releasedRoot, bundleRoot);
      console.log(
        `Signed protocol bundle ${version} covers ${counts.schemas} schema and ${counts.compliance} compliance files.`,
      );
    } catch (error) {
      console.error(
        `::error::${error.message}\nRecovery stopped: the released trees are not the signed bundle's trees, so the release signature does not cover them. See RELEASING.md.`,
      );
      process.exitCode = 1;
    }
  }
}

module.exports = { checkBundleParity };
