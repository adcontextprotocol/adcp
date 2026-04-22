---
---

Strip `"adcontextprotocol": patch|minor` frontmatter from 22 changesets that describe website, admin, newsletter, digest, Addie, or server-infra work. These were mislabeled as protocol bumps and would have polluted the 3.0.0 stable CHANGELOG with non-protocol entries. Converting to empty changesets preserves the PR trail while keeping them out of the published spec changelog.

Affected: newsletter-admin-v2, oauth-dashboard-connect, org-dashboard-redesign, the-build-admin, regenerate-button, archive-route-fix, digest-content-fixes, digest-dedup-wg-fix, digest-prod-fixes, legal-pumas-smell, personalized-nudge, this-edition-split, major-zebras-go, fix-membership-route, fix-billing-errors, fix-dollar-sign-math, primary-email-select, 403fda3d22b05cdb, drop-jest-for-vitest, addie-event-attendees, event-tools-for-all, drop-redundant-assertion-modules.
