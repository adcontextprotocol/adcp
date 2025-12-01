# Metabase Self-Hosted Setup on Fly.io

This guide walks through deploying Metabase on Fly.io to save costs vs Metabase Cloud ($100/month).

## Cost Comparison

- **Metabase Cloud**: $100/month minimum (Starter plan)
- **Self-Hosted on Fly.io**: ~$10-15/month (1GB RAM machine + 3GB storage)

## Prerequisites

- Fly.io CLI installed and authenticated (`fly auth login`)
- Access to your production Postgres database

## Step 1: Create Metabase App

```bash
cd /path/to/adcp-1/.conductor/zagreb-v5

# Create the app (interactive - choose same region as main app)
fly apps create adcp-metabase
```

## Step 2: Create Volume for Metabase Data

```bash
# Create a 3GB volume in the same region as your main app
fly volumes create metabase_data --size 3 --region iad --app adcp-metabase
```

## Step 3: Attach to Production Database

Metabase needs access to your production Postgres database to read analytics data.

```bash
# Get your Postgres app name
fly postgres list

# Attach Metabase to the same Postgres (read-only recommended)
fly postgres attach <your-postgres-app-name> --app adcp-metabase
```

This creates a `DATABASE_URL` environment variable in the Metabase app.

## Step 4: Deploy Metabase

```bash
# Deploy using the metabase config
fly deploy --config fly.metabase.toml --app adcp-metabase
```

This will:
- Pull the official Metabase Docker image
- Create a machine with 1GB RAM
- Mount the persistent volume
- Start Metabase on port 3000 (internal)
- Auto-scale to zero when not in use (saves money!)

## Step 5: Initial Metabase Setup

Once deployed, open Metabase:

```bash
fly open --app adcp-metabase
```

This opens `https://adcp-metabase.fly.dev` in your browser.

**First-time setup:**
1. Create an admin account (use your email)
2. Skip the "Let's get started" tour
3. Click "I'll add my data later" (we'll connect manually)

## Step 6: Connect to Production Database

1. In Metabase, go to **Settings** (gear icon) → **Admin Settings** → **Databases**
2. Click **Add database**
3. Configure:
   - **Database type**: PostgreSQL
   - **Display name**: AdCP Production
   - **Host**: Your Postgres host (get from `fly postgres list`)
   - **Port**: 5432
   - **Database name**: `adcp_registry` (or your database name)
   - **Username**: `adcp` (or your username)
   - **Password**: (from your DATABASE_URL)
4. Click **Save**
5. Metabase will scan your database schema

## Step 7: Create Analytics Dashboard

1. Go to **+ New** → **Dashboard**
2. Name it "AdCP Analytics"
3. Add cards using our pre-built analytics views:
   - Monthly Revenue Trend (query: `SELECT * FROM monthly_revenue_summary ORDER BY month DESC LIMIT 12`)
   - Active Subscriptions (query: `SELECT COUNT(*) FROM customer_health WHERE subscription_status = 'active'`)
   - Revenue by Product (query: `SELECT product_name, total_revenue FROM product_revenue`)

Example SQL for a revenue chart:
```sql
SELECT
  month,
  total_revenue / 100.0 as revenue_usd,
  new_customer_revenue / 100.0 as new_revenue,
  recurring_revenue / 100.0 as recurring_revenue
FROM monthly_revenue_summary
ORDER BY month DESC
LIMIT 12
```

## Step 8: Enable Embedding

1. Go to **Settings** → **Admin Settings** → **Embedding**
2. Enable **"Embedding in other applications"**
3. Copy the **Embedding secret key** (long string)
4. Note your **Dashboard ID** from the URL (e.g., `/dashboard/2` → ID is `2`)

## Step 9: Configure Main App

Now set the environment variables in your main AdCP app:

```bash
# Get the Metabase URL
fly status --app adcp-metabase
# Will show: adcp-metabase.fly.dev

# Set secrets in main app
fly secrets set \
  METABASE_SITE_URL="https://adcp-metabase.fly.dev" \
  METABASE_SECRET_KEY="<your-embedding-secret-from-step-8>" \
  METABASE_DASHBOARD_ID="2" \
  ADMIN_EMAILS="your@email.com" \
  --app adcp-docs
```

## Step 10: Verify Embedding Works

1. Deploy your main app: `fly deploy --app adcp-docs`
2. Open `https://adcontextprotocol.org/admin/analytics`
3. You should see your Metabase dashboard embedded!

## Maintenance

**View logs:**
```bash
fly logs --app adcp-metabase
```

**SSH into Metabase:**
```bash
fly ssh console --app adcp-metabase
```

**Scale up/down:**
```bash
# Keep at least 1 machine running (no auto-suspend)
fly scale count 1 --app adcp-metabase

# Allow auto-suspend when idle (saves money)
fly scale count 0 --app adcp-metabase
```

**Update Metabase:**
```bash
fly deploy --config fly.metabase.toml --app adcp-metabase --image metabase/metabase:latest
```

## Security Considerations

1. **Database access**: Consider creating a read-only Postgres user for Metabase
2. **Admin interface**: The Metabase admin interface at `/admin` should be restricted (Fly.io provides HTTPS by default)
3. **Secret rotation**: Rotate `METABASE_SECRET_KEY` periodically
4. **Backups**: The volume is backed up by Fly.io, but consider additional backups

## Troubleshooting

**Metabase won't start:**
```bash
fly logs --app adcp-metabase
```
Common issues:
- Database connection failed (check DATABASE_URL)
- Volume mount failed (ensure volume exists in same region)

**Analytics not showing in main app:**
- Check METABASE_SECRET_KEY is set correctly
- Verify METABASE_DASHBOARD_ID matches your dashboard
- Check ADMIN_EMAILS is set (required for /admin/* access)
- Look at main app logs: `fly logs --app adcp-docs | grep metabase`

**Dashboard loads slowly:**
- Scale Metabase to keep 1 machine running: `fly scale count 1 --app adcp-metabase`
- Consider increasing memory: `fly scale memory 2048 --app adcp-metabase`

## Cost Optimization

The current config uses auto-suspend (`min_machines_running = 0`), which means:
- Metabase suspends when idle (>5 minutes no requests)
- First request wakes it up (~5-10 seconds)
- Saves money when analytics aren't actively used

If you need instant access:
```bash
fly scale count 1 --app adcp-metabase
```

This keeps one machine always running (~$10-12/month).
