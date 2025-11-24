# Local Testing Guide

## Quick Start (Docker)

### 1. Start PostgreSQL
```bash
# Start PostgreSQL in Docker
docker-compose up -d

# Check it's running
docker-compose ps
```

### 2. Configure Environment
```bash
# Copy the example env file
cp .env.local.example .env.local

# Source it (or add to your shell profile)
export $(cat .env.local | xargs)
```

### 3. Run Migrations
```bash
npm run db:migrate
```

Expected output:
```
Running database migrations...
Found 1 migrations
0 already applied
Applying 1 pending migrations...
✓ Applied migration: 001_initial.sql
✓ All migrations completed successfully
```

### 4. Seed Database
```bash
npm run db:seed
```

Expected output:
```
=== Seeding Registry Database ===

✓ Database connection initialized
✓ Migrations complete

Loading agents from JSON files...
✓ Loaded X agents

Starting transaction...

Inserting agents into database...
  ✓ Inserted Agent Name [creative/agent-slug]
  ...

✓ Transaction committed

=== Seed Complete ===
Inserted: X
Updated: 0
Skipped: 0
Total: X
```

### 5. Start Server
```bash
npm start
```

Look for this in the logs:
```
Initializing database-backed registry...
✓ Using database-backed registry
AdCP Registry HTTP server running on port 3000
```

### 6. Test It Works

**Check health endpoint:**
```bash
curl http://localhost:3000/health | jq
```

Should show:
```json
{
  "status": "ok",
  "registry": {
    "mode": "database",
    "using_database": true
  }
}
```

**List agents:**
```bash
curl http://localhost:3000/api/agents | jq '.agents | length'
```

Should show the count of agents.

---

## Testing Scenarios

### Scenario 1: Test Database Connection

**Verify database mode:**
```bash
curl http://localhost:3000/health | jq '.registry'
```

**Query agents directly from database:**
```bash
docker exec -it nagoya-v6-postgres-1 psql -U adcp -d adcp_registry -c "SELECT name, slug FROM registry_entries LIMIT 5;"
```

### Scenario 2: Test Fallback to File Mode

**Stop the database:**
```bash
docker-compose stop postgres
```

**Restart server:**
```bash
npm start
```

Expected logs:
```
Initializing database-backed registry...
Failed to initialize database registry (connection): ...
Falling back to file-based registry
✓ Using file-based registry
```

**Check health shows degraded mode:**
```bash
curl http://localhost:3000/health | jq '.registry'
```

Should show:
```json
{
  "mode": "file",
  "using_database": false,
  "degraded": true,
  "error": {
    "type": "connection",
    "message": "..."
  }
}
```

**Start database again:**
```bash
docker-compose start postgres
# Wait a few seconds for it to start
npm start
```

Should now use database mode again.

### Scenario 3: Test Seed Options

**Clean and reseed:**
```bash
npm run db:seed -- --clean
```

**Update existing entries:**
```bash
# Edit a JSON file in registry/
# Then update database:
npm run db:seed -- --force
```

### Scenario 4: Test Migration System

**Create a test migration:**
```bash
cat > server/src/db/migrations/002_test.sql << 'EOF'
-- Test migration
CREATE TABLE IF NOT EXISTS test_table (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255)
);
EOF
```

**Run migrations:**
```bash
npm run db:migrate
```

Should apply the new migration.

**Check migration status:**
```bash
docker exec -it nagoya-v6-postgres-1 psql -U adcp -d adcp_registry -c "SELECT * FROM schema_migrations;"
```

### Scenario 5: Test Graceful Shutdown

**Start server:**
```bash
npm start
```

**Send SIGTERM:**
```bash
# In another terminal:
pkill -TERM node
```

Should see in logs:
```
SIGTERM received, starting graceful shutdown...
Stopping HTTP server...
✓ HTTP server closed
Closing database connection...
✓ Database connection closed
Graceful shutdown complete
```

---

## Troubleshooting

### Database won't start
```bash
# Check logs
docker-compose logs postgres

# Reset everything
docker-compose down -v
docker-compose up -d
```

### Migrations fail
```bash
# Check current state
docker exec -it nagoya-v6-postgres-1 psql -U adcp -d adcp_registry -c "\dt"

# Reset schema_migrations if needed
docker exec -it nagoya-v6-postgres-1 psql -U adcp -d adcp_registry -c "DROP TABLE IF EXISTS schema_migrations CASCADE;"
```

### Seed fails
```bash
# Check TypeScript types
npm run typecheck

# Verify JSON files
find registry/ -name "*.json" -exec node -e "JSON.parse(require('fs').readFileSync('{}', 'utf-8'))" \;
```

### Port already in use
```bash
# Find what's using port 5432
lsof -ti:5432

# Use different port
# Edit docker-compose.yml: "5433:5432"
# Edit .env.local: DATABASE_URL=postgresql://adcp:localdev@localhost:5433/adcp_registry
```

---

## Running Tests

**Unit tests:**
```bash
npm test -- server/tests/unit/unified-registry.test.ts
npm test -- server/tests/unit/registry-db.test.ts
npm test -- server/tests/unit/migrate.test.ts
```

**Integration tests:**
```bash
npm test -- server/tests/integration/health.test.ts
```

**All tests:**
```bash
npm test
```

---

## Cleanup

```bash
# Stop services
docker-compose down

# Remove volumes (deletes all data)
docker-compose down -v

# Remove env file
rm .env.local
```

---

## Option 2: Using Local PostgreSQL

If you prefer using your local PostgreSQL installation:

```bash
# Create database
createdb adcp_registry

# Set environment variable
export DATABASE_URL=postgresql://$(whoami)@localhost:5432/adcp_registry

# Run migrations
npm run db:migrate

# Seed database
npm run db:seed

# Start server
npm start
```

---

## Comparison: File Mode vs Database Mode

**Test both modes side by side:**

```bash
# Terminal 1: Database mode
export $(cat .env.local | xargs)
npm start

# Terminal 2: File mode (in another shell)
unset DATABASE_URL
npm start

# Compare health endpoints
curl http://localhost:3000/health | jq '.registry.mode'  # Terminal 1: "database"
curl http://localhost:3000/health | jq '.registry.mode'  # Terminal 2: "file"
```

---

## Tips

1. **Always check logs** - Look for "Using database-backed registry" or "Using file-based registry"
2. **Health endpoint is your friend** - Use it to verify mode and check for degraded state
3. **Docker is easier** - Keeps your local PostgreSQL clean
4. **Test the fallback** - Make sure it works when database is unavailable
5. **Clean up between tests** - Use `npm run db:seed -- --clean` to reset data
