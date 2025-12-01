# API Endpoint Testing

## Current Status

The API endpoints have comprehensive test coverage through integration tests:

1. **Revenue Tracking** (`tests/integration/revenue-tracking.test.ts`) - 13 tests ✅
2. **Admin Endpoints** (`tests/integration/admin-endpoints.test.ts`) - 9 tests ✅

## Status: 22/22 Tests Passing ✅

**All API endpoint tests are now passing!** This includes:
- 13 revenue tracking tests (9 webhook tests + 4 admin stats endpoint tests)
- 9 admin endpoint tests (3 members tests + 3 agreement tests + 3 sync tests)

The integration test suite provides comprehensive end-to-end testing without requiring manual UI interaction.

### Recent Fixes

1. **Webhook Route Registration** (FIXED)
   - Moved webhook route from `setupAuthRoutes()` to `setupRoutes()` in `src/http.ts:1068`
   - Added `orgDb` and `pool` declarations inside webhook handler
   - Replaced `this.db.query()` calls with `pool.query()` for proper database access
   - Webhook route now registers regardless of WorkOS configuration

2. **Webhook Payload Parsing** (FIXED)
   - Fixed `constructEvent` mock override to properly handle Buffer from `express.raw()` middleware
   - Updated in `tests/integration/revenue-tracking.test.ts:76-83`

3. **Product Name Fallback** (FIXED)
   - Added fallback to line item description when Stripe product fetch fails (useful for tests)
   - Updated in `src/http.ts:1257-1259` and `src/http.ts:1325-1328`

4. **Admin Stats Route Registration** (FIXED)
   - Moved admin stats route from `setupAuthRoutes()` to `setupRoutes()` in `src/http.ts:1531-1674`
   - Route now registers regardless of WorkOS configuration, enabling testing
   - Enabled admin stats tests by removing `.skip` in `tests/integration/revenue-tracking.test.ts:322`

5. **Admin Stats Database Schema** (FIXED)
   - Removed all dependencies on non-existent `subscription_status` column
   - Updated endpoint queries to infer status from existing fields (`subscription_amount`, `subscription_current_period_end`, `subscription_canceled_at`)
   - Updated test queries to set status-determining fields instead of non-existent column
   - Fixed `total_revenue` calculation to include refunds as negative amounts

6. **Admin Stats Response Formatting** (FIXED)
   - Changed `formatCurrency()` from `Intl.NumberFormat` to `toFixed(2)` for precise cent handling
   - Fixed `count` field in product_breakdown to return string instead of number
   - Corrected test expectations to match actual cent calculations (7999 cents = $79.99, not $79.98)

7. **Admin Endpoints Route Registration** (FIXED)
   - Moved ALL admin routes from `setupAuthRoutes()` to `setupRoutes()` in `src/http.ts:1675-1881`
   - Routes now register regardless of WorkOS configuration, enabling testing
   - Includes: `/admin`, `/api/admin/members`, `/api/admin/agreements`, `/admin/members`, `/admin/agreements`

8. **Agreements Table Schema** (FIXED)
   - Fixed test queries to use `text` column instead of non-existent `content` column
   - Added required `agreement_type` field to all agreement INSERT/UPDATE operations
   - Updated test assertions to check for `text` property instead of `content`

9. **Organization Data Sync** (NEW)
   - Added `POST /api/admin/members/:orgId/sync` endpoint to refresh data from WorkOS and Stripe
   - Improved error logging to WARN level for better visibility of WorkOS API failures
   - Added sync button to admin members UI for per-row data refresh
   - Tests verify sync endpoint handles missing orgs, WorkOS errors, and Stripe subscription updates

### Test Results

**22/22 tests passing:**

**Revenue tracking tests (13):**
- Webhook tests (9):
  - ✅ invoice.payment_succeeded - Record revenue event
  - ✅ invoice.payment_succeeded - Store subscription line items
  - ✅ invoice.payment_succeeded - Update organization subscription details
  - ✅ invoice.payment_succeeded - Handle recurring payments
  - ✅ invoice.payment_failed - Record failed payment attempt
  - ✅ invoice.payment_failed - No line items for failed payments
  - ✅ charge.refunded - Record full refund as negative revenue
  - ✅ charge.refunded - Handle partial refunds
  - ✅ charge.refunded - Subscription not automatically canceled on refund
- Admin stats endpoint tests (4):
  - ✅ Calculate total revenue correctly
  - ✅ Calculate MRR correctly from active subscriptions
  - ✅ Handle refunds in total revenue calculation
  - ✅ Show product breakdown

**Admin endpoint tests (9):**
- GET /api/admin/members (3):
  - ✅ List all organization members
  - ✅ Compute subscription status correctly
  - ✅ Show canceled status when subscription is canceled
- Agreement management (3):
  - ✅ GET /api/admin/agreements - List all agreements
  - ✅ POST /api/admin/agreements - Create new agreement
  - ✅ PUT /api/admin/agreements/:id - Update existing agreement
- Organization sync (3):
  - ✅ POST /api/admin/members/:orgId/sync - Sync data from WorkOS and Stripe
  - ✅ Return 404 for non-existent organization
  - ✅ Handle WorkOS errors gracefully

## Solutions

### Option 1: Use Real Stripe Test Mode (Recommended)
Use actual Stripe test keys from `.env.local` without mocking. This would:
- Allow full end-to-end testing
- Test actual Stripe integration
- Still be completely safe (test mode doesn't charge real money)
- Require minimal code changes

### Option 2: Refactor Webhook Registration
Make webhook route registration unconditional:
- Register route regardless of Stripe config
- Check config at request time instead of registration time
- Would allow mocks to work properly

### Option 3: Direct Handler Testing (Current Workaround)
Test webhook handlers directly as unit tests instead of through HTTP:
- Import and call handler functions directly
- Mock database layer
- Faster and more isolated
- Doesn't test full HTTP integration

## Running Tests

```bash
# Run all tests
npm test

# Run specific test file
npx vitest run tests/integration/revenue-tracking.test.ts

# Use test database
DATABASE_URL=postgresql://adcp:localdev@localhost:53198/adcp_test npx vitest run
```

## Test Database Setup

The test database is already created and migrated:
- Database: `adcp_test` on localhost:53198
- User: `adcp` / `localdev`
- All migrations applied (including 008_revenue_tracking.sql)
