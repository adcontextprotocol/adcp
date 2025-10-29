#!/bin/bash
# Start Docusaurus with CONDUCTOR_PORT environment variable support
PORT=${CONDUCTOR_PORT:-3000}
docusaurus start --port "$PORT" "$@"
