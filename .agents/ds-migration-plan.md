# Design system migration plan — AdCP public site

**Status:** Living doc, iterated with Claude
**Owner:** Katie
**Companion docs:** `.context/component-audit.md` (component inventory — gitignored, workspace-local), PR #3688 (foundational contrast fixes)

---

## Context

The public site under `server/public/` is **112 hand-written HTML pages** (verified 2026-05-01) serving both AgenticAdvertising.org Foundation and the AdCP authenticated app surfaces. Structural problems documented in `.context/component-audit.md` — numbers re-verified and **the trend is worsening, not stable**:

| | Audit (original) | Today (2026-05-01) | Trend |
|---|---|---|---|
| Inline `style="..."` attributes | 3,561 | **3,740** | +5% |
| Files with inline styles | 86 | **101** | +17% |
| Files using `.btn-*` | 56 | **93** | +66% |
| Files using `.ds-btn-*` | 0 | 3 | minor uptake |
| `--aao-*` legacy token usages | (unspecified) | 72 across 5 files | confirmed still in use |

Heaviest pages stable: `dashboard.html` 405 inline styles, `admin-addie.html` 316, `admin-account-detail.html` 308.

Other structural issues (unchanged):
- `.stat-card` redefined identically in 14 admin files; modals in 30 files; forms in 32 files
- Two parallel footer systems (`.footer-*` vs `.aao-footer-*`)
- JS-injected nav (`nav.js`, `admin-nav.js`, `dashboard-nav.js`) ships CSS as embedded `<style>` strings
- No automated visual regression, no component catalog, no compile-time token validation

**Dead code found while vetting:** `server/public/org-index-old.html` is not referenced anywhere in `server/src/`. Delete before migration; don't count in scope.

**Plan:** migrate the public site to React + TypeScript with shadcn/ui + Tailwind, served by the existing Express server. The legacy design system stays intact during migration; coexistence is the model. Backend, API surface, auth, and deployment target do not change.

---

## Stack

The infrastructure layer aligns with `agentic-api/apps/ui` (verified 2026-05-01). The styling layer deliberately diverges for public-repo IP discipline.

**Aligned with agentic-api/apps/ui:**
- **Build:** Vite + React 18 + TypeScript
- **Routing:** TanStack Router (file-based, type-safe)
- **Server state:** TanStack Query
- **Forms:** react-hook-form + zod (new for AdCP — current forms are hand-coded JS validation, no zod)
- **Tests:** Vitest + Playwright + @axe-core/playwright
- **Lint:** Biome

**Aligned with agentic-api/packages/mcp-apps (closer analog for component library):**
- **Component preview:** **Ladle** (`@ladle/react`) — lightweight Storybook alternative; matches existing team tooling muscle memory.
- **Component pattern:** Tailwind + Radix UI + class-variance-authority + clsx + tailwind-merge — same shadcn-pattern stack `mcp-apps` uses.

**Deliberately diverges from agentic-api/apps/ui:**
- **Component library:** **shadcn/ui** (vs agentic-api's MUI + private `@scope3data/ds`). AdCP is a public repo — cannot depend on private Scope3 packages.
- **Styling:** **Tailwind CSS** (vs agentic-api's Emotion), with config sourcing CSS variables from existing `design-system.css`.
- **Hosting:** existing Express on Fly.io (vs agentic-api's Cloudflare Workers).
- **Package manager:** stays on **npm** (vs agentic-api's pnpm + turbo monorepo). AdCP's existing `apps/desktop/` is npm with its own `package.json` + `package-lock.json` — `apps/web/` follows that pattern. **Do not migrate to pnpm/turbo as part of this work.**

**Bundle behavior:** Express serves React `index.html` for routes in a `MIGRATED_ROUTES` allowlist; everything else continues to serve `server/public/<page>.html`.

**Deliberately not chosen:** Next.js (deploy story change), Astro (revisit for marketing if bundle is an issue), Style Dictionary (overkill).

---

## Coexistence model

Legacy and React run side-by-side until migration completes:

- `design-system.css` stays. Tailwind config references its CSS variables, so dark mode swap behavior ports for free.
- Existing static HTML pages keep working unchanged.
- `MIGRATED_ROUTES` allowlist on Express decides per-route: serve React `index.html`, or serve legacy HTML.
- Migration of a route = delete `<page>.html`, add `apps/web/src/routes/<page>.tsx`, add to allowlist. **Replace-then-delete, never delete-then-replace.**

---

## File structure

```
apps/web/
  index.html
  package.json
  vite.config.ts
  tailwind.config.ts
  src/
    main.tsx
    routeTree.gen.ts
    routes/                 # File-based routing (TanStack Router)
    components/
      ui/                   # shadcn primitives
      layout/               # AppLayout, AdminLayout, DashboardLayout, MarketingLayout
      composite/            # Nav, AdminNav, DashboardSidebar, Footer
      domain/               # MemberCard, AgentCard, StatCard, etc.
    hooks/
    queries/                # TanStack Query hooks per resource
    api/                    # Fetch wrapper with CSRF + retry built in
    lib/utils.ts
    styles/app.css

server/public/              # Existing static HTML (shrinks as routes migrate)
server/src/                 # Express API + page-routing layer
```

---

## Function-preservation rule

Default behavior on every migration PR: **replicate exactly, even if the existing behavior was accidental browser default**. Modernizing the behavior requires an explicit call-out in the PR. Without this default, every PR re-litigates "what did the old page do?"

---

## Risks — vetted against actual code

This section captures issues we've checked against real code. Each entry says: what we worried about, what we found, and what (if anything) the migration needs to do.

### ✅ Risk: form POST → 302 redirect — **NOT A RISK**

**Worry:** if existing forms use `<form method="POST" action="...">` returning 302, React + TanStack Query (which expects JSON) breaks them.

**Vetted:** `grep <form` across `server/public/` — 40 forms, 27 files, **zero use `method="POST"`**. Every one is `event.preventDefault()` + JS-built JSON object + `fetch`. Forms already work the way React would.

**Migration impact:** mechanical. Replace `document.getElementById(...).value` reads with react-hook-form state. Replace handcrafted `fetch` with TanStack Query mutation. No backend changes needed.

### ✅ Risk: CSRF token plumbing — **NOTHING TO DO, IT JUST WORKS**

**Worry:** if forms today read a server-rendered hidden CSRF input, React doesn't get that for free.

**Vetted:** `server/public/csrf.js` monkey-patches `window.fetch`: reads `csrf-token` cookie (non-httpOnly), sets `X-CSRF-Token` header on state-changing requests, handles 403 retry with fresh token from response body. Server validates double-submit in `server/src/middleware/csrf.ts`. The script is loaded into every HTML page by `server/src/utils/html-config.ts:115`.

**Migration impact:** none. Keep `csrf.js` loaded into the React `index.html` (same injection that adds `__APP_CONFIG__`). Because it monkey-patches the global `window.fetch`, **every TanStack Query mutation, every react-hook-form submit, every direct `fetch` call gets CSRF + retry transparently.** No TS API client wrapper needed. Don't port the logic — just keep loading the script.

### ✅ Risk: auth gating — server redirect vs client check — **HYBRID MODEL EXISTS, PRESERVE IT**

**Worry:** if migrated routes serve React `index.html` to unauthenticated users, the React app mounts, then redirects → flash of unauthorized content. Today, server-protected routes don't have this flash.

**Vetted:** Two coexisting patterns today:
1. **Server-protected** (`/admin/*`): Express `requireAuth` redirects 302 to `/auth/login?return_to=...` *before* serving HTML. No flash. (`server/src/middleware/auth.ts:833-857`, `server/src/http.ts:4625-4659`.)
2. **Client-checked** (`/dashboard/*`, `/community/*`, `/membership/*`): Express uses `optionalAuth`, injects `<script>window.__APP_CONFIG__={user: {...} | null}</script>` into HTML via `server/src/utils/html-config.ts:86`. JS reads it, redirects client-side if null. (Brief flash of empty content on cold load — already today's behavior.)

**Migration impact:**
- Express templates `apps/web/dist/index.html` at request time, injecting the same `<script>window.__APP_CONFIG__={...}</script>` (small middleware change, ~5 lines). React reads `window.__APP_CONFIG__` at boot and hydrates TanStack Query auth state. **No extra fetch round-trip; no UX regression.**
- The `MIGRATED_ROUTES` allowlist must carry per-route auth metadata, not just a path:

```ts
const MIGRATED_ROUTES = [
  { path: '/admin/feeds', auth: ['requireAuth', 'requireAdmin'] },
  { path: '/dashboard/agents', auth: ['optionalAuth'] },
];
```

The React-serving handler chains the declared middlewares before serving `index.html`. Server-protected routes run `requireAuth` first → 302 if not logged in → no flash. Client-checked routes get `optionalAuth` + inlined config → React redirects via TanStack Router.

**Action items for Stage 0:**
- Build the templated `index.html` server with `__APP_CONFIG__` injection.
- Define the `MIGRATED_ROUTES` allowlist shape (path + auth middleware list).
- React boot reads `window.__APP_CONFIG__` and seeds TanStack Query.
- Document the per-route migration step: copy the existing route's middleware list into the allowlist entry.

### ✅ Cross-boundary navigation — **NOT A RISK, STAGE 0 DELIVERABLE**

This isn't an ongoing risk to monitor — it's a one-time piece of infrastructure to build in Stage 0. After that, every PR is safe by construction.

**Original worry:** React `<Link>` does soft client-side nav. Linking to an unmigrated route via `<Link>` would 404 in TanStack Router because no matching route exists in the React app.

**Vetted (surface sizing):**
| Pattern | Count | Cross-boundary safe? |
|---|---|---|
| `<a href>` | 721 across 98 files | ✅ Browser-driven full nav |
| `window.location.href = '...'` | 105 across 40 files | ✅ Full nav |
| `history.pushState` | 22 across 13 files | ✅ Query-param updates, not real nav |

All existing navigation is full-page nav. No legacy HTML can produce the cross-boundary 404 — browser always hits Express, Express routes correctly. The risk only lives in new React code.

**Solution — `RouteLink` wrapper:**

```tsx
// apps/web/src/components/RouteLink.tsx
function RouteLink({ to, ...props }: Props) {
  if (isMigratedRoute(to)) return <Link to={to} {...props} />;
  return <a href={to} {...props} />;
}
```

- Inside React, **always** use `<RouteLink>`, never `<Link>` directly.
- `isMigratedRoute(...)` reads `window.__APP_CONFIG__.migratedRoutes` injected by Express (same templating that injects `user`). Always live.
- When a route migrates, every link to it auto-upgrades from full-nav to soft-nav. No per-PR judgment.
- Custom lint rule (Biome) or CI grep bans bare `import { Link } from '@tanstack/react-router'` outside the `RouteLink` definition file.

**JS-injected nav scripts** (`nav.js`, `admin-nav.js`, `dashboard-nav.js`) keep generating `<a href>` tags — full nav, no conflict during transition. Retire them in Stage 5 when `<Nav>` / `<AdminNav>` / `<DashboardSidebar>` ship.

**Action items for Stage 0:**
- Build `RouteLink` component.
- Inject `migratedRoutes` into `__APP_CONFIG__` from Express.
- Add lint rule banning direct `<Link>` imports.

### 🟡 Risk: inline `onclick` / `onchange` handlers — **MANAGEABLE, NEEDS DISCIPLINE**

This is the first risk that's actually a per-PR concern, not a one-time fix.

**Vetted (surface sizing):**
- 1,060 inline `onclick` across 83 files
- 217 other inline handlers (`onchange`, `oninput`, `onblur`, etc.) across 37 files
- Heaviest pages: `admin-addie.html` (88), `admin-account-detail.html` (73), `brand-builder.html` (115 total), `admin-content.html` (50), `admin-users.html` (46), `dashboard.html` (45)

**Key finding:** sampled handlers are almost always 1-line calls to named functions defined in the page's `<script>` block (`onclick="openEditModal()"`, `onclick="toggleSection(this)"`). The 1,060 onclicks aren't 1,060 unique behaviors — they're handlers calling a much smaller function set. Complexity lives in the JS functions, not the HTML attributes.

**Translation pattern:**
```html
<!-- Before -->
<button onclick="openEditModal()">Edit</button>
```
```tsx
// After
<Button onClick={() => setEditModalOpen(true)}>Edit</Button>
```

Mechanical for the HTML side. The functions are where work happens — many do imperative DOM mutation:

```js
function runAIEnrichment() {
  document.getElementById('aiEnrichBtn').textContent = 'Loading...';
  fetch('/api/...').then(() => location.reload());
}
```

That converts to React state (loading/error/success), TanStack Query mutation, and component-level re-render — declarative instead of imperative.

**Per-PR translation rule (document and enforce):**
- Any function reading/writing `document.getElementById(...).style/textContent/classList/innerHTML` is imperative DOM. Convert to React state.
- Modal/dropdown semantics: default to shadcn `<Dialog>` / `<DropdownMenu>` which handle ESC, backdrop, focus correctly. If a current page *intentionally* deviates (e.g., backdrop click doesn't close), flag it and preserve.
- `event.stopPropagation()` cases: preserve carefully — careless translation can let a parent handler fire that previously didn't.
- `event` is implicit param in inline handlers (`onclick="foo(event)"`). React passes it to the handler function — sig must accept it.

**Page-ordering rule for Stage 2:**
- Stage 1 pilot: pick a page with ~20-50 handlers (moderate complexity) so the translation pattern is exercised at scale before being repeated 50 times.
- Stage 2: order admin migration by handler count, simplest first. Heaviest pages (`admin-addie`, `admin-account-detail`, `dashboard`, `brand-builder`) migrate last and get manual click-through QA on every onclick path.

**Action items for Stage 0:**
- Write the translation pattern doc (1 page in `apps/web/CONTRIBUTING.md` or similar).
- Build a shared modal pattern using shadcn `<Dialog>` to standardize.

### 🟡 Risk: SEO / meta tags / OG cards on marketing pages — **TBD, NEEDS VETTING**

Each marketing HTML has its own `<title>`, meta description, OG image. React app needs head management (TanStack Router head support or `react-helmet`). Easy to silently regress. Address explicitly in Stage 5.

### ✅ Risk: server-side template variables — **ESSENTIALLY NONE**

**Worry:** if any HTML file is server-templated (EJS, handlebars, string-replaced env vars), React migration needs an API endpoint to provide that data.

**Vetted:** No EJS/handlebars/pug/`res.render` anywhere. The only server-side templating is `server/src/utils/html-config.ts:106-123` injecting four scripts before `</head>`:
1. `<script>window.__APP_CONFIG__={...}</script>` (user, auth, posthog config)
2. `<script src="/csrf.js"></script>`
3. Early-error-buffer + PostHog init scripts (if PostHog configured)

The dashboard handler (`server/src/http.ts:1830-1833`) has `{{STRIPE_*}}` token replacement, but **no HTML file currently uses those tokens** — it's dead code from a previous Stripe integration. Delete in Stage 5.

**Migration impact:** none beyond the auth/config injection already planned. React `index.html` runs through the same `injectConfigIntoHtml` helper. All four scripts ride along automatically. No new API endpoints needed.

**Action items for Stage 5:**
- Delete dead `{{STRIPE_*}}` replacement code in `http.ts:1830-1833`.

### ✅ Risk: service worker / cache — **NOTHING TO DO**

**Worry:** if the site registered a service worker, it would cache old HTML through the migration and silently undo deployments.

**Vetted:** No service worker anywhere. No `sw.js`, no `service-worker.js`, no `navigator.serviceWorker.register`, no Workbox, no `manifest.json`, no `<link rel="manifest">`.

Cache headers are already correct: HTML pages get `no-store, no-cache, must-revalidate, proxy-revalidate` (`server/src/http.ts:778, 899, 1807`); static assets get appropriate long-cache headers.

**Migration impact:** apply the same rule when Express serves `apps/web/dist/index.html`: no-cache on the entry HTML, long-cache on the hashed `apps/web/dist/assets/*` bundles. Vite produces content-hashed asset filenames by default, so the long-cache rule is safe automatically.

---

## Theming — standard shadcn, values copied at Stage 0

**Decision (revised after vetting):** do NOT bridge `design-system.css` to Tailwind at runtime. Use shadcn's standard theme setup.

- shadcn ships with a CSS-variable theme in `globals.css` (`--background`, `--foreground`, `--primary`, `--muted`, etc.). Use it as-is — that's where shadcn components read from.
- At Stage 0: **copy color / spacing / radius / typography values** from `design-system.css` *into* shadcn's `globals.css` and customize `tailwind.config.ts` against them. One-time copy, not a runtime bridge.
- `design-system.css` continues to power legacy HTML pages (unchanged).
- React app uses shadcn's theme exclusively.
- Stage 5 deletes `design-system.css` along with the legacy HTML.

**Why standard shadcn is better than a bridge:**
- AI/Claude works much better on standard shadcn — important for ongoing dev velocity.
- One mental model, not three layers of indirection (shadcn class → Tailwind utility → CSS variable from another file).
- No lost token work — the 4 months of decisions were about *values*; we keep them by copying.
- shadcn dark mode support is built-in; configure once.

**Coexistence is fine.** Two theme systems run side-by-side during migration but scoped to different DOM trees (legacy HTML pages use design-system.css; React pages use shadcn theme). They don't conflict.

**Note on existing JSON schemas:** `static/schemas/` contains JSON Schema files for the AdCP protocol spec (account, creative, brand, etc.) — **not zod schemas**. Current forms don't use zod at all (hand-coded JS validation today). Migration introduces zod usage fresh in `apps/web/`. For forms that map 1:1 to a protocol type, derive zod schemas from JSON Schemas via `json-schema-to-zod`. Otherwise hand-write per form.

### Token convention exceptions to revisit (post-Stage 0, fine for now)

shadcn's documented rule: tokens without `-foreground` are background/surface colors; `-foreground` siblings are the text/icon color paired with them. We follow this rule everywhere except three categories below — all are recognized shadcn-shipped patterns where the *value* fits even though the *role* doesn't. None block adoption; revisit if/when they cause real friction.

1. **Surface-as-text for brand emphasis.** `Button.link` and `Badge.link` use `text-primary`; `RadioGroupItem` indicator uses `text-primary` + `fill-primary` for the selected dot. There's no `--primary-as-text` token and using `--primary-foreground` (white) here would be wrong. Files: `button.tsx:21`, `badge.tsx:27`, `radio-group.tsx:30,39`.

2. **Inverse-surface pattern.** `Tooltip` (`bg-foreground text-background`) and bits of `Switch` thumb (`dark:bg-primary-foreground`, `dark:bg-foreground`) and `Tabs.line` underline (`after:bg-foreground`) leverage that foreground tokens *happen to be* light values in dark mode and dark values in light mode — flipping them produces a high-contrast inverted surface. A clean fix would be introducing inverse-surface tokens (`--inverse`, `--inverse-foreground`); not worth doing yet. Files: `tooltip.tsx:45,51`, `switch.tsx:26`, `tabs.tsx:68`.

3. **Border-as-bg for separator lines.** `Separator`, `DropdownMenuSeparator`, `SelectSeparator` use `bg-border` to render thin divider lines. Conceptually a separator is a border rendered as a `<div>`; Tailwind has no general-purpose `divide-color-{token}` for this. Files: `separator.tsx:20`, `dropdown-menu.tsx:171`, `select.tsx:135`.

**Decision:** leave all three as-is through migration. If we ever introduce inverse-surface tokens, (2) is the natural cleanup. (1) and (3) likely stay forever.

---

## Component scope

shadcn primitives (initial set):
Button, Card, Dialog, Sheet, Popover, Dropdown Menu, Tooltip, Tabs, Toast, Form, Input, Textarea, Select, Combobox, Checkbox, RadioGroup, Switch, Label, Separator, Avatar, Badge, Alert, AlertDialog, Table, Skeleton, ScrollArea, Progress.

Custom layout: `AppLayout`, `AdminLayout`, `DashboardLayout`, `MarketingLayout`, `Footer`, `Nav`, `AdminNav`, `DashboardSidebar`, `RegistrySubNav`.

Custom domain: `MemberCard`, `AgentCard`, `PublisherCard`, `BrandCard`, `JoinCtaCard`, `AchievementCard`, `StatCard`, `CredentialTierBadge`, `PerspectiveCard`, `StoryCard`, `EventCard`, `MeetingCard`, `WorkingGroupCard`, `OrgPicker`, `ProfileCompletenessCard`, `MemberHubHero`, `HomepageHero`, `StoryPanel`, `LogoCarousel`.

Form patterns: `FormField`, `FormFieldArray`, `MultiCountryAutocomplete`, `BrandPicker`, `OrgPicker`.

Audit identified ~40 distinct visual patterns; library covers them in ~50 components.

---

## Test strategy

Visual regression is the gate for "preserve functionality":

1. Before Stage 0 ends: Playwright + @axe-core/playwright suite covering ~30 critical-path screenshot tests against current static HTML, light + dark.
2. Per-page migration PR runs the suite. Migrated page diffed against baseline. Acceptable diffs reviewed and re-baselined; unacceptable diffs block.
3. axe-core flags AA contrast failures, missing labels, focus issues. Blocks merge.
4. Vitest for component logic, especially form validation and data transforms.
5. Heaviest authenticated flows (billing, OAuth signup, member onboarding, admin actions) get manual click-through QA before their PRs merge.

**Cosmetic-diff allowlist:** hand-written HTML → React+Tailwind will produce some sub-pixel margins, font rendering, CSS specificity-ordering differences. Maintain an allowlist with explicit reasoning, not a free-for-all "looks fine" rubber-stamp.

---

## Migration sequencing

Each stage ends with a decision gate.

### Stage 0 — Foundation + primitives + rules (~1.5 weeks)

This stage absorbs what was previously a separate "component library buildout" stage. Goal: a fully-styled primitive set in Ladle, conventions documented, pipeline proven — before any page migrates.

**Scaffolding:**
- `apps/web/` with Vite + React + TS + TanStack Router + TanStack Query + Tailwind. Follows `apps/desktop/` npm pattern (own `package.json`, no pnpm/turbo).
- shadcn init via CLI. Install all ~30 primitives upfront: Button, Card, Dialog, Sheet, Popover, Dropdown Menu, Tooltip, Tabs, Toast, Form, Input, Textarea, Select, Combobox, Checkbox, RadioGroup, Switch, Label, Separator, Avatar, Badge, Alert, AlertDialog, Table, Skeleton, ScrollArea, Progress.
- Ladle setup mirroring `agentic-api/packages/mcp-apps/.ladle/`.
- Express handler serving `apps/web/dist/index.html` for routes in `MIGRATED_ROUTES` allowlist (with per-route auth middleware metadata).
- React `index.html` includes placeholders `<div id="adcp-nav">` and `<div id="adcp-footer">` so legacy `nav.js` keeps wrapping React-served pages.
- Vite proxy for `/api`, `/auth`, `/mcp`, `/a2a`, `/.well-known` → Express dev server.
- `RouteLink` wrapper component + Biome lint rule banning bare `<Link>` imports.
- Express injection of `__APP_CONFIG__` (user, posthog config, `migratedRoutes` list) into React `index.html` — same `injectConfigIntoHtml` helper used today.
- `csrf.js` script tag ride-along (no TS port needed; monkey-patches React's fetches transparently).

**Theming + primitives in Ladle:**
- Copy color, spacing, radius, typography values from `design-system.css` into shadcn's `globals.css`. One-time copy, not a runtime bridge.
- Tailwind config customized to match.
- Light + dark mode configured via shadcn's standard pattern.
- Ladle story for every primitive — variants, sizes, states (loading, disabled, error). This is where styling decisions get nailed down.
- Delete `.ds-*` namespace from `design-system.css` (audit confirms it's nearly unused).

**Conventions doc** (`apps/web/CONTRIBUTING.md` or similar) — these rules govern every page PR:
1. Inline-handler translation: Category 1 (UI toggle → `useState`), Category 2 (modal-with-prefill → state-driven render), Category 3 (API action → TanStack Query mutation).
2. Always use `<RouteLink>`, never bare `<Link>`.
3. Forms: react-hook-form + zod, no exceptions. For protocol-typed forms, derive zod from JSON Schemas in `static/schemas/` via `json-schema-to-zod`.
4. Auth gating: per-route middleware metadata in `MIGRATED_ROUTES`; no ad-hoc client-side auth checks in routes that are server-protected.
5. Theming: only shadcn CSS variables in React code; no hardcoded hex/rgb. Use `cn()` helper.
6. **New domain component → Ladle story in the same PR.** No exceptions. This is what keeps the library filling out as pages migrate.
7. Function preservation: replicate exactly unless the PR explicitly flags a deliberate change.

**Test infra:**
- Vitest harness real (smoke test on `cn()`); component-level tests land alongside Stage 1 pilot pages.
- GitHub Actions gate on `apps/web/**` paths: typecheck + biome lint (`--error-on-warnings`) + vitest + vite build. Independent of the root server precommit so `apps/web` has its own enforced CI even while server tests work through pre-existing ESM/CJS issues.
- Playwright + @axe-core/playwright with ~30 baseline screenshot tests against current legacy HTML.
- Visual regression also targets Ladle stories.

**Pipeline proof:** one trivial route (e.g., `/dev-login`) ported end-to-end.

**Gate:** Build succeeds, all tests run, dark+light modes work on trivial route, every primitive has a Ladle story Katie has signed off on, conventions doc complete, Express still serves all unmigrated routes correctly.

### Stage 1 — Pilot pages (~1-2 weeks)

Two-page pilot covering different shapes:

1. **`/admin/feeds`** (`admin-feeds.html`, 17 inline styles, 19 handlers) — pipeline shakedown. Confirms build, deploy, route allowlist, dark mode swap, visual regression, CSRF, `requireAuth + requireAdmin` middleware chain. Small enough to ship in ~2 days.
2. **`/admin/events`** (`admin-events.html`, 66 inline styles, 32 onclicks + 8 onchanges) — realistic-scale validation. Has modal-with-prefill (Category 2), action-with-API (Category 3), and react-hook-form/zod form fields. Forces the team to confront imperative-DOM-to-declarative-state translation before committing to 50 admin pages in Stage 3.

For each: port end-to-end (routes, components, queries, forms), visual regression diffs reviewed, manual QA on actions, feature-flagged via `MIGRATED_ROUTES` until verified.

**Gate:** Migration pattern works at realistic scale. Bundle size acceptable. PRs are reviewable. **This is the real commitment** — proceeding to Stage 2 commits to the migration.

### Stage 2 — Admin migration (~4-6 weeks)
- ~50 admin pages. Order: simplest first, heaviest last (the four monsters: `admin-account-detail` (308 styles, 73 onclicks), `admin-addie` (316, 88), `admin-users` (154, 46), `dashboard.html` (405, 45)).
- ~5-10 pages per week, gated by review bandwidth.
- Replace-then-delete pattern.
- Domain components emerge from page work — each new component gets a Ladle story in the same PR. After ~10 pages, the library naturally fills out.

**Gate:** Admin surface 100% migrated.

### Stage 3 — Dashboard + community + membership (~3-4 weeks)
- ~30 pages. Auth-coupled flows (billing, OAuth signup) get manual QA.

**Gate:** Authenticated app surfaces 100% migrated.

### Stage 3.5 — Marketing pre-pilot (~3-5 days)

Before Stage 4's full marketing migration, port one simple marketing page to flush out marketing-specific risks (bundle size, SEO/meta, OG card preservation):

- **`about.html`** (7 inline styles) — simplest marketing page; clean target.
- Establish patterns: TanStack Router head support (`<title>`, meta description, OG image), bundle analysis baseline for marketing.
- If bundle blows the budget here, evaluate Astro for marketing surface *before* Stage 4 commits.

**Gate:** Marketing migration pattern works. Bundle/SEO acceptable. Decide Vite-vs-Astro for the rest of marketing.

### Stage 4 — Marketing + content (~2-3 weeks)
- ~30-35 pages. Homepage, governance, learning, brand-protocol, story pages, perspectives, latest, legal.
- Pattern from Stage 3.5 applied. SEO/meta/OG handled per-page.

**Gate:** Public site 100% migrated.

### Stage 5 — Nav port + cleanup (~2-3 weeks)

The legacy `nav.js`, `admin-nav.js`, `dashboard-nav.js`, `admin-sidebar.js`, `member-card.js`, `join-cta.js` keep running on React pages throughout Stages 2-4 via placeholder divs. This stage finally replaces them with React equivalents and removes legacy infrastructure.

**Nav component port (~1-2 weeks):**
- `nav.js` (1,742 lines) → split into `<Nav>` + `<Footer>` + `<SubscribeForm>` + `<NotificationDropdown>` + `<MarketingOptInModal>` React components.
- `admin-nav.js` (156 lines) → `<AdminNav>`.
- `admin-sidebar.js` (460 lines) → `<AdminSidebar>`.
- `dashboard-nav.js` (942 lines) → `<DashboardSidebar>`.
- Preserve: cross-domain auth routing, Mintlify/iframe skip, marketing opt-in flow, notification dropdown logic.
- Remove placeholder `<div id="adcp-nav">` / `<div id="adcp-footer">` from React `index.html`; React renders nav directly now.

**Cleanup (~1 week):**
- Delete `--aao-*` legacy aliases (5 files use them; safe after admin/marketing migrations).
- Delete `.ds-*` namespace (audit shows it's nearly unused — committed to delete).
- Delete legacy JS-injected scripts: `nav.js`, `admin-nav.js`, `admin-sidebar.js`, `dashboard-nav.js`, `member-card.js`, `join-cta.js`.
- Delete dead `{{STRIPE_*}}` template-replacement code in `server/src/http.ts:1830-1833`.
- Remove `MIGRATED_ROUTES` allowlist; React serves everything except `/api/*`.
- Delete `server/public/*.html` (keep static assets: images, logos, fonts).
- Delete `design-system.css` (its values now live in shadcn's `globals.css`).

---

## Timeline (realistic)

Bottleneck is review bandwidth, not code-writing time.

| Stage | AI-paced code | Human review | Elapsed |
|---|---|---|---|
| 0. Foundation + primitives + rules | ~6 days | ~3 days | ~1.5 weeks |
| 1. Pilot pages (admin-feeds + admin-events) | ~3 days | ~2 days | ~1-2 weeks (gate) |
| 2. Admin migration | ~10 days | ~3 weeks | ~4-6 weeks |
| 3. Dashboard | ~6 days | ~2 weeks | ~3-4 weeks |
| 3.5 Marketing pre-pilot (about.html) | ~1 day | ~2 days | ~3-5 days (gate) |
| 4. Marketing | ~4 days | ~2 weeks | ~2-3 weeks |
| 5. Nav port + cleanup | ~7 days | ~5 days | ~2-3 weeks |
| **Total** | **~30 days** | **~10 weeks** | **~13-17 weeks** |

If Katie is at 80% capacity: 12-14 weeks. At 30%: 20+ weeks.

---

## What stays as-is

- Express server (`server/src/`)
- All API endpoints (`/api/*`, `/auth/*`, MCP, A2A)
- OAuth, session cookies, CSRF
- Mintlify docs — externally hosted at `docs.adcontextprotocol.org`; Express has 4 redirects to it (`http.ts:715, 1219, 2214, 2360`). No proxy layer; redirects stay as-is.
- Slack webhooks, email pipelines, scheduled jobs, registry sync
- Database, migrations
- Static assets (images, logos, fonts)
- `design-system.css` (powers legacy HTML pages until Stage 5 deletes it; React app uses shadcn's `globals.css` exclusively)
- Fly.io deployment
- `static/schemas/` JSON Schema files (AdCP protocol spec) — unchanged; they are *not* zod schemas, despite earlier plan claim

---

## Definition of done

1. All ~112 pages in `server/public/*.html` migrated to `apps/web/src/routes/` (minus `org-index-old.html` which gets deleted, not migrated)
2. `server/public/*.html` deleted (static assets stay)
3. JS-injected component scripts deleted (`nav.js`, `admin-nav.js`, `dashboard-nav.js`, `member-card.js`, `join-cta.js`, `admin-sidebar.js`)
4. `--aao-*` legacy aliases removed from `design-system.css`
5. `.ds-*` namespace removed in Stage 0
6. Playwright suite covers all migrated routes; passes in CI
7. axe-core passes WCAG AA on all migrated routes
8. Light + dark mode work on every migrated route
9. No runtime regressions in auth, billing, OAuth, MCP/A2A, registry, admin tools
10. Bundle budget met (specific numbers TBD after Stage 1 measurement)
11. One CSS source of truth: shadcn `globals.css` (theme variables) + Tailwind utilities, no per-page `<style>` blocks; `design-system.css` deleted

---

## Open questions

- **Bundle size budget** — Stage 0 baseline (empty router + all shadcn primitives loaded for Ladle): **96 kB gzip JS, 14 kB gzip CSS**. Set the budget at the end of Stage 1 once the first real pilot page (`admin-feeds`) is measured. Don't let this stay open past Stage 1.
- **`radix-ui` umbrella vs per-component `@radix-ui/*`** — currently using the umbrella (`radix-ui` ^1.4.3) for ergonomics. Heavier than per-component but tree-shakes well in practice. Hold the swap until Stage 1 bundle data shows the per-component split is worth the import-fanout cost; revisit if `admin-feeds` blows the budget.
- ~~Storybook (revisit after Stage 3)~~ — **resolved**: adopted Ladle in Stage 0, matching `agentic-api/packages/mcp-apps/`.
- `@adcp/sdk` consumption vs custom fetch wrappers (lean toward custom wrapper since CSRF logic must live there anyway)
- CI/CD interaction between `apps/web/dist` build and Fly.io deploy
- Migration freeze policy (dual-write new features into old + new, or freeze new features in `server/public/`)

---

## Iteration log

- **2026-04-30:** initial draft.
- **2026-05-01 (later):** Theme token cleanup pass against shadcn convention (`bg-X` = surface, `text-X-foreground` = text). Audited all 24 ui components. Normalized destructive: introduced `--destructive-on-color` (white, paired with solid `bg-destructive` in Button) and repurposed `--destructive-foreground` to the saturated red text used on tinted destructive surfaces (Badge, Alert). Migrated `text-destructive` → `text-destructive-foreground` in Form (label + message), DropdownMenu destructive item, Label required asterisk, and Input/Textarea error helpers in stories. Aligned Alert destructive to Badge color way (`bg-destructive/15 text-destructive-foreground`). Added `--success/--warning/--info` token pairs (mirroring `--destructive`) plus `success/warning/info/neutral` Badge variants — no more re-purposing `default`/`secondary` for status. Removed default Badge variant; default is now `info`. Light-mode `--muted`, `--muted-foreground`, `--accent`, `--accent-foreground`, `--secondary` re-pointed at slate (warmer than neutral). Added "System" section + alpha child swatches in the Color story so docs render the actual surfaces components produce (Tailwind v4 `color-mix` semantics). Captured three "exception" patterns that violate strict bg-vs-fg but ship in shadcn: surface-as-text (Button.link, Badge.link, RadioGroup), inverse-surface (Tooltip, Switch thumb, Tabs.line), border-as-bg-for-separator. All three left as-is.
- **2026-05-01:** dropped Brian sign-off framing (autonomy granted). Confirmed legacy + React coexistence model. Vetted form-POST risk against actual code — **dismissed**, all forms already JS+JSON. Vetted CSRF risk — **nothing to do, `csrf.js` monkey-patch wraps all fetches transparently including TanStack Query.** Vetted auth gating — **hybrid model preserved by per-route metadata in `MIGRATED_ROUTES` + inlined `__APP_CONFIG__`.** Vetted cross-boundary nav — **all legacy nav is full-page; risk only in new React `<Link>`. Solved by `RouteLink` wrapper + injected `migratedRoutes` allowlist.** Vetted inline handlers — **1,060 onclicks but mechanical translation; real risk is imperative→declarative DOM in the functions. Manageable with translation rule + page-ordering + manual QA on heavy pages.** Vetted server-side templating — **no per-page templating exists; only `__APP_CONFIG__` + script injections that ride along for free. Dead `{{STRIPE_*}}` replacement code to delete in Stage 6.** Vetted service worker / cache — **none exists; cache headers already correct; Vite content-hashed assets handle the rest.** Re-verified audit numbers — **trend is worsening** (+5% inline styles, +66% files using `.btn-*`); **page count corrected from ~150 to 112**; `org-index-old.html` is dead code, delete it. Vetted agentic-api alignment — **infra layer matches (Vite/TanStack/forms/tests/lint); styling deliberately diverges (shadcn+Tailwind vs MUI+Emotion+`@scope3data/ds`)**; AdCP stays on npm, follows `apps/desktop/` pattern. Pinned Stage 1 pilot — **`admin-feeds` (pipeline) + `admin-events` (realistic scale)**; added Stage 4.5 marketing pre-pilot using `about.html` to flush bundle/SEO risks before Stage 5 commits. Adopted **Ladle** for component preview (matches `agentic-api/packages/mcp-apps/`). Corrected three plan errors: **`static/schemas/` is JSON Schema not zod** (zod usage is new for AdCP); **no `acceptance-tests/` convention** here (set up Playwright fresh); **Mintlify is externally hosted not proxied** (just keep the redirects). Vetted JS-injected components — **5,292 total lines**; `nav.js` alone (1,742) is nav + footer + subscribe + notifications + marketing-opt-in modal + cross-domain auth + iframe/Mintlify skips; `member-card.js` is 3 components in one file; `admin-sidebar.js` was missed from plan list. Confirmed `--aao-*` cleanup safe (only 5 files, no external deps). **Two structural revisions after Katie pushback:** (1) **Drop the design-system.css ↔ Tailwind bridge.** Use standard shadcn theming; copy values from `design-system.css` into shadcn's `globals.css` once at Stage 0. AI-friendlier; no three-layer indirection. (2) **Defer all nav-component porting from Stage 2 to Stage 5.** `nav.js` injects into placeholder divs (`#adcp-nav`, `#adcp-footer`) — same placeholders work in React `index.html`. Legacy nav wraps React app during migration. **Third revision:** dissolved old "Stage 2 component library buildout" into Stage 0 (primitive theming + Ladle stories + rules) and per-page work (domain components emerge as needed; new component → Ladle story in the same PR). Total elapsed: 13-17 weeks (was 14-19).
