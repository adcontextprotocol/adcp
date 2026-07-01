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
ARG SKIP_PRECLONE_REPOS=false

RUN if [ "$SKIP_PRECLONE_REPOS" = "true" ]; then \
      echo "Skipping git install for local repo-cache build"; \
    else \
      apk add --no-cache git \
      && git config --global http.version HTTP/1.1; \
    fi

WORKDIR /repos

# Copy package.json to bust Docker layer cache on every deploy.
# Without this, the clone script layer is cached indefinitely because its
# content never changes, causing search_repos to serve stale repo content.
COPY package.json /tmp/_cachebust
RUN rm /tmp/_cachebust

COPY <<'CLONE' /repos/clone.sh
#!/bin/sh
set -e
clone_repo() {
  branch="$1"
  url="$2"
  dir="$3"
  attempt=1
  while [ "$attempt" -le 3 ]; do
    rm -rf "$dir"
    if git clone --depth=1 --branch "$branch" "$url" "$dir"; then
      return 0
    fi
    echo "Clone failed for $dir (attempt $attempt/3), retrying..." >&2
    attempt=$((attempt + 1))
    sleep 2
  done
  echo "ERROR: clone failed for $dir after 3 attempts" >&2
  return 1
}
fail=0
pids=""
batch_count=0
wait_batch() {
  for pid in $pids; do wait "$pid" || fail=1; done
  pids=""
  batch_count=0
}
run_clone() {
  clone_repo "$1" "$2" "$3" &
  pids="$pids $!"
  batch_count=$((batch_count + 1))
  if [ "$batch_count" -ge 4 ]; then
    wait_batch
  fi
}
run_clone main https://github.com/adcontextprotocol/adcp.git adcp
run_clone main https://github.com/prebid/salesagent.git salesagent
run_clone main https://github.com/adcontextprotocol/signals-agent.git signals-agent
run_clone main https://github.com/adcontextprotocol/adcp-client.git adcp-client
run_clone main https://github.com/adcontextprotocol/adcp-client-python.git adcp-client-python
run_clone main https://github.com/adcontextprotocol/adcp-go.git adcp-go
run_clone main https://github.com/a2aproject/A2A.git a2a
run_clone main https://github.com/a2aproject/a2a-samples.git a2a-samples
run_clone main https://github.com/modelcontextprotocol/modelcontextprotocol.git mcp-spec
run_clone main https://github.com/modelcontextprotocol/typescript-sdk.git mcp-typescript-sdk
run_clone main https://github.com/modelcontextprotocol/python-sdk.git mcp-python-sdk
run_clone main https://github.com/modelcontextprotocol/servers.git mcp-servers
run_clone main https://github.com/IABTechLab/agentic-rtb-framework.git iab-artf
run_clone main https://github.com/IABTechLab/user-context-protocol.git iab-ucp
run_clone main https://github.com/InteractiveAdvertisingBureau/openrtb2.x.git iab-openrtb2
run_clone main https://github.com/InteractiveAdvertisingBureau/openrtb.git iab-openrtb3
run_clone main https://github.com/InteractiveAdvertisingBureau/AdCOM.git iab-adcom
run_clone main https://github.com/InteractiveAdvertisingBureau/OpenDirect.git iab-opendirect
run_clone main https://github.com/InteractiveAdvertisingBureau/Global-Privacy-Platform.git iab-gpp
run_clone master https://github.com/InteractiveAdvertisingBureau/GDPR-Transparency-and-Consent-Framework.git iab-tcf
run_clone master https://github.com/InteractiveAdvertisingBureau/USPrivacy.git iab-usprivacy
run_clone main https://github.com/IABTechLab/uid2docs.git iab-uid2-docs
run_clone master https://github.com/InteractiveAdvertisingBureau/vast.git iab-vast
run_clone main https://github.com/IABTechLab/adscert.git iab-adscert
run_clone master https://github.com/prebid/Prebid.js.git prebid-js
run_clone master https://github.com/prebid/prebid-server.git prebid-server
run_clone master https://github.com/prebid/prebid.github.io.git prebid-docs
run_clone main https://github.com/langchain-ai/langgraph.git langgraph
wait_batch
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
# Only markdown/MDX files are indexed by search_repos at runtime. Keep this
# in sync with EXTERNAL_REPOS indexPatterns if non-markdown sources are added.
find /repos -type f ! \( -name "*.md" -o -name "*.mdx" \) -delete
find /repos -type d -empty -delete
CLONE

# hadolint ignore=DL3003
RUN if [ "$SKIP_PRECLONE_REPOS" = "true" ]; then \
      echo "Skipping external repo preclone for local build"; \
      rm /repos/clone.sh; \
    else \
      sh /repos/clone.sh; \
    fi

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
RUN npm ci --omit=dev --ignore-scripts \
 && npm rebuild sharp \
 && npm cache clean --force

# Copy built files from builder. Runtime assets under server/src/** (JSON
# format catalogs, SQL migrations, Addie rule markdown, etc.) are mirrored
# into dist/ by scripts/copy-server-assets.cjs during `npm run build`, so
# `COPY ... /dist` is sufficient — no per-directory asset lines needed here.
# Adding an asset to server/src/** is a one-place change.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server/public ./server/public
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
# Repos are pre-cloned in the image and stripped of .git metadata above.
# The runtime image does not install git, so disabling this without adding git
# will make external repo indexing fall back to the baked cache or skip sync.
ENV SKIP_REPO_SYNC=true

# Expose port
EXPOSE 8080

# Start the server
CMD ["node", "dist/index.js"]
