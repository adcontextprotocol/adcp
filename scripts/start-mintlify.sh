#!/bin/bash
# Start Mintlify with CONDUCTOR_PORT environment variable support
PORT=${CONDUCTOR_PORT:-3001}
NODE_ENV=production npx --yes mintlify@latest dev --port "$PORT"
