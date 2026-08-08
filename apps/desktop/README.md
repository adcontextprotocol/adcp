# Addie Desktop

A native desktop app for chatting with Addie, built with [Tauri](https://tauri.app).

## Features

- Native desktop experience (macOS, Windows, Linux)
- OAuth authentication via AgenticAdvertising.org
- Secure session storage in system keychain
- Streaming chat responses
- Dark mode support

## Prerequisites

- [Rust](https://rustup.rs/) (for building)
- [Node.js](https://nodejs.org/) 18+ (for Tauri CLI)

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev
```

## Building

```bash
# Build for production
npm run build
```

The built app will be in `src-tauri/target/release/bundle/`.

## Architecture

### Authentication Flow

1. User clicks "Sign In"
2. App persists random state and a PKCE verifier, then calls `POST /auth/native/start`
3. Server creates a second PKCE binding for WorkOS and returns its HTTPS authorization URL
4. App opens that URL in the system browser and the user authenticates via WorkOS
5. WorkOS returns to the server, which verifies its PKCE binding and issues a short-lived one-time grant
6. The browser opens `org.agenticadvertising.addie:/auth/callback` with only the grant and state
7. The app verifies state and redeems the grant over HTTPS with its own PKCE verifier
8. The app stores the server-returned sealed session in the system keychain
9. App API requests use the sealed session

### Secure Storage

Sessions are stored in the system keychain:
- **macOS**: Keychain Access
- **Windows**: Credential Manager
- **Linux**: Secret Service (GNOME Keyring, KWallet)

### API Communication

The app communicates with `agenticadvertising.org`:
- `POST /api/addie/chat/stream` - Streaming chat (SSE)
- `POST /auth/native/start` - Start a state- and PKCE-bound native login
- `POST /auth/native/token` - Redeem the one-time grant

## Configuration

Set `ADDIE_API_URL` environment variable to use a different server:

```bash
ADDIE_API_URL=http://localhost:3000 npm run dev
```

## Icons

Replace the placeholder icons in `src-tauri/icons/` with your app icons:
- `32x32.png`
- `128x128.png`
- `128x128@2x.png`
- `icon.icns` (macOS)
- `icon.ico` (Windows)

## Desktop callback

The desktop bundle registers this private-use callback URI:

```
org.agenticadvertising.addie:/auth/callback
```

WorkOS continues to redirect to the server's HTTPS `/auth/callback`; the server
then returns a one-time PKCE-bound grant through this URI. No bearer session or
user identity is placed in the deep link.
