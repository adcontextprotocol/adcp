---
---

fix(addie): disambiguate auth failure from empty capabilities in recommend_storyboards

When `recommend_storyboards` received an empty capabilities response while using saved
or OAuth credentials, it incorrectly told the user their agent hadn't declared
`supported_protocols` or `specialisms`. The actual cause was an auth failure — the agent
served its anonymous response because the credentials didn't reach it.

The fix adds a pre-check: if `resolved.source` is `saved`, `oauth`, or `explicit`, an
empty capabilities response emits an auth-failure diagnosis (verify credentials, re-save,
check SDK version) instead of the developer-coaching path. The coaching path is now
reached only when no credentials were expected (`source === 'none'` or `'public'`).

Also adds `_Using saved OAuth credentials._` header parity for the OAuth source (previously
only the `saved` source printed a credential indicator).
