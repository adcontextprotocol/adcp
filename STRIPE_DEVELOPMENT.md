# Stripe Development Setup

## Quick Start

### Option 1: Run Everything Together (Recommended)

```bash
npm run dev
```

This starts:
- **HTTP Server** (blue) - Your application on port 3000
- **Docs** (green) - Mintlify docs on port 3333
- **Stripe** (magenta) - Webhook forwarding to localhost:3000/api/webhooks/stripe

### Option 2: Run Services Individually

```bash
# Terminal 1: Start the server
npm start

# Terminal 2: Start Stripe webhook forwarding
npm run start:stripe

# Terminal 3: Start docs (optional)
npm run start:mintlify
```

## How Stripe CLI Webhook Forwarding Works

When you run `npm run start:stripe`, Stripe CLI will:

1. **Connect to Stripe** - Authenticate with your Stripe test account
2. **Generate webhook secret** - Create a temporary signing secret (starts with `whsec_`)
3. **Forward webhooks** - Tunnel webhook events from Stripe to `localhost:3000/api/webhooks/stripe`
4. **Show output** - Display each webhook event as it's forwarded

### Example Output

```
Ready! You are using Stripe API Version [2025-11-17]. Your webhook signing secret is whsec_abc123... (^C to quit)
2025-11-26 10:30:15   --> customer.subscription.created [evt_123...]
2025-11-26 10:30:16   <--  [200] POST http://localhost:3000/api/webhooks/stripe [evt_123...]
```

## Getting the Webhook Secret

The webhook signing secret is **printed to the console** when Stripe CLI starts. It looks like:

```
Your webhook signing secret is whsec_...
```

### To Use It Permanently (Optional)

If you want to avoid manually copying the secret each time:

1. **Copy the secret** from Stripe CLI output
2. **Add to .env.local**:
   ```bash
   STRIPE_WEBHOOK_SECRET=whsec_...
   ```

**Note:** The secret changes each time you restart Stripe CLI, so you'll need to update it. For development, it's fine to just let it run and not worry about the secret in .env.local.

## Testing Webhooks

### 1. Trigger Test Events from Stripe CLI

```bash
# Test a customer.subscription.created event
stripe trigger customer.subscription.created

# Test a customer.subscription.updated event
stripe trigger customer.subscription.updated

# Test a customer.subscription.deleted event
stripe trigger customer.subscription.deleted
```

### 2. Trigger Events from Stripe Dashboard

1. Go to https://dashboard.stripe.com/test/subscriptions
2. Create/update/cancel a test subscription
3. Watch your terminal - you'll see the webhook events flow through

### 3. Watch Server Logs

Your server will log webhook events:

```
[INFO] Webhook received: customer.subscription.created
[INFO] Updated organization subscription status to 'active'
```

## Environment Variables

Your `.env.local` has:

```bash
# Stripe API Keys (from staging account)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_PRICING_TABLE_ID=prctbl_...

# Webhook secret (dynamically provided by Stripe CLI)
# STRIPE_WEBHOOK_SECRET=whsec_...  # Optional - CLI provides this automatically
```

## Testing the Full Billing Flow

1. **Start development server**: `npm run dev`
2. **Open dashboard**: http://localhost:3000/dashboard
3. **Login with WorkOS** (uses your staging credentials)
4. **View pricing table** (if no subscription)
5. **Create test subscription** using Stripe test card: `4242 4242 4242 4242`
6. **Watch webhook** in terminal - subscription should activate
7. **Refresh dashboard** - should show active subscription

## Stripe CLI Commands Reference

```bash
# Start webhook forwarding
stripe listen --forward-to localhost:3000/api/webhooks/stripe

# Trigger specific events
stripe trigger payment_intent.succeeded
stripe trigger customer.subscription.created
stripe trigger invoice.payment_succeeded

# View recent events
stripe events list --limit 10

# View specific event details
stripe events retrieve evt_...

# Login to different account
stripe login
```

## Troubleshooting

### "Stripe CLI not found"

Install Stripe CLI:
```bash
brew install stripe/stripe-cli/stripe
```

### "You're not authenticated"

Login to Stripe:
```bash
stripe login
```

### Webhook not receiving events

1. Check Stripe CLI is running and showing "Ready!"
2. Verify server is running on port 3000
3. Check webhook endpoint: http://localhost:3000/api/webhooks/stripe
4. Look for errors in both Stripe CLI and server logs

### Webhook signature verification fails

This means the `STRIPE_WEBHOOK_SECRET` doesn't match. Either:
- Remove `STRIPE_WEBHOOK_SECRET` from `.env.local` (let CLI provide it dynamically)
- Or update it with the current secret from CLI output

## Production Webhook Setup

For production, you'll need to:

1. **Create webhook endpoint** in Stripe dashboard
2. **Add endpoint URL**: `https://yourdomain.com/api/webhooks/stripe`
3. **Select events to listen to**:
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_succeeded`
   - `invoice.payment_failed`
4. **Copy webhook signing secret** and add to production environment:
   ```bash
   STRIPE_WEBHOOK_SECRET=whsec_...
   ```

## Summary

✅ **Development**: Use `npm run dev` - Stripe CLI handles webhook forwarding automatically
✅ **Webhook Secret**: Dynamically provided by CLI (prints to console)
✅ **Testing**: Use `stripe trigger` commands or Stripe dashboard
✅ **Production**: Create webhook endpoint in Stripe dashboard and use that secret

**Just run `npm run dev` and you're ready to develop with Stripe webhooks!** 🎉
