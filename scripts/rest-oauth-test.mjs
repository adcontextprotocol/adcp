#!/usr/bin/env node
/**
 * REST API OAuth test script
 *
 * Proves that a single OAuth-issued user JWT works against both
 * the MCP endpoint AND the REST API on the same server. Flow:
 *
 * 1. Discovers PRM at /.well-known/oauth-protected-resource/api
 * 2. Discovers AS metadata
 * 3. Registers a dynamic client (RFC 7591)
 * 4. Opens browser for authorization (AuthKit)
 * 5. Captures the callback, exchanges code for token
 * 6. Calls REST API with the bearer token — both a read and a write
 *
 * Usage: node scripts/rest-oauth-test.mjs [port]
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const PORT = process.argv[2] || '55020';
const BASE_URL = `http://localhost:${PORT}`;
const CALLBACK_PORT = 8789;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function main() {
  console.log(`\n🔑 REST OAuth Test — ${BASE_URL}/api\n`);

  // Step 1: Discover PRM for /api
  console.log('1️⃣  Fetching Protected Resource Metadata for /api...');
  const prmRes = await fetch(`${BASE_URL}/.well-known/oauth-protected-resource/api`);
  if (!prmRes.ok) {
    throw new Error(`PRM fetch failed: ${prmRes.status} ${await prmRes.text()}`);
  }
  const prm = await prmRes.json();
  console.log(`   Resource: ${prm.resource}`);
  console.log(`   Auth server: ${prm.authorization_servers[0]}`);
  console.log(`   Bearer methods: ${prm.bearer_methods_supported?.join(', ')}`);

  // Step 2: Discover AS metadata
  const asUrl = prm.authorization_servers[0];
  console.log('\n2️⃣  Fetching AS Metadata...');
  const asRes = await fetch(`${asUrl}/.well-known/oauth-authorization-server`);
  const as = await asRes.json();
  console.log(`   Token endpoint: ${as.token_endpoint}`);
  console.log(`   Registration: ${as.registration_endpoint}`);

  // Step 3: Dynamic client registration
  console.log('\n3️⃣  Registering dynamic client...');
  const regRes = await fetch(as.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'REST OAuth Test Script',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const client = await regRes.json();
  if (!client.client_id) {
    console.error('   ❌ Registration failed:', JSON.stringify(client));
    process.exit(1);
  }
  console.log(`   Client ID: ${client.client_id}`);

  // Step 4: PKCE + authorization URL
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
  const state = base64url(crypto.randomBytes(16));

  const authUrl = new URL(as.authorization_endpoint);
  authUrl.searchParams.set('client_id', client.client_id);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid profile email');
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);

  // Step 5: Start callback server and open browser
  console.log('\n4️⃣  Starting callback server and opening browser...');

  const tokenPromise = new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`Auth Error: ${error}\n${url.searchParams.get('error_description')}`);
        server.close();
        reject(new Error(error));
        return;
      }

      if (returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h2>❌ State mismatch</h2>');
        server.close();
        reject(new Error('State mismatch'));
        return;
      }

      console.log('\n5️⃣  Exchanging authorization code for token...');
      const tokenRes = await fetch(as.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          client_id: client.client_id,
          code_verifier: codeVerifier,
        }),
      });
      const tokenData = await tokenRes.json();

      if (tokenData.error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<h2>❌ Token Error: ${tokenData.error}</h2>`);
        server.close();
        reject(new Error(tokenData.error));
        return;
      }

      console.log(`   ✅ Got access token (${tokenData.access_token.substring(0, 20)}...)`);

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2>✅ Auth complete!</h2><p>You can close this tab.</p>');
      server.close();
      resolve(tokenData);
    });

    server.listen(CALLBACK_PORT, () => {
      console.log(`   Callback server on http://localhost:${CALLBACK_PORT}`);
      console.log(`   Opening browser...\n`);
      try {
        execSync(`open "${authUrl.toString()}"`);
      } catch {
        console.log(`   ⚠️  Could not open browser. Open this URL manually:\n   ${authUrl.toString()}\n`);
      }
    });

    setTimeout(() => {
      server.close();
      reject(new Error('Timeout waiting for callback'));
    }, 120000);
  });

  const tokenData = await tokenPromise;
  const bearer = { Authorization: `Bearer ${tokenData.access_token}` };

  // Step 6a: REST read — hit /api/me/member-profile (requireAuth-gated read)
  console.log('\n6️⃣  Calling REST read (/api/me/member-profile) with bearer token...');
  const meRes = await fetch(`${BASE_URL}/api/me/member-profile`, { headers: bearer });
  console.log(`   Status: ${meRes.status}`);
  if (meRes.ok) {
    const me = await meRes.json();
    console.log(`   ✅ Read succeeded — user identified:`);
    console.log('   ' + JSON.stringify(me, null, 2).split('\n').join('\n   '));
  } else {
    const body = await meRes.text();
    console.log(`   ⚠️  Read returned non-200. Body: ${body.slice(0, 300)}`);
  }

  // Step 6b: REST write — save a test brand
  console.log('\n7️⃣  Calling REST write (POST /api/brands/save) with bearer token...');
  const testDomain = `rest-oauth-test-${Date.now()}.example`;
  const saveRes = await fetch(`${BASE_URL}/api/brands/save`, {
    method: 'POST',
    headers: { ...bearer, 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain: testDomain, brand_name: 'REST OAuth Test Brand' }),
  });
  console.log(`   Status: ${saveRes.status}`);
  const saveBody = await saveRes.text();
  console.log(`   Body: ${saveBody.slice(0, 400)}`);

  if (saveRes.ok) {
    console.log('\n✅ End-to-end SSO → REST write confirmed.\n');
  } else {
    console.log('\n❌ Write failed — investigate.\n');
    process.exit(1);
  }

  console.log(`Token (for manual testing):\n${tokenData.access_token}\n`);
}

main().catch((err) => {
  // Dev-only smoke script. The error path is reached only when the
  // developer runs this against their own local server, so the
  // user-controlled source is the developer themselves. JSON-encode
  // the message anyway — CodeQL expects a recognized sanitizer, not
  // a hand-rolled control-char regex.
  const safeMessage = JSON.stringify(String(err.message));
  console.error('\n❌ Error:', safeMessage);
  process.exit(1);
});
