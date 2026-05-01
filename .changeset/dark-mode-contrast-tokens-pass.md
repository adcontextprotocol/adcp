---
---

fix(public-site): comprehensive dark-mode contrast pass — semantic token migration across HTML/CSS/JS

Replace hardcoded color values (`white`, `#fff`, `#000`, raw hex literals) and raw-palette tokens (`var(--color-gray-*)`, `var(--color-primary-50)`) used as backgrounds/borders with swap-aware semantic tokens so authenticated and public surfaces remain legible under both `prefers-color-scheme: dark` and `html[data-theme="dark"]`.

**design-system.css** — adds 7 swap-aware semantic tokens wired into all four theme blocks: `--color-text-on-dark`, `--color-text-on-dark-secondary`, `--color-bg-button-secondary`, `--color-bg-button-secondary-hover`, `--color-bg-table-header`, `--color-bg-row-hover`, `--color-hover-overlay`. Updates `.btn-secondary` to use the new button-surface tokens. Maps `--aao-white` to `var(--color-text-on-dark)` so legacy usages render sensibly during migration. Updates `.ds-text-on-dark` and `.ds-text-on-dark-secondary` utility classes to reference the new tokens.

**Fills out missing scale stops on success/warning/error palettes** — adds `-200`, `-300`, `-400`, `-800`, `-900` shades, which were referenced in 157 places across 40 HTML files but never defined, causing tier badges, status pills, and inline alerts to render with invisible text in both light and dark modes (the fallback chain resolved to invalid declarations, inheriting page text color). Examples: certification tier badges (`/admin/certification`), `interest-very_high` status pills, "this action cannot be undone" merge warnings, validation result colors. Adding the tokens fixes all 157 in one CSS change.

**Native form element defaults** — adds a global `input, select, textarea { color: inherit; }` rule. Browsers default native form text to black, which made `<select>` elements invisible against dark surfaces in dark mode. Inheriting the page text color makes selects, inputs, and textareas readable in both themes regardless of per-page styling. Also adds `color-scheme: light dark` to `html` (with explicit `light` / `dark` overrides under `[data-theme]`) so browsers render native scrollbars, dropdown chrome, autofill UI, and date pickers in the correct theme.

**Tightens dark-mode button-secondary contrast** — increases dark-mode `--color-bg-button-secondary` from gray-700 to gray-600 (`#4b5563`) and hover from gray-600 to gray-500 (`#6b7280`). Previous values produced only 1.94:1 surface contrast against the page bg, making secondary buttons blend into the page. New values give ~2.65:1 surface contrast — visibly distinct buttons.

**Migrates `--color-primary-50/100/200` raw-palette surface backgrounds to `var(--color-brand-bg)`** across ~30 files (~45 instances): active/selected/hover states on cards and rows, info boxes, callouts, drop zones, banner panels, settings stat-cards, hubs, walkthrough callouts on story pages, etc. These were producing "jarring pale-blue rectangle on dark page" in dark mode because the raw primary palette doesn't swap. Inline badges, pills, tags, chips, and small status markers (`.badge-*`, `.tag-*`, `.role-*`, `.stage-*`, `.action-type-*`) that pair `primary-100` bg with `primary-700`/`brand` text are intentionally left alone — they work in both modes as small colored markers and meant to read as eye-catching status indicators.

**JS-injected nav components** (`nav.js`, `admin-nav.js`, `dashboard-nav.js`) — migrate embedded `<style>` strings off hardcoded `color: white`, `background: #fff`, raw palette and `rgba(0,0,0,0.05)` hover overlays onto the new semantic tokens. Fixes navbar surface, links, dropdowns, account button, notification bell + badge + items, mobile menu, marketing opt-in modal across every authenticated page. Always-dark footer (`#1b1b1d`) intentionally left as-is.

**admin-accounts.html** (the screenshot file) — kills 9 `var(--aao-white)` usages, swaps raw-palette backgrounds across view-tabs, bulk-actions, filters, table headers/rows/borders, status pills, owner select, activity feed, search results, enrichment cards, hierarchy badges, attention badges. Removes local `.btn-secondary` override that was shadowing the global fix.

**Heavy admin pages** (`admin-account-detail.html`, `admin-addie.html`, `admin-users.html`, `admin-domain-health.html`) — same pattern across forms, tables, status badges, modals, inline cards, and inline `style="..."` attributes.

**Dashboard + builders** (`dashboard.html`, `brand-builder.html`, `adagents-builder.html`) — same pattern across status pills, toasts, certification UI, agreement viewers, profile radios, agent/property entries, JSON previews.

**Stories pages and JS-injected member cards** (`stories/the-pitch.html`, `stories/the-shelf.html`, `stories/the-studio.html`, `stories/index.html`, `member-card.js`, `join-cta.js`) — same pattern. Story-narrative accent colors (`#14b8a6`, `#047857`) deliberately retained as structural design accents; story hero `#fff` text on saturated dark gradients retained as intentional.

**Sweep across remaining public-site, admin, dashboard, community, membership, working-groups, perspectives, latest, and legal HTML** — bulk replacement of common raw-palette → semantic patterns identified by the contrast audit.

**Intentionally not changed:** always-dark footer surfaces, `.creative-html-container` ad-iframe (must not be themed), logo containers requiring white sprite background, toggle-slider thumbs, vendor brand identity literals (Slack purple, Stripe colors), saturated success/warning/error/info-500/600 backgrounds with `--color-text-on-dark` text (intentional saturated accents).

**Light-mode behavior is preserved:** every replacement uses tokens that resolve to identical values in light mode and add the missing dark-mode variant. No new hardcoded color values introduced.

**Follow-ups noted but out of scope:**
- Some admin pages use `var(--color-*-100)` bg with `var(--color-*-700)` text for non-success/warning/error pill colors that don't have `-bg`/`-fg` swap pairs yet.
- A handful of legacy `--aao-*` aliases remain in use; full retirement deferred.
- Box-shadows using `rgba(0,0,0,...)` are nearly invisible on dark surfaces — design system may want `--shadow-*` swap variants in a follow-up.
- A few raw `var(--color-primary-50)` / `--color-primary-100)` selection highlights in less-trafficked surfaces.
