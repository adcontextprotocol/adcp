import fs from 'node:fs';
import path from 'node:path';

export const SIGN_PHRASE = 'I have read the IPR Policy';
export const SIGNATURES_PATH = 'signatures/ipr-signatures.json';

// Unicode NFKC normalizes compatibility forms (e.g. decomposed accents, full-width
// ASCII) so a paste that looks right visually isn't silently rejected. We do not
// strip zero-width or control characters — a contributor who inserts those is
// outside the "exact phrase" contract the policy describes.
const SIGN_PHRASE_CANONICAL = SIGN_PHRASE.normalize('NFKC').toLowerCase();

export function readSignatures(repoRoot = process.cwd()) {
  const full = path.join(repoRoot, SIGNATURES_PATH);
  if (!fs.existsSync(full)) {
    return { signedContributors: [] };
  }
  const raw = fs.readFileSync(full, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.signedContributors)) {
    throw new Error(`Malformed ${SIGNATURES_PATH}: missing signedContributors array`);
  }
  return parsed;
}

export function writeSignatures(data, repoRoot = process.cwd()) {
  const full = path.join(repoRoot, SIGNATURES_PATH);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const ordered = {
    signedContributors: sortContributors(data.signedContributors),
  };
  fs.writeFileSync(full, JSON.stringify(ordered, null, 2) + '\n');
}

export function hasSigned(data, githubId) {
  return data.signedContributors.some((c) => c.id === githubId);
}

export function findSignature(data, githubId) {
  return data.signedContributors.find((c) => c.id === githubId) ?? null;
}

export function addSignature(data, entry) {
  const required = ['name', 'id', 'created_at', 'method'];
  for (const key of required) {
    if (entry[key] === undefined || entry[key] === null) {
      throw new Error(`Signature entry missing required field: ${key}`);
    }
  }
  if (hasSigned(data, entry.id)) {
    return { data, added: false };
  }
  const next = {
    signedContributors: [...data.signedContributors, entry],
  };
  return { data: next, added: true };
}

export function normalizeCommentBody(body) {
  return (body ?? '').normalize('NFKC').trim().toLowerCase();
}

export function isSignPhrase(body) {
  return normalizeCommentBody(body) === SIGN_PHRASE_CANONICAL;
}

function sortContributors(list) {
  return [...list].sort((a, b) => {
    const ta = Date.parse(a.created_at) || 0;
    const tb = Date.parse(b.created_at) || 0;
    if (ta !== tb) return ta - tb;
    return (a.name ?? '').localeCompare(b.name ?? '');
  });
}
