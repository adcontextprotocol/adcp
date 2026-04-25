FROM node:22-bookworm-slim@sha256:f3a68cf41a855d227d1b0ab832bed9749469ef38cf4f58182fb8c893bc462383 AS builder

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

# Copy package.json to bust Docker layer cache on every deploy.
# Without this, the clone script layer is cached indefinitely because its
# content never changes, causing search_repos to serve stale repo content.
COPY package.json /tmp/_cachebust
RUN rm /tmp/_cachebust

COPY <<'CLONE' /repos/clone.sh
#!/bin/sh
set -e
pids=""
git clone --depth=1 --branch main https://github.com/adcontextprotocol/adcp.git adcp & pids="$pids $!"
git clone --depth=1 --branch main https://github.com/prebid/salesagent.git salesagent & pids="$pids $!"
git clone --depth=1 --branch main https://github.com/adcontextprotocol/signals-agent.git signals-agent & pids="$pids $!"
git clone --depth=1 --branch main https://github.com/adcontextprotocol/adcp-client.git adcp-client & pids="$pids $!"
git clone --depth=1 --branch main https://github.com/adcontextprotocol/adcp-client-python.git adcp-client-python & pids="$pids $!"
git clone --depth=1 --branch main https://github.com/adcontextprotocol/adcp-go.git adcp-go & pids="$pids $!"
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
FROM node:22-bookworm-slim@sha256:f3a68cf41a855d227d1b0ab832bed9749469ef38cf4f58182fb8c893bc462383

WORKDIR /app

# unzip is used by the Tranco ingestion path at runtime. Alpine bundled it via
# busybox; Debian slim does not. ca-certificates is present in the base image
# but reinstalled here as belt-and-suspenders for TLS trust.
RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

# --ignore-scripts blocks arbitrary postinstall lifecycle scripts from the full
# dep tree; native deps are rebuilt explicitly per-package.
RUN npm ci --omit=dev --ignore-scripts && npm rebuild sharp

# Copy built files from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server/public ./server/public
COPY --from=builder /app/server/src/db/migrations ./dist/db/migrations
COPY --from=builder /app/server/src/creative-agent/reference-formats.json ./dist/creative-agent/
COPY --from=builder /app/server/src/addie/rules/*.md ./dist/addie/rules/
COPY --from=builder /app/static ./static
COPY --from=builder /app/docs ./docs

# Skill docs read at runtime by Addie's ask_about_adcp_task / call_adcp_task loader.
COPY --from=builder /app/skills ./skills

# Shared agent-infrastructure read at Addie prompt-assembly time (rules/index.ts)
# and by the triage routines. These are committed repo files; without them,
# loadRules() silently degrades.
COPY --from=builder /app/.agents ./.agents
COPY --from=builder /app/.claude/agents ./.claude/agents

# Copy pre-cloned repos (warm cache for Addie)
COPY --from=repos /repos ./.addie-repos

# Set environment variables
ENV NODE_ENV=production
ENV PORT=8080
ENV TZ=UTC

# Expose port
EXPOSE 8080

# Start the server
CMD ["node", "dist/index.js"]
