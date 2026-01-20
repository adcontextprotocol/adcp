#!/bin/bash
# Test tool sets routing via the admin API
#
# Usage:
#   ./scripts/test-tool-sets-curl.sh [LOCAL_PORT]
#
# Requires the server to be running locally with docker compose up

PORT=${1:-3000}
BASE_URL="http://localhost:$PORT"

# Test messages for different tool sets
declare -A TEST_CASES=(
  ["knowledge"]="What is AdCP and how does it work?"
  ["agent_testing"]="Can you validate my adagents.json at https://example.com/.well-known/adagents.json?"
  ["directory"]="I'm looking for a DSP that supports AdCP. Can you help me find vendors?"
  ["member"]="I want to join the working group on signals"
  ["adcp_operations"]="Can you help me create a media buy with The Trade Desk?"
  ["billing"]="Can you send an invoice to acme@example.com for their annual membership?"
  ["meetings"]="I need to schedule a meeting with the protocol committee"
  ["content"]="Can you draft a GitHub issue for the missing creative validation?"
  ["multi_intent"]="I need to update my profile and also look for measurement partners"
)

echo "========================================"
echo "Tool Sets Router Test"
echo "========================================"
echo "Base URL: $BASE_URL"
echo ""

for expected_set in "${!TEST_CASES[@]}"; do
  message="${TEST_CASES[$expected_set]}"
  echo "Testing: $expected_set"
  echo "  Message: \"$message\""

  # Call the test-router endpoint (using dev login cookie if available)
  response=$(curl -s -X POST "$BASE_URL/api/admin/addie/test-router" \
    -H "Content-Type: application/json" \
    -H "Cookie: dev_user=admin@test.com" \
    -d "{\"message\": \"$message\", \"source\": \"channel\"}" 2>/dev/null)

  if [ -z "$response" ]; then
    echo "  ERROR: No response from server"
  else
    # Extract tool_sets from response
    tool_sets=$(echo "$response" | jq -r '.router_decision.tool_sets // .router_decision.tools // "[]"' 2>/dev/null)
    reason=$(echo "$response" | jq -r '.router_decision.reason // "N/A"' 2>/dev/null)
    latency=$(echo "$response" | jq -r '.router_decision.latency_ms // "N/A"' 2>/dev/null)

    echo "  Tool sets: $tool_sets"
    echo "  Reason: $reason"
    echo "  Latency: ${latency}ms"
  fi
  echo ""
done

echo "========================================"
echo "Done"
echo "========================================"
