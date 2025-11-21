---
"adcontextprotocol": patch
---

Complete consolidation of ALL inline enum definitions into /schemas/v1/enums/ directory for consistency and maintainability.

**New enum schemas created (31 total):**

*Video/Audio Ad Serving:*
- `vast-version.json`, `vast-tracking-event.json` - VAST specs
- `daast-version.json`, `daast-tracking-event.json` - DAAST specs

*Core Protocol:*
- `adcp-domain.json` - Protocol domains (media-buy, signals)
- `property-type.json` - Property types (website, mobile_app, ctv_app, dooh, etc.)
- `dimension-unit.json` - Dimension units (px, dp, inches, cm)

*Creative Policies & Requirements:*
- `co-branding-requirement.json`, `landing-page-requirement.json` - Creative policies
- `creative-action.json` - Creative lifecycle
- `validation-mode.json` - Creative validation strictness

*Asset Types:*
- `javascript-module-type.json`, `markdown-flavor.json`, `url-asset-type.json`
- `http-method.json`, `webhook-response-type.json`, `webhook-security-method.json`

*Performance & Reporting:*
- `metric-type.json`, `feedback-source.json` - Performance feedback
- `reporting-frequency.json`, `available-metric.json` - Delivery reports
- `notification-type.json` - Delivery notifications

*Signals & Discovery:*
- `signal-catalog-type.json` - Signal catalog types
- `creative-agent-capability.json` - Creative agent capabilities
- `preview-output-format.json` - Preview formats

*Brand & Catalog:*
- `feed-format.json`, `update-frequency.json` - Product catalogs
- `auth-scheme.json` - Push notification auth

*UI & Sorting:*
- `sort-direction.json`, `creative-sort-field.json`, `history-entry-type.json`

**Schemas updated (25+ files):**

*High-impact (eliminated duplication):*
- `vast-asset.json`, `daast-asset.json` - Removed duplicate enum definitions
- `performance-feedback.json`, `provide-performance-feedback-request.json` - Unified metrics/sources
- `signals/get-signals-request.json`, `signals/get-signals-response.json` - Unified catalog types
- `list-creative-formats-response.json` (2 files) - Unified capabilities
- `preview-creative-request.json` - Unified output formats (3 occurrences)

*Asset schemas:*
- `webhook-asset.json`, `javascript-asset.json`, `markdown-asset.json`, `url-asset.json`

*Core schemas:*
- `property.json`, `format.json`, `creative-policy.json`
- `reporting-capabilities.json`, `push-notification-config.json`, `webhook-payload.json`

*Task schemas:*
- `sync-creatives-request.json`, `sync-creatives-response.json`
- `list-creatives-request.json`, `list-creatives-response.json`
- `get-media-buy-delivery-request.json`, `get-products-request.json`
- Various task list/history schemas

**Documentation improvements:**
- Added comprehensive enum versioning strategy to CLAUDE.md
- Clarifies when enum changes are MINOR vs MAJOR version bumps
- Documents best practices for enum evolution (add → deprecate → remove)
- Provides examples of proper enum deprecation workflows

**Registry update:**
- Added all 31 new enums to `index.json` with descriptions

**Impact:**
- **Enum files**: 16 → 46 (31 new enums)
- **Schemas validated**: 112 → 137 (25 new enum files)
- **Duplication eliminated**: 8+ instances across schemas
- **Single source of truth**: All enums now centralized

**Benefits:**
- Complete consistency across all schemas
- Eliminates all inline enum duplication
- Easier to discover and update enum values
- Better SDK generation from consolidated enums
- Clear guidance for maintaining backward compatibility
- Follows JSON Schema best practices
