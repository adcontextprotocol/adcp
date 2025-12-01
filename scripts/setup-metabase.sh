#!/bin/bash
set -e

# Metabase setup script with JWT configuration
# This script automates the initial Metabase setup and enables embedding

METABASE_URL="http://localhost:3001"
SETUP_TOKEN=$(curl -s "$METABASE_URL/api/session/properties" | jq -r '.["setup-token"]')

if [ "$SETUP_TOKEN" = "null" ] || [ -z "$SETUP_TOKEN" ]; then
  echo "Metabase is already set up"
  exit 0
fi

echo "Setting up Metabase..."

# Generate a secure JWT secret
JWT_SECRET=$(openssl rand -base64 32)

# Create admin user and complete setup
SETUP_RESPONSE=$(curl -s -X POST "$METABASE_URL/api/setup" \
  -H "Content-Type: application/json" \
  -d "{
    \"token\": \"$SETUP_TOKEN\",
    \"user\": {
      \"first_name\": \"Admin\",
      \"last_name\": \"User\",
      \"email\": \"admin@adcp.local\",
      \"password\": \"$(openssl rand -base64 16)\",
      \"site_name\": \"AdCP Analytics\"
    },
    \"prefs\": {
      \"site_name\": \"AdCP Analytics\",
      \"allow_tracking\": false
    }
  }")

# Extract session ID from setup response
SESSION_ID=$(echo "$SETUP_RESPONSE" | jq -r '.id')

if [ -z "$SESSION_ID" ] || [ "$SESSION_ID" = "null" ]; then
  echo "Setup failed. Response:"
  echo "$SETUP_RESPONSE"
  exit 1
fi

echo "✓ Admin user created"
echo "✓ Session ID: $SESSION_ID"

# Enable embedding and set JWT secret
curl -s -X PUT "$METABASE_URL/api/setting/enable-embedding" \
  -H "X-Metabase-Session: $SESSION_ID" \
  -H "Content-Type: application/json" \
  -d '{"value": true}' > /dev/null

curl -s -X PUT "$METABASE_URL/api/setting/embedding-secret-key" \
  -H "X-Metabase-Session: $SESSION_ID" \
  -H "Content-Type: application/json" \
  -d "{\"value\": \"$JWT_SECRET\"}" > /dev/null

echo "✓ Embedding enabled"
echo ""
echo "==================================================================="
echo "Metabase Setup Complete!"
echo "==================================================================="
echo ""
echo "Add this to your .env.local file:"
echo ""
echo "METABASE_SITE_URL=http://localhost:3001"
echo "METABASE_SECRET_KEY=$JWT_SECRET"
echo ""
echo "Admin credentials (save these!):"
echo "Email: admin@adcp.local"
echo "Password: (generated randomly - use password reset if needed)"
echo ""
echo "Next steps:"
echo "1. Add the environment variables above to .env.local"
echo "2. Restart your dev server"
echo "3. Connect Metabase to your PostgreSQL database"
echo "==================================================================="
