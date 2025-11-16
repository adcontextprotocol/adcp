#!/bin/bash
# Start Mintlify with CONDUCTOR_PORT environment variable support
# CONDUCTOR_PORT is the HTTP server port, Mintlify runs on port + 1
HTTP_PORT=${CONDUCTOR_PORT:-3000}
PORT=$((HTTP_PORT + 1))

# Start Mintlify - docs.json uses production URLs for topbar
NODE_ENV=production npx --yes mintlify@latest dev --port "$PORT"
