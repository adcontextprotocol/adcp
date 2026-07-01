export function isCompleteStoredBasicCredential(token: string): boolean {
  const decoded = Buffer.from(token, 'base64').toString('utf8');
  const colonIndex = decoded.indexOf(':');
  return colonIndex > 0;
}

export function normalizeBasicAuthForStorage(token: string): { ok: true; stored: string } | { ok: false } {
  if (token.includes(':')) {
    const colonIndex = token.indexOf(':');
    if (!token.slice(0, colonIndex)) return { ok: false };
    return { ok: true, stored: Buffer.from(token, 'utf8').toString('base64') };
  }
  if (!isCompleteStoredBasicCredential(token)) return { ok: false };
  return { ok: true, stored: token };
}
