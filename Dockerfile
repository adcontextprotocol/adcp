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

# Build the TypeScript server
RUN npm run build

# Pre-clone external repos stage (runs in parallel conceptually, deps only on git)
FROM alpine:3.19 AS repos

RUN apk add --no-cache git

WORKDIR /repos

# Pre-clone all external repos for Addie's knowledge base
# These are shallow clones to minimize image size
# Runtime will pull for updates, but has warm cache
# IMPORTANT: Keep in sync with EXTERNAL_REPOS in server/src/addie/mcp/external-repos.ts

# AdCP Ecosystem (CORE)
RUN git clone --depth=1 --branch main https://github.com/adcontextprotocol/adcp.git adcp || true
RUN git clone --depth=1 --branch main https://github.com/adcontextprotocol/salesagent.git salesagent || true
RUN git clone --depth=1 --branch main https://github.com/adcontextprotocol/signals-agent.git signals-agent || true
RUN git clone --depth=1 --branch main https://github.com/adcontextprotocol/adcp-client.git adcp-client || true
RUN git clone --depth=1 --branch main https://github.com/adcontextprotocol/adcp-client-python.git adcp-client-python || true

# Agent Protocols - A2A
RUN git clone --depth=1 --branch main https://github.com/a2aproject/A2A.git a2a || true
RUN git clone --depth=1 --branch main https://github.com/a2aproject/a2a-samples.git a2a-samples || true

# Agent Protocols - MCP
RUN git clone --depth=1 --branch main https://github.com/modelcontextprotocol/modelcontextprotocol.git mcp-spec || true
RUN git clone --depth=1 --branch main https://github.com/modelcontextprotocol/typescript-sdk.git mcp-typescript-sdk || true
RUN git clone --depth=1 --branch main https://github.com/modelcontextprotocol/python-sdk.git mcp-python-sdk || true
RUN git clone --depth=1 --branch main https://github.com/modelcontextprotocol/servers.git mcp-servers || true

# IAB Tech Lab - Agentic Advertising
RUN git clone --depth=1 --branch main https://github.com/IABTechLab/agentic-rtb-framework.git iab-artf || true
RUN git clone --depth=1 --branch main https://github.com/IABTechLab/user-context-protocol.git iab-ucp || true

# IAB Tech Lab - OpenMedia Stack
RUN git clone --depth=1 --branch main https://github.com/InteractiveAdvertisingBureau/openrtb2.x.git iab-openrtb2 || true
RUN git clone --depth=1 --branch main https://github.com/InteractiveAdvertisingBureau/openrtb.git iab-openrtb3 || true
RUN git clone --depth=1 --branch main https://github.com/InteractiveAdvertisingBureau/AdCOM.git iab-adcom || true
RUN git clone --depth=1 --branch main https://github.com/InteractiveAdvertisingBureau/OpenDirect.git iab-opendirect || true

# IAB Tech Lab - Privacy & Consent
RUN git clone --depth=1 --branch main https://github.com/InteractiveAdvertisingBureau/Global-Privacy-Platform.git iab-gpp || true
RUN git clone --depth=1 --branch master https://github.com/InteractiveAdvertisingBureau/GDPR-Transparency-and-Consent-Framework.git iab-tcf || true
RUN git clone --depth=1 --branch master https://github.com/InteractiveAdvertisingBureau/USPrivacy.git iab-usprivacy || true

# IAB Tech Lab - Identity
RUN git clone --depth=1 --branch main https://github.com/IABTechLab/uid2docs.git iab-uid2-docs || true

# IAB Tech Lab - Video & Security
RUN git clone --depth=1 --branch master https://github.com/InteractiveAdvertisingBureau/vast.git iab-vast || true
RUN git clone --depth=1 --branch main https://github.com/IABTechLab/adscert.git iab-adscert || true

# Prebid Ecosystem
RUN git clone --depth=1 --branch master https://github.com/prebid/Prebid.js.git prebid-js || true
RUN git clone --depth=1 --branch master https://github.com/prebid/prebid-server.git prebid-server || true
RUN git clone --depth=1 --branch master https://github.com/prebid/prebid.github.io.git prebid-docs || true

# Agent Frameworks
RUN git clone --depth=1 --branch main https://github.com/langchain-ai/langgraph.git langgraph || true

# Production stage
FROM node:20-alpine

# Install git for external repo updates at runtime
RUN apk add --no-cache git

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
