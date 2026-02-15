#!/usr/bin/env node
/**
 * MCP OAuth test script
 *
 * Performs the full OAuth 2.1 flow against the local MCP server:
 * 1. Discovers PRM metadata
 * 2. Discovers AS metadata
 * 3. Registers a dynamic client (RFC 7591)
 * 4. Opens browser for authorization
 * 5. Captures the callback, exchanges code for token
 * 6. Calls MCP tools/list with the token
 *
 * Usage: node scripts/mcp-auth-test.mjs [port]
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const MCP_PORT = process.argv[2] || '55110';
const BASE_URL = `http://localhost:${MCP_PORT}`;
const CALLBACK_PORT = 8789;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function main() {
  console.log(`\n🔑 MCP OAuth Test — ${BASE_URL}/mcp\n`);

  // Step 1: Discover PRM
  console.log('1️⃣  Fetching Protected Resource Metadata...');
  const prmRes = await fetch(`${BASE_URL}/.well-known/oauth-protected-resource`);
  const prm = await prmRes.json();
  console.log(`   Resource: ${prm.resource}`);
  console.log(`   Auth server: ${prm.authorization_servers[0]}`);

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
      client_name: 'MCP Auth Test Script',
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
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<h2>❌ Auth Error: ${error}</h2><p>${url.searchParams.get('error_description')}</p>`);
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

      // Exchange code for token
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

    // Timeout after 2 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('Timeout waiting for callback'));
    }, 120000);
  });

  const tokenData = await tokenPromise;

  // Step 6: Call MCP with the token
  console.log('\n6️⃣  Calling MCP tools/list with bearer token...');
  const mcpRes = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${tokenData.access_token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const mcpText = await mcpRes.text();
  // Parse SSE response
  const dataLine = mcpText.split('\n').find(l => l.startsWith('data: '));
  const mcpResult = dataLine ? JSON.parse(dataLine.replace('data: ', '')) : JSON.parse(mcpText);
  const tools = mcpResult.result?.tools || [];
  console.log(`   ✅ Got ${tools.length} tools:`);
  tools.forEach(t => console.log(`      - ${t.name}`));

  // Step 7: Try save_brand with auth
  console.log('\n7️⃣  Testing save_brand (authenticated)...');
  const saveRes = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${tokenData.access_token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'save_brand', arguments: { domain: 'mcp-test-brand.com', brand_name: 'MCP Test Brand' } },
    }),
  });
  const saveText = await saveRes.text();
  const saveLine = saveText.split('\n').find(l => l.startsWith('data: '));
  const saveResult = saveLine ? JSON.parse(saveLine.replace('data: ', '')) : JSON.parse(saveText);
  const content = saveResult.result?.content?.[0];
  if (content?.resource?.text) {
    console.log(`   Result: ${content.resource.text}`);
  } else if (content?.text) {
    console.log(`   Result: ${content.text}`);
  }

  console.log('\n✅ Done!\n');
  console.log(`Token (for manual testing):\n${tokenData.access_token}\n`);
}

main().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
