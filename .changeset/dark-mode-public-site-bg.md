---
---

Public AAo site dark-mode pass.

**Backgrounds:** replace hardcoded `#fff`/`white` and raw-palette (`--color-gray-50/100`, `--color-*-50`) bgs with semantic, dark-mode-aware tokens (`--color-surface`, `--color-bg-subtle`, `--color-bg-card`, `--color-brand-bg`).

**Text:** replace raw `--color-gray-600/700` with semantic `--color-text` / `--color-text-secondary`.

**Tag/badge color pairs:** add new semantic aliases `--color-success-bg/-fg`, `--color-warning-bg/-fg`, `--color-error-bg/-fg` to design-system.css. Light mode aliases the existing `-100`/`-700` palette; dark mode swaps to translucent rgba bg + lighter `-300/200` text. Update `.status-badge`, `.track-pill`, `.brand-card__source--valid`, `.badge-regulation/must/standard/should/may`, member-card.js `.visibility-badge.public`, `.agent-badge`, `.data-provider-badge`, agents.html `.tool-error-box`, `.publisher-warning`, `.publisher-item--unverified`, and `.ds-pill.active` to use them. Brand-card `.brand-card__tag`, member-card `.offering-tag`, and `.publisher-badge` switch to `--color-brand-bg` / `--color-brand`.

**Files:** layout.css, design-system.css, member-card.js (JS-injected styles), and per-page styles in agents/brands/certification/committees/events/members/policies/publishers, community/hub + membership/hub, and stories/the-pitch + the-shelf + the-studio. Activity-metric stat cards switch from raw pastel fills to a left-border accent over `--color-bg-subtle`.

Also bundles a docker-compose fix (`ALLOW_DEV_MODE_IN_PROD=true`) needed for local Docker boot — auth.ts refuses to start when `DEV_USER_*` and `NODE_ENV=production` are both set, and the compose file was missing the documented override.
