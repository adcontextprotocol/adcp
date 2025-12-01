# AdCP Analytics & Business Intelligence

This guide covers the analytics infrastructure for AdCP, including SQL views and Metabase setup.

## Overview

AdCP uses a two-layer analytics approach:
1. **SQL Views** - Pre-computed aggregations in PostgreSQL for fast queries
2. **Metabase** - Self-service BI tool for dashboards and visualizations

## SQL Analytics Views

The following views are available in your database (created by migration `009_analytics_views.sql`):

### Revenue Views

#### `revenue_by_month`
Monthly revenue aggregation with gross, refunds, and net revenue.

```sql
SELECT * FROM revenue_by_month ORDER BY month DESC LIMIT 12;
```

**Columns:**
- `month` - First day of month (timestamp)
- `gross_revenue` - Total positive revenue (USD)
- `refunds` - Total refunds as negative number (USD)
- `net_revenue` - Gross minus refunds (USD)
- `paying_customers` - Unique customers who paid
- `subscription_payments` - Count of subscription payments
- `refund_count` - Number of refund events

#### `daily_revenue`
Daily revenue metrics for trend analysis.

```sql
SELECT * FROM daily_revenue WHERE date >= CURRENT_DATE - INTERVAL '30 days';
```

**Columns:**
- `date` - Calendar date
- `gross_revenue`, `refunds`, `net_revenue` - Same as monthly
- `transaction_count` - Total payment events
- `unique_customers` - Daily unique payers

#### `product_revenue`
Revenue breakdown by product/SKU.

```sql
SELECT * FROM product_revenue ORDER BY total_revenue DESC;
```

**Columns:**
- `product_name`, `product_id`
- `customer_count` - Unique customers
- `total_revenue` - All-time revenue (USD)
- `avg_revenue_per_customer` - Average per customer (USD)
- `first_sale`, `last_sale` - Date range

### Customer Views

#### `customer_health`
Current health status of all customers with LTV and risk indicators.

```sql
SELECT * FROM customer_health
WHERE subscription_status = 'active'
ORDER BY lifetime_value DESC;
```

**Columns:**
- `workos_organization_id`, `company_name`, `stripe_customer_id`
- `customer_since` - Account creation date
- `mrr` - Monthly recurring revenue (USD)
- `subscription_interval` - 'month' or 'year'
- `subscription_current_period_end` - Next renewal date
- `subscription_canceled_at` - Cancellation timestamp (if canceled)
- `subscription_status` - 'active', 'canceled', 'expired', 'none'
- `renewal_at_risk` - TRUE if renewing in next 7 days
- `total_payments` - Count of all payment events
- `lifetime_value` - Total revenue from customer (USD)
- `refund_count` - Number of refunds issued
- `last_payment_date` - Most recent payment timestamp

#### `subscription_metrics`
Summary metrics for subscription business (MRR, churn, etc.).

```sql
SELECT * FROM subscription_metrics;
```

**Columns** (all single-row summary):
- `active_subscriptions`, `canceled_subscriptions`, `expired_subscriptions`, `no_subscription`
- `total_mrr` - Sum of all active MRR (USD)
- `avg_mrr` - Average MRR per active sub (USD)
- `total_ltv` - Sum of all customer LTV (USD)
- `avg_ltv_active` - Average LTV for active customers (USD)
- `renewals_at_risk_7d` - Count of renewals in next 7 days

#### `cohort_analysis`
Customer retention by signup cohort.

```sql
SELECT * FROM cohort_analysis ORDER BY cohort_month DESC;
```

**Columns:**
- `cohort_month` - Month customers signed up
- `cohort_size` - Total customers in cohort
- `still_active` - Currently active subscribers
- `churned` - Customers who canceled
- `retention_rate` - Percentage still active

### Operational Views

#### `payment_success_rate`
Payment processing success rate over time.

```sql
SELECT * FROM payment_success_rate
WHERE date >= CURRENT_DATE - INTERVAL '30 days'
ORDER BY date DESC;
```

**Columns:**
- `date` - Calendar date
- `successful_payments`, `failed_payments`, `total_attempts`
- `success_rate` - Percentage of successful attempts

## Metabase Setup

### 1. Start Metabase

```bash
docker-compose -f docker-compose.metabase.yml up -d
```

Metabase will be available at: **http://localhost:3001**

### 2. Automated Initial Setup

Run the setup script to automatically configure Metabase with signed embedding:

```bash
./scripts/setup-metabase.sh
```

This script will:
- Create an admin user (`admin@adcp.local`)
- Enable embedded dashboard support
- Generate a secret key for signed embedding
- Output environment variables to add to `.env.local`

**Add the environment variables from the script output to your `.env.local` file:**

```env
METABASE_SITE_URL=http://localhost:3001
METABASE_SECRET_KEY=<generated-secret-key>
```

Then restart your dev server to load the new environment variables.

**Accessing Metabase:**

- **Admin Panel**: Navigate to `/admin/analytics` to view embedded dashboards (after creating one - see step 4)
- **Direct Access**: http://localhost:3001 (login with admin credentials from setup script)

### 3. Manual Setup (Alternative)

If you prefer manual setup:

1. Open http://localhost:3001
2. Create admin account (first user)
3. Go to Admin → Settings → Embedding
4. Enable "Embedding in other applications"
5. Generate an embedding secret key
6. Add the secret key to `.env.local` as `METABASE_SECRET_KEY`
7. Click "Add a database"

### 4. Connect to PostgreSQL

**Database type:** PostgreSQL

**Display name:** AdCP Production

**Connection settings:**
- Host: `host.docker.internal` (Mac/Windows) or `172.17.0.1` (Linux)
- Port: `53198` (or your PostgreSQL port from `.env.local`)
- Database name: `adcp`
- Username: `adcp` (from `.env.local`)
- Password: `localdev` (from `.env.local`)

**Advanced options:**
- SSL: No (for local development)

Click "Save" to test connection.

### 4. Create Your First Dashboard and Enable Embedding

After creating dashboards, you need to enable embedding and configure the dashboard ID for the admin panel.

#### Step 1: Create Dashboard in Metabase

Create a new dashboard called "Revenue Overview" with these questions:

1. **Total Revenue (This Month)**
   - SQL: `SELECT SUM(net_revenue) FROM revenue_by_month WHERE month >= DATE_TRUNC('month', CURRENT_DATE)`
   - Visualization: Number
   - Format as currency

2. **MRR Trend (Last 12 Months)**
   - Table: `revenue_by_month`
   - X-axis: `month`
   - Y-axis: `net_revenue`
   - Visualization: Line chart
   - Limit: 12 rows

3. **Active Subscriptions**
   - SQL: `SELECT active_subscriptions FROM subscription_metrics`
   - Visualization: Number

4. **Revenue by Product**
   - Table: `product_revenue`
   - Visualization: Bar chart or Table
   - Sort by: `total_revenue DESC`

#### Step 2: Enable Embedding for Your Dashboard

Once you've created your dashboard:

1. Click the dashboard share icon (top right) → "Embedding"
2. Click "Enable" to turn on embedding for this dashboard
3. Note the dashboard ID from the URL: `http://localhost:3001/dashboard/1` → dashboard ID is `1`
4. Add the dashboard ID to your `.env.local`:

```env
METABASE_DASHBOARD_ID=1
```

5. Restart your dev server to load the new environment variable
6. Navigate to `/admin/analytics` - your dashboard will now load automatically!

**Note:** The open-source version of Metabase supports signed embedding for dashboards. This provides secure, seamless integration without requiring Metabase Enterprise features.

#### Dashboard 2: Customer Health

1. **Customers by Status**
   - Table: `customer_health`
   - Group by: `subscription_status`
   - Aggregate: Count
   - Visualization: Pie chart

2. **Top Customers by LTV**
   - Table: `customer_health`
   - Columns: `company_name`, `lifetime_value`, `subscription_status`
   - Sort by: `lifetime_value DESC`
   - Limit: 10
   - Visualization: Table

3. **Renewals at Risk (Next 7 Days)**
   - SQL: `SELECT COUNT(*) FROM customer_health WHERE renewal_at_risk = TRUE`
   - Visualization: Number (with alert styling)

4. **Cohort Retention**
   - Table: `cohort_analysis`
   - Columns: `cohort_month`, `cohort_size`, `retention_rate`
   - Visualization: Table or Heatmap
   - Limit: 12 rows

#### Dashboard 3: Operational Metrics

1. **Payment Success Rate (30 Days)**
   - Table: `payment_success_rate`
   - Filter: `date >= CURRENT_DATE - INTERVAL '30 days'`
   - X-axis: `date`
   - Y-axis: `success_rate`
   - Visualization: Line chart

2. **Daily Revenue Trend**
   - Table: `daily_revenue`
   - Filter: Last 30 days
   - X-axis: `date`
   - Y-axes: `gross_revenue`, `refunds`, `net_revenue`
   - Visualization: Multi-line chart

3. **Failed Payments (Last 7 Days)**
   - Table: `payment_success_rate`
   - Filter: `date >= CURRENT_DATE - INTERVAL '7 days'`
   - Sum: `failed_payments`
   - Visualization: Number

### 5. Accessing Analytics in Admin Panel

The analytics dashboard is embedded in your admin panel using Metabase's signed embedding feature!

**To view analytics:**
1. Create a dashboard in Metabase (see step 4)
2. Enable embedding and add the dashboard ID to `.env.local`
3. Navigate to `/admin/analytics` in your browser
4. The embedded dashboard will load securely inside the admin panel

**Benefits of Signed Embedding:**
- ✅ Secure - tokens expire after 10 minutes and are regenerated automatically
- ✅ No Metabase login required - tokens authorize access directly
- ✅ Works with open-source Metabase (no Enterprise license needed)
- ✅ Seamless experience - dashboard feels like part of your admin panel

**Implementation Details:**

The integration works through:
- `/api/admin/metabase-token` endpoint generates signed embedding URLs
- `admin-analytics.html` page loads the dashboard in an iframe
- Metabase validates the signature and displays the dashboard

**Multiple Dashboards:**

To embed multiple dashboards, you can:
1. Create additional dashboards in Metabase
2. Enable embedding for each one
3. Use different dashboard IDs in your application
4. Either switch between them or create separate pages

## Query Examples

### Find customers likely to churn

```sql
SELECT
  company_name,
  mrr,
  subscription_current_period_end,
  last_payment_date,
  refund_count
FROM customer_health
WHERE renewal_at_risk = TRUE
  AND refund_count > 0
ORDER BY mrr DESC;
```

### Calculate churn rate for last month

```sql
WITH last_month AS (
  SELECT cohort_month, retention_rate
  FROM cohort_analysis
  WHERE cohort_month = DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
)
SELECT
  cohort_month,
  100 - retention_rate AS churn_rate
FROM last_month;
```

### Revenue growth rate (MoM)

```sql
WITH monthly AS (
  SELECT
    month,
    net_revenue,
    LAG(net_revenue) OVER (ORDER BY month) AS prev_month_revenue
  FROM revenue_by_month
  WHERE month >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '12 months')
)
SELECT
  month,
  net_revenue,
  prev_month_revenue,
  ROUND(((net_revenue - prev_month_revenue) / NULLIF(prev_month_revenue, 0) * 100), 2) AS growth_rate_pct
FROM monthly
WHERE prev_month_revenue IS NOT NULL
ORDER BY month DESC;
```

### Customers who need renewal follow-up

```sql
SELECT
  company_name,
  mrr,
  subscription_current_period_end,
  EXTRACT(DAY FROM (subscription_current_period_end - NOW())) AS days_until_renewal
FROM customer_health
WHERE renewal_at_risk = TRUE
  AND subscription_status = 'active'
ORDER BY subscription_current_period_end ASC;
```

## Maintenance

### Refresh Metabase Metadata

When you add new views or tables:
1. Go to Admin → Databases → AdCP Production
2. Click "Sync database schema now"

### Backup Metabase Data

```bash
# Backup Metabase's own database (dashboards, settings)
docker-compose -f docker-compose.metabase.yml exec metabase sh -c \
  'cp /metabase-data/metabase.db.mv.db /metabase-data/metabase-backup-$(date +%Y%m%d).db.mv.db'
```

### Stop Metabase

```bash
docker-compose -f docker-compose.metabase.yml down
```

### View Logs

```bash
docker-compose -f docker-compose.metabase.yml logs -f metabase
```

## Performance Tips

1. **Use Views** - The pre-computed views are much faster than querying raw tables
2. **Add Filters** - Always filter by date ranges in Metabase questions
3. **Cache Results** - Enable Metabase caching for dashboards (Admin → Settings → Caching)
4. **Scheduled Refresh** - Set dashboards to refresh every 5-15 minutes, not real-time

## Next Steps

1. **Alerts** - Set up Metabase alerts for key metrics (failed payments, low MRR, etc.)
2. **Public Links** - Share dashboards with stakeholders via public URLs
3. **API Access** - Use Metabase API to fetch metrics programmatically
4. **Custom Reports** - Build SQL queries for one-off reports using these views as a foundation

## Troubleshooting

**Can't connect to database:**
- Check PostgreSQL is running: `lsof -i :53198`
- Verify credentials in `.env.local` match Metabase connection
- On Linux, use `172.17.0.1` instead of `host.docker.internal`

**Views not showing up:**
- Run: `docker-compose -f docker-compose.metabase.yml exec metabase sh -c 'curl -X POST http://localhost:3000/api/database/1/sync'`
- Or manually sync in Admin → Databases

**Dashboard is slow:**
- Add date filters (e.g., last 30 days)
- Enable caching in Metabase settings
- Consider adding indexes to base tables if needed
