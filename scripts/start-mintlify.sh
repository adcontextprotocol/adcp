#!/bin/bash
# Start Mintlify with CONDUCTOR_PORT environment variable support
# CONDUCTOR_PORT is the HTTP server port, Mintlify runs on port + 1
HTTP_PORT=${CONDUCTOR_PORT:-3000}
PORT=$((HTTP_PORT + 1))

# Workaround: Local node_modules contains MDX/frontmatter packages that conflict
# with Mintlify's internal dependencies. Clear NODE_PATH to prevent Node from
# resolving modules from local node_modules when Mintlify runs.
NODE_PATH="" NODE_ENV=production npx --yes mintlify@latest dev --port "$PORT"
