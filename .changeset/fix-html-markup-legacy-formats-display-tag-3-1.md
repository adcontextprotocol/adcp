---
"adcontextprotocol": patch
---

Erratum: the AAO reference catalog now projects the HTML-markup legacy formats (`display_html` and `display_WxH_html`) to `display_tag` with an `html_creative` (`html`) slot instead of `html5`. The old annotation contradicted rule 5 of `canonical-projection-ref.json`: these formats require HTML markup, while the `html5` canonical's slot is a zip bundle. The catalog also publishes `display_320x50_html` and `display_300x50_html` with the same mapping. No schema changes. 3.1 SDKs that read the corrected catalog project these formats to `display_tag` instead of `html5`.
