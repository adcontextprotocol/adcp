#!/usr/bin/env npx tsx
/**
 * One-time OAuth setup script for Addie's Google account
 *
 * Usage:
 *   GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy npx tsx scripts/google-oauth-setup.ts
 *
 * This will:
 * 1. Open a browser for you to sign in as Addie
 * 2. Print out the refresh token to add to your environment
 */

import http from 'http';
import open from 'open';
import { URL } from 'url';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_PORT = 9876;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/documents.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing required environment variables:');
  console.error('  GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy npx tsx scripts/google-oauth-setup.ts');
  process.exit(1);
}

async function exchangeCodeForTokens(code: string): Promise<{ refresh_token: string; access_token: string }> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID!,
      client_secret: CLIENT_SECRET!,
      code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${error}`);
  }

  return response.json();
}

async function main() {
  console.log('\n🔐 Google OAuth Setup for Addie\n');

  // Build the authorization URL
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', CLIENT_ID!);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPES.join(' '));
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent'); // Force refresh token generation

  // Start local server to receive the callback
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, `http://localhost:${REDIRECT_PORT}`);

    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<h1>Error: ${error}</h1><p>Please try again.</p>`);
        console.error(`\n❌ OAuth error: ${error}`);
        process.exit(1);
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>✅ Success!</h1><p>You can close this window and return to the terminal.</p>');

        try {
          const tokens = await exchangeCodeForTokens(code);

          console.log('\n✅ OAuth successful!\n');
          console.log('Add these to your environment variables:\n');
          console.log('─'.repeat(60));
          console.log(`GOOGLE_CLIENT_ID=${CLIENT_ID}`);
          console.log(`GOOGLE_CLIENT_SECRET=${CLIENT_SECRET}`);
          console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
          console.log('─'.repeat(60));
          console.log('\nFor Fly.io, run:');
          console.log(`  fly secrets set GOOGLE_CLIENT_ID="${CLIENT_ID}" GOOGLE_CLIENT_SECRET="${CLIENT_SECRET}" GOOGLE_REFRESH_TOKEN="${tokens.refresh_token}"`);
          console.log('\n');

          server.close();
          process.exit(0);
        } catch (err) {
          console.error('\n❌ Failed to exchange code for tokens:', err);
          process.exit(1);
        }
      }
    }
  });

  server.listen(REDIRECT_PORT, () => {
    console.log(`Starting local server on port ${REDIRECT_PORT}...`);
    console.log('\nOpening browser for Google sign-in...');
    console.log('(Sign in as Addie\'s Google account)\n');

    // Open the browser
    open(authUrl.toString());
  });
}

main();
