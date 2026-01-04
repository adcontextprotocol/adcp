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
2. App opens system browser to `agenticadvertising.org/auth/login`
3. User authenticates via WorkOS
4. WorkOS redirects to `/auth/native-callback?code=xxx`
5. Server exchanges code for sealed session, returns JSON
6. App receives response, stores sealed session in system keychain
7. App sends `Authorization: Bearer <sealed_session>` on API requests

### Secure Storage

Sessions are stored in the system keychain:
- **macOS**: Keychain Access
- **Windows**: Credential Manager
- **Linux**: Secret Service (GNOME Keyring, KWallet)

### API Communication

The app communicates with `agenticadvertising.org`:
- `POST /api/addie/chat/stream` - Streaming chat (SSE)
- `GET /auth/native-callback` - OAuth callback for native apps

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

## WorkOS Configuration

To enable the deep link OAuth flow, add this redirect URI in your WorkOS dashboard:

```
addie://auth/callback
```

Note: This is a custom protocol that the Tauri app registers to handle.
