// Guard for the push target of `signatures/ipr-signatures.json` writes.
// Receives the literal output of `git remote get-url origin` and returns
// whether it points at adcontextprotocol/adcp on github.com over https,
// independent of how credentials are presented (embedded userinfo vs
// credential-helper). Rejects other repos, hosts, schemes, and SSH URLs.
export function isLedgerRemoteAllowed(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.host !== 'github.com') return false;
  const path = parsed.pathname.replace(/\/$/, '').replace(/\.git$/, '');
  return path === '/adcontextprotocol/adcp';
}
