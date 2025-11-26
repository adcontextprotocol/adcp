# Conductor Workspace Setup for AdCP

## ✅ Your Setup is Correct!

### What You Have Now

**Project Root** (`/Users/brianokelley/Developer/adcp-1/`)
- `.env` - Shared WorkOS staging credentials (source of truth)
- `.conductor/istanbul-v3/` - Current workspace

**Current Workspace** (`.conductor/istanbul-v3/`)
- `.env.local` - Workspace config with DATABASE_URL + copied WorkOS secrets
- `docker-compose.yml` - PostgreSQL on port 5433
- `conductor.json.example` - Template for future workspaces
- `package.json` - Updated to use `DOTENV_CONFIG_PATH=.env.local`

**Database**
- Container: `istanbul-v3-postgres-1`
- Port: `5433` (published to host)
- Connection: `postgresql://adcp:localdev@localhost:5433/adcp_registry`

### How It Works

1. **Project root .env** contains shared WorkOS staging credentials
2. **Workspace .env.local** contains workspace-specific config + copies secrets from root
3. **npm scripts** use `DOTENV_CONFIG_PATH=.env.local` to load the right file
4. **Database URL** uses `localhost:5433` because Docker publishes postgres to host

### For New Workspaces

When you create a new Conductor workspace:

1. Copy `conductor.json.example` to project root: 
   ```bash
   cp .conductor/istanbul-v3/conductor.json.example .conductor/conductor.json
   ```

2. Conductor will automatically:
   - Copy `/Users/brianokelley/Developer/adcp-1/.env` → `{workspace}/.env.local`
   - Start postgres: `docker compose up -d`
   - Install deps: `npm install`
   - Run migrations: `npm run db:migrate`
   - Seed data: `npm run db:seed`

### For Production

Your production environment needs:

```bash
# Production database (SSL enabled)
DATABASE_URL=postgresql://user:pass@prod-host:5432/dbname?sslmode=require
DATABASE_SSL=true

# Production WorkOS (live keys)
WORKOS_API_KEY=sk_live_...
WORKOS_CLIENT_ID=client_...
WORKOS_COOKIE_PASSWORD=<new 32-char secret>
WORKOS_REDIRECT_URI=https://yourdomain.com/auth/callback

# Stripe (when ready)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PUBLISHABLE_KEY=pk_live_...
STRIPE_PRICING_TABLE_ID=prctbl_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Production settings
NODE_ENV=production
LOG_LEVEL=info
```

### Testing Your Setup

```bash
# 1. Check database connectivity
psql postgresql://adcp:localdev@localhost:5433/adcp_registry -c "SELECT 1"

# 2. Check environment loads
DOTENV_CONFIG_PATH=.env.local node -r dotenv/config -e "console.log(process.env.DATABASE_URL)"

# 3. Start the server
npm start

# 4. Run migrations
npm run db:migrate

# 5. Seed database
npm run db:seed
```

### Summary

✅ **Root .env** - Shared WorkOS staging credentials  
✅ **Workspace .env.local** - Local config + copied secrets  
✅ **Docker postgres** - Running on port 5433  
✅ **Package.json** - Configured to use .env.local  
✅ **conductor.json.example** - Template ready for new workspaces  

**Everything is configured correctly and ready to use!**
