#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openBuyerAuthFile, startBuyerLogin, finishBuyerLogin, createBuyerOAuthSession, DEFAULT_BUYER_AGENT } from './training-buyer-auth.mjs';
import { closeMCPConnections } from '@adcp/sdk';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean' }, file: { type: 'string' }, issuer: { type: 'string' }, 'client-id': { type: 'string' },
    agent: { type: 'string', default: DEFAULT_BUYER_AGENT },
  } });
  if (values.help) {
    console.log('node scripts/training-buyer-login.mjs start|finish --file /private/path/oauth.json [--issuer https://your-authkit-domain] [--client-id client_public]\nstart prints the browser URL; finish reads the full callback URL from stdin. OAuth state must be outside the synced repository.'); return;
  }
  if (!values.file || !['start', 'finish'].includes(positionals[0])) throw new Error('Select start or finish and a private OAuth file.');
  const file = await openBuyerAuthFile(values.file, { create: positionals[0] === 'start' });
  try {
    if (positionals[0] === 'start') {
      const result = await startBuyerLogin(file, { agent: values.agent, issuer: values.issuer,
        clientId: values['client-id'], redirectUri: 'http://127.0.0.1:8765/callback' });
      console.log(`Open this URL and select the reporting organization:\n${result.authorizationUrl}\nAfter sign-in, copy the full 127.0.0.1 callback URL from the browser address bar. Run finish with that URL on stdin. The browser may report that it cannot connect.`);
    } else {
      let callback = '';
      for await (const part of process.stdin) { callback += part.toString(); if (callback.length > 8192) throw new Error('Callback too large.'); }
      await finishBuyerLogin(file, callback);
      const session = createBuyerOAuthSession(file, values.agent);
      await session.call('get_adcp_capabilities', {});
      console.log('Buyer sign-in verified by the sales endpoint. OAuth credentials saved privately.');
    }
  } finally { await file.close(); await closeMCPConnections(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Buyer sign-in failed. Check private configuration or start a fresh login. Credentials and callback codes are not printed.'); process.exitCode = 1; });
}
