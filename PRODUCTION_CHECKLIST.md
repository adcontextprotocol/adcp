# Production Deployment Checklist

This checklist ensures all required services and secrets are properly configured for production deployment.

## Prerequisites

- [ ] Fly.io CLI installed and authenticated
- [ ] Production domain configured
- [ ] SSL/TLS certificates configured (handled by Fly.io automatically)

## Database Setup

- [ ] PostgreSQL database created on Fly.io or managed service
- [ ] Database migrations run successfully
- [ ] `DATABASE_URL` secret set in production
- [ ] `DATABASE_SSL=true` configured
- [ ] Connection pooling configured (if high traffic expected)

## Authentication (WorkOS)

- [ ] WorkOS account created
- [ ] Production OAuth application configured
- [ ] `WORKOS_API_KEY` secret set (use live key, not test)
- [ ] `WORKOS_CLIENT_ID` secret set
- [ ] `WORKOS_COOKIE_PASSWORD` generated and set (min 32 characters)
- [ ] `WORKOS_REDIRECT_URI` set to production callback URL (https://)
- [ ] `ADMIN_EMAILS` configured with authorized admin email addresses

## Billing (Stripe)

- [ ] Stripe account in production mode
- [ ] `STRIPE_SECRET_KEY` set (sk_live_...)
- [ ] `STRIPE_PUBLISHABLE_KEY` set (pk_live_...)
- [ ] `STRIPE_PRICING_TABLE_ID` configured
- [ ] Webhook endpoint configured in Stripe dashboard
- [ ] `STRIPE_WEBHOOK_SECRET` set from Stripe webhook settings
- [ ] Test webhook delivery working

## Environment Variables

Run this command to set all secrets in Fly.io:

```bash
# Required secrets
fly secrets set \
  DATABASE_URL="postgresql://user:pass@host:5432/db" \
  WORKOS_API_KEY="sk_live_..." \
  WORKOS_CLIENT_ID="client_..." \
  WORKOS_COOKIE_PASSWORD="<32-char-random-string>" \
  WORKOS_REDIRECT_URI="https://yourdomain.com/auth/callback" \
  ADMIN_EMAILS="admin@example.com,owner@example.com" \
  --app adcp-docs

# Billing secrets (if using Stripe)
fly secrets set \
  STRIPE_SECRET_KEY="sk_live_..." \
  STRIPE_PUBLISHABLE_KEY="pk_live_..." \
  STRIPE_PRICING_TABLE_ID="prctbl_..." \
  STRIPE_WEBHOOK_SECRET="whsec_..." \
  --app adcp-docs
```

## Deployment Steps

1. **Build and deploy:**
   ```bash
   fly deploy --app adcp-docs
   ```

2. **Run database migrations:**
   ```bash
   fly ssh console --app adcp-docs
   # Inside the container:
   cd /app && node dist/db/migrate.js
   ```

3. **Verify health:**
   ```bash
   fly status --app adcp-docs
   fly logs --app adcp-docs
   ```

4. **Test critical paths:**
   - [ ] Homepage loads
   - [ ] `/api/health` returns 200
   - [ ] Authentication flow works (login/logout)
   - [ ] Dashboard loads for authenticated users
   - [ ] Stripe webhooks receive events
   - [ ] Analytics dashboard loads at /admin/analytics
   - [ ] Admin endpoints require proper authentication

## Monitoring

- [ ] Configure log aggregation (Fly.io logs or external service)
- [ ] Set up uptime monitoring
- [ ] Configure alerts for critical errors
- [ ] Monitor database connection pool usage
- [ ] Track Stripe webhook failures

## Security Verification

- [ ] All secrets use production values (no test keys)
- [ ] HTTPS enforced for all endpoints
- [ ] Secure cookies enabled (NODE_ENV=production)
- [ ] Admin endpoints require authentication
- [ ] Database uses SSL connections
- [ ] No secrets committed to git

## Post-Deployment

- [ ] Test complete user registration flow
- [ ] Test subscription purchase flow
- [ ] Verify webhook processing
- [ ] Check analytics data updates
- [ ] Monitor error rates for 24 hours
- [ ] Document any production-specific configuration

## Rollback Plan

If deployment fails:

```bash
# List deployments
fly releases --app adcp-docs

# Rollback to previous version
fly releases rollback <version> --app adcp-docs
```

## Support

- Issues: https://github.com/adcontextprotocol/adcp/issues
- Email: support@adcontextprotocol.org
