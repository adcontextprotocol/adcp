# Use Node.js 20 Alpine for building
FROM node:20-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including dev dependencies for TypeScript build)
RUN npm ci --ignore-scripts

# Copy source code
COPY . .

# Build the TypeScript server (increase heap for large tsc compilation)
RUN NODE_OPTIONS=--max-old-space-size=4096 npm run build

# Pre-clone external repos in parallel, then strip .git metadata.
# Only markdown files are indexed at runtime so .git dirs are dead weight.
# IMPORTANT: Keep in sync with EXTERNAL_REPOS in server/src/addie/mcp/external-repos.ts
FROM alpine:3.19 AS repos

RUN apk add --no-cache git

WORKDIR /repos

COPY <<'CLONE' /repos/clone.sh
#!/bin/sh
set -e
pids=""
git clone --depth=1 --branch main https://github.com/adcontextprotocol/adcp.git adcp & pids="$pids $!"
git clone --depth=1 --branch main https://github.com/prebid/salesagent.git salesagent & pids="$pids $!"
git clone --depth=1 --branch main https://github.com/adcontextprotocol/signals-agent.git signals-agent & pids="$pids $!"
git clone --depth=1 --branch main https://github.com/adcontextprotocol/adcp-client.git adcp-client & pids="$pids $!"
git clone --depth=1 --branch main https://github.com/adcontextprotocol/adcp-client-python.git adcp-client-python & pids="$pids $!"
git clone --depth=1 --branch main https://github.com/a2aproject/A2A.git a2a & pids="$pids $!"
git clone --depth=1 --branch main https://github.com/a2aproject/a2a-samples.git a2a-samples & pids="$pids $!"
git clone --depth=1 --branch main https://github.com/modelcontextprotocol/modelcontextprotocol.git mcp-spec & pids="$pids $!"
git clone --depth=1 --branch main https://github.com/modelcontextprotocol/typescript-sdk.git mcp-typescript-sdk & pids="$pids $!"
git clone --depth=1 --branch main https://github.com/modelcontextprotocol/python-sdk.git mcp-python-sdk & pids="$pids $!"
git clone --depth=1 --branch main https://github.com/modelcontextprotocol/servers.git mcp-servers & pids="$pids $!"
git clone --depth=1 --branch main https://github.com/IABTechLab/agentic-rtb-framework.git iab-artf & pids="$pids $!"
git clone --depth=1 --branch main https://github.com/IABTechLab/user-context-protocol.git iab-ucp & pids="$pids $!"
git clone --depth=1 --branch main https://github.com/InteractiveAdvertisingBureau/openrtb2.x.git iab-openrtb2 & pids="$pids $!"
git clone --depth=1 --branch main https://github.com/InteractiveAdvertisingBureau/openrtb.git iab-openrtb3 & pids="$pids $!"
git clone --depth=1 --branch main https://github.com/InteractiveAdvertisingBureau/AdCOM.git iab-adcom & pids="$pids $!"
git clone --depth=1 --branch main https://github.com/InteractiveAdvertisingBureau/OpenDirect.git iab-opendirect & pids="$pids $!"
git clone --depth=1 --branch main https://github.com/InteractiveAdvertisingBureau/Global-Privacy-Platform.git iab-gpp & pids="$pids $!"
git clone --depth=1 --branch master https://github.com/InteractiveAdvertisingBureau/GDPR-Transparency-and-Consent-Framework.git iab-tcf & pids="$pids $!"
git clone --depth=1 --branch master https://github.com/InteractiveAdvertisingBureau/USPrivacy.git iab-usprivacy & pids="$pids $!"
git clone --depth=1 --branch main https://github.com/IABTechLab/uid2docs.git iab-uid2-docs & pids="$pids $!"
git clone --depth=1 --branch master https://github.com/InteractiveAdvertisingBureau/vast.git iab-vast & pids="$pids $!"
git clone --depth=1 --branch main https://github.com/IABTechLab/adscert.git iab-adscert & pids="$pids $!"
git clone --depth=1 --branch master https://github.com/prebid/Prebid.js.git prebid-js & pids="$pids $!"
git clone --depth=1 --branch master https://github.com/prebid/prebid-server.git prebid-server & pids="$pids $!"
git clone --depth=1 --branch master https://github.com/prebid/prebid.github.io.git prebid-docs & pids="$pids $!"
git clone --depth=1 --branch main https://github.com/langchain-ai/langgraph.git langgraph & pids="$pids $!"
fail=0
for pid in $pids; do wait "$pid" || fail=1; done
if [ "$fail" -eq 1 ]; then
  echo "ERROR: one or more clones failed" >&2
  exit 1
fi
find /repos -name ".git" -type d -exec rm -rf {} +
# Verify no .git dirs survived
remaining=$(find /repos -name ".git" -type d | wc -l)
if [ "$remaining" -gt 0 ]; then
  echo "ERROR: $remaining .git dirs remain after stripping" >&2
  exit 1
fi
rm /repos/clone.sh
CLONE

# hadolint ignore=DL3003
RUN sh /repos/clone.sh

# Production stage
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev --ignore-scripts

# Copy built files from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server/public ./server/public
COPY --from=builder /app/server/src/db/migrations ./dist/db/migrations
COPY --from=builder /app/server/src/creative-agent/reference-formats.json ./dist/creative-agent/
COPY --from=builder /app/static ./static
COPY --from=builder /app/docs ./docs

# Copy pre-cloned repos (warm cache for Addie)
COPY --from=repos /repos ./.addie-repos

# Set environment variables
ENV NODE_ENV=production
ENV PORT=8080

# Expose port
EXPOSE 8080

# Start the server
CMD ["node", "dist/index.js"]
