# Database-Backed Registry Setup

This document describes the database-backed registry system for the AdCP partner onboarding framework.

## Overview

The registry system supports two modes:
- **File-based**: Reads agent data from JSON files in `registry/` directory (default)
- **Database-backed**: Stores agent data in PostgreSQL database with automatic fallback to file mode

## Environment Variables

### Required for Database Mode

```bash
# Primary database URL
DATABASE_URL=postgresql://user:password@host:5432/database

# Alternative (Vercel Postgres)
DATABASE_PRIVATE_URL=postgresql://user:password@host:5432/database
```

### Optional Database Configuration

```bash
# SSL Configuration
DATABASE_SSL=true                        # Enable SSL (default: false)
DATABASE_SSL_REJECT_UNAUTHORIZED=true   # Verify SSL certificates (default: true when SSL enabled)

# Connection Pool Settings
DATABASE_MAX_POOL_SIZE=20               # Maximum connections (default: 20)
DATABASE_IDLE_TIMEOUT_MS=30000          # Idle timeout in ms (default: 30000)
DATABASE_CONNECTION_TIMEOUT_MS=5000     # Connection timeout in ms (default: 5000)
```

## SSL Configuration

⚠️ **Security Notice**: Always verify SSL certificates in production.

```bash
# Production (secure)
DATABASE_SSL=true
DATABASE_SSL_REJECT_UNAUTHORIZED=true

# Development with self-signed certs
DATABASE_SSL=true
DATABASE_SSL_REJECT_UNAUTHORIZED=false
```

## Setup Instructions

### 1. Create Database

```sql
CREATE DATABASE adcp_registry;
```

### 2. Run Migrations

```bash
npm run db:migrate
```

This creates the `registry_entries` table and related indexes.

### 3. Seed Database (Optional)

Seed the database with agents from JSON files:

```bash
# Safe mode - skip existing entries
npm run db:seed

# Force mode - update existing entries
npm run db:seed -- --force

# Clean mode - delete all agents and reseed
npm run db:seed -- --clean
```

### 4. Start Server

```bash
npm start
```

The server will automatically:
- Attempt to connect to database if `DATABASE_URL` is set
- Fall back to file mode if database connection fails
- Log the active registry mode

## Database Schema

### registry_entries

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `entry_type` | VARCHAR | Type: agent, partner, product, format |
| `name` | VARCHAR | Display name |
| `slug` | VARCHAR | Unique identifier (e.g., "creative/agent-name") |
| `url` | TEXT | Agent endpoint URL |
| `card_manifest_url` | TEXT | Card presentation URL (optional) |
| `card_format_id` | JSONB | Card format identifier (optional) |
| `metadata` | JSONB | Structured metadata |
| `tags` | TEXT[] | Searchable tags |
| `contact_name` | VARCHAR | Contact person name |
| `contact_email` | VARCHAR | Contact email |
| `contact_website` | TEXT | Contact website |
| `approval_status` | VARCHAR | Status: pending, approved, rejected |
| `approved_by` | VARCHAR | Approver identifier |
| `approved_at` | TIMESTAMP | Approval timestamp |
| `created_at` | TIMESTAMP | Creation timestamp |
| `updated_at` | TIMESTAMP | Last update timestamp |
| `active` | BOOLEAN | Active flag |

### Indexes

- `idx_registry_entry_type` - Fast filtering by type
- `idx_registry_active` - Active/inactive filtering
- `idx_registry_approval_status` - Approval status filtering
- `idx_registry_tags` - GIN index for tag searches
- `idx_registry_metadata` - GIN index for metadata searches
- `idx_registry_created_at` - Chronological ordering

## Health Check

The `/health` endpoint reports registry status:

```json
{
  "status": "ok",
  "registry": {
    "mode": "database",
    "using_database": true
  }
}
```

In degraded mode (fallback to file):

```json
{
  "status": "ok",
  "registry": {
    "mode": "file",
    "using_database": false,
    "degraded": true,
    "error": {
      "type": "connection",
      "message": "Connection refused"
    }
  }
}
```

## Migration System

### Creating New Migrations

1. Create file: `server/src/db/migrations/NNN_description.sql`
2. Format: `001_initial.sql`, `002_add_indexes.sql`
3. Version number must be sequential
4. Write idempotent SQL (use `IF NOT EXISTS`)

Example migration:

```sql
-- 002_add_audit_log.sql
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action VARCHAR(50) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_created_at
ON audit_log(created_at DESC);
```

### Migration Best Practices

- ✅ Use transactions (automatic)
- ✅ Write idempotent migrations
- ✅ Test rollback scenarios
- ✅ Keep migrations focused and small
- ❌ Don't modify applied migrations
- ❌ Don't use interactive SQL commands

## Troubleshooting

### Database Connection Fails

1. Check `DATABASE_URL` is correct
2. Verify database server is running
3. Check firewall/security group settings
4. Review SSL configuration
5. Check server logs for specific error type

### Migration Errors

```bash
# Check migration status
psql $DATABASE_URL -c "SELECT * FROM schema_migrations ORDER BY version;"

# Manual rollback (if needed)
psql $DATABASE_URL -c "DELETE FROM schema_migrations WHERE version = N;"
psql $DATABASE_URL -c "DROP TABLE table_name;"
```

### Seed Failures

```bash
# Check for schema mismatches
npm run typecheck

# Verify JSON files are valid
find registry/ -name "*.json" -exec jsonlint {} \;

# Try clean seed
npm run db:seed -- --clean
```

### Health Check Shows Degraded Mode

1. Check error type in `/health` response
2. **Connection errors**: Database server unreachable
3. **Migration errors**: Schema version mismatch
4. **Unknown errors**: Check application logs

## Performance Considerations

### File Mode
- ✅ Fast startup
- ✅ No external dependencies
- ❌ No search capabilities
- ❌ Static data only

### Database Mode
- ✅ Dynamic data
- ✅ Full-text search
- ✅ Advanced filtering
- ❌ Requires database server
- ❌ Slightly slower startup

## Deployment

### Vercel Deployment

```bash
# Set environment variable
vercel env add DATABASE_PRIVATE_URL production

# Deploy
vercel --prod

# Run migrations (one-time)
vercel env pull .env.production
npm run db:migrate
npm run db:seed
```

### Docker Deployment

```dockerfile
# DATABASE_URL passed at runtime
docker run -e DATABASE_URL=$DATABASE_URL -p 3000:3000 adcp-registry
```

### Kubernetes Deployment

```yaml
env:
  - name: DATABASE_URL
    valueFrom:
      secretKeyRef:
        name: postgres-credentials
        key: connection-string
```

## Testing

Run the test suite:

```bash
# Unit tests
npm test -- server/tests/unit/unified-registry.test.ts
npm test -- server/tests/unit/registry-db.test.ts
npm test -- server/tests/unit/migrate.test.ts

# Integration tests
npm test -- server/tests/integration/health.test.ts
```

## Backup and Recovery

### Backup

```bash
# Full database backup
pg_dump $DATABASE_URL > backup.sql

# Registry entries only
pg_dump $DATABASE_URL -t registry_entries > registry_backup.sql
```

### Restore

```bash
# Restore full database
psql $DATABASE_URL < backup.sql

# Restore registry entries
psql $DATABASE_URL < registry_backup.sql
```

## Security Best Practices

1. ✅ Use SSL in production
2. ✅ Verify certificates (`DATABASE_SSL_REJECT_UNAUTHORIZED=true`)
3. ✅ Use connection pooling limits
4. ✅ Store credentials in secrets manager
5. ✅ Use read-only connections where appropriate
6. ✅ Enable audit logging
7. ❌ Never commit `DATABASE_URL` to git
8. ❌ Never disable SSL verification in production

## Future Enhancements

Planned features:
- [ ] Migration rollback support (down migrations)
- [ ] Full-text search on descriptions
- [ ] Approval workflow UI
- [ ] Audit log implementation
- [ ] Partner self-service registration
- [ ] Automated schema version checks
