---
---

Add dark mode support to the Addie web chat interface. The design system now includes a `@media (prefers-color-scheme: dark)` token override block plus `html[data-theme="dark|light"]` attribute selectors for manual preference. chat.html respects the system preference automatically and exposes a sun/moon toggle button in the chat header that persists the choice to localStorage. Inline ad creative containers intentionally remain white (third-party content has its own contrast model).
