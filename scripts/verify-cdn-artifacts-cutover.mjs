#!/usr/bin/env node
import { createHash } from "node:crypto";

const DEFAULT_REFERENCE = "https://adcontextprotocol.org";
const DEFAULT_CANDIDATE = "https://adcp-artifacts-cdn.brian-8ca.workers.dev";
const GENERATED_JSON_KEYS = new Set(["generated_at", "_generatedAt", "generatedAt"]);

const options = parseArgs(process.argv.slice(2));
const referenceBase = normalizeBase(options.reference ?? DEFAULT_REFERENCE);
const candidateBase = normalizeBase(options.candidate ?? DEFAULT_CANDIDATE);

const fixedContentPaths = [
  "/schemas/",
  "/schemas/v3/index.json",
  "/schemas/v3/manifest.json",
  "/schemas/v3.0/index.json",
  "/schemas/v3.0/manifest.json",
  "/schemas/latest/index.json",
  "/schemas/latest/manifest.json",
  "/compliance/",
  "/compliance/v3/index.json",
  "/compliance/v3.0/index.json",
  "/compliance/latest/index.json",
  "/protocol",
  "/protocol/",
  "/protocol/latest.tgz",
  "/protocol/latest.tgz.sha256",
];

const redirectPaths = [
  "/schemas",
  "/schemas/v3/",
  "/schemas/v3.0/",
  "/compliance",
  "/compliance/v3/",
  "/compliance/v3.0/",
];

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main() {
  console.log(`Reference: ${referenceBase}`);
  console.log(`Candidate: ${candidateBase}`);

  const contentPaths = new Set(fixedContentPaths);
  await addSchemaRegistryPaths(contentPaths);
  await addProtocolDiscoveryPaths(contentPaths);

  const failures = [];
  let checked = 0;
  for (const path of [...redirectPaths].sort()) {
    checked += 1;
    const result = await compareRedirect(path);
    if (!result.ok) failures.push(result.message);
  }

  for (const path of [...contentPaths].sort()) {
    checked += 1;
    const result = await compareContent(path);
    if (!result.ok) failures.push(result.message);
  }

  if (failures.length > 0) {
    console.error(`\nCDN cutover verification failed: ${failures.length} diffs across ${checked} checks.`);
    for (const failure of failures.slice(0, 25)) {
      console.error(`- ${failure}`);
    }
    if (failures.length > 25) {
      console.error(`- ... ${failures.length - 25} more`);
    }
    process.exit(1);
  }

  console.log(`\nCDN cutover verification passed: ${checked} checks.`);
}

async function addSchemaRegistryPaths(paths) {
  for (const registryPath of ["/schemas/v3/index.json", "/schemas/v3/manifest.json"]) {
    const json = await fetchJson(new URL(registryPath, referenceBase));
    collectArtifactPaths(json, paths);
  }
}

async function addProtocolDiscoveryPaths(paths) {
  const json = await fetchJson(new URL("/protocol/", referenceBase));
  collectArtifactPaths(json, paths);
}

function collectArtifactPaths(value, paths) {
  if (Array.isArray(value)) {
    for (const item of value) collectArtifactPaths(item, paths);
    return;
  }

  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectArtifactPaths(item, paths);
    return;
  }

  if (typeof value !== "string") return;
  if (value.startsWith("/schemas/") || value.startsWith("/compliance/") || value.startsWith("/protocol/")) {
    paths.add(value);
  }
}

async function compareRedirect(path) {
  const [reference, candidate] = await Promise.all([
    fetchNoFollow(new URL(path, referenceBase)),
    fetchNoFollow(new URL(path, candidateBase)),
  ]);

  if (reference.status !== candidate.status) {
    return fail(path, `redirect status ${reference.status} != ${candidate.status}`);
  }

  const referenceLocation = normalizeLocation(reference.headers.get("location"));
  const candidateLocation = normalizeLocation(candidate.headers.get("location"));
  if (referenceLocation !== candidateLocation) {
    return fail(path, `redirect location ${referenceLocation ?? "<none>"} != ${candidateLocation ?? "<none>"}`);
  }

  return pass();
}

async function compareContent(path) {
  const [reference, candidate] = await Promise.all([
    fetchFollow(new URL(path, referenceBase)),
    fetchFollow(new URL(path, candidateBase)),
  ]);

  if (reference.status !== candidate.status) {
    return fail(path, `status ${reference.status} != ${candidate.status}`);
  }

  const referenceBytes = Buffer.from(await reference.arrayBuffer());
  const candidateBytes = Buffer.from(await candidate.arrayBuffer());
  const contentType = reference.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const same = compareJson(referenceBytes, candidateBytes);
    if (!same) {
      return fail(path, `json differs ${digest(referenceBytes)} != ${digest(candidateBytes)}`);
    }
    return pass();
  }

  if (!referenceBytes.equals(candidateBytes)) {
    return fail(path, `bytes differ ${digest(referenceBytes)} != ${digest(candidateBytes)}`);
  }

  return pass();
}

function compareJson(referenceBytes, candidateBytes) {
  try {
    const reference = normalizeJson(JSON.parse(referenceBytes.toString("utf8")));
    const candidate = normalizeJson(JSON.parse(candidateBytes.toString("utf8")));
    return stableStringify(reference) === stableStringify(candidate);
  } catch {
    return referenceBytes.equals(candidateBytes);
  }
}

function normalizeJson(value) {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (!value || typeof value !== "object") return value;

  const normalized = {};
  for (const [key, child] of Object.entries(value)) {
    if (GENERATED_JSON_KEYS.has(key)) continue;
    if (key === "_bundled" && child && typeof child === "object") {
      const bundled = normalizeJson(child);
      if (bundled && typeof bundled === "object") delete bundled.generatedAt;
      normalized[key] = bundled;
      continue;
    }
    normalized[key] = normalizeJson(child);
  }
  return normalized;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

async function fetchJson(url) {
  const response = await fetchFollow(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.json();
}

async function fetchFollow(url) {
  return fetch(url, { redirect: "follow" });
}

async function fetchNoFollow(url) {
  return fetch(url, { redirect: "manual" });
}

function normalizeLocation(location) {
  if (!location) return null;
  try {
    const parsed = new URL(location);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return location;
  }
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

function normalizeBase(value) {
  const url = new URL(value);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--reference") {
      parsed.reference = readValue(args, ++index, arg);
    } else if (arg === "--candidate") {
      parsed.candidate = readValue(args, ++index, arg);
    } else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function readValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function pass() {
  return { ok: true };
}

function fail(path, message) {
  return { ok: false, message: `${path}: ${message}` };
}

function usage() {
  console.log(`Usage: node scripts/verify-cdn-artifacts-cutover.mjs [options]

Options:
  --reference URL  Source of truth. Default: ${DEFAULT_REFERENCE}
  --candidate URL  Candidate CDN endpoint. Default: ${DEFAULT_CANDIDATE}
`);
}
