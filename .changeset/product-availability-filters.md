---
"adcontextprotocol": minor
---

Add comprehensive filters to get_products request for efficient product discovery.

Enables buyers to filter products by campaign requirements and constraints:
- **start_date/end_date**: Campaign date range for availability checks (ISO 8601 date format)
- **budget_range**: Min/max budget range to filter appropriate products
- **currency**: ISO 4217 currency code for budget filtering
- **countries**: Target countries using ISO 3166-1 alpha-2 codes for geographic filtering
- **channels**: Advertising channels using existing channels enum (display, video, audio, native, dooh, ctv, podcast, retail, social)

These optional filters allow sales agents to short-circuit expensive NLP processing and immediately return only relevant products, significantly improving product discovery efficiency and response times. The channels and countries filters match the same format used in list_authorized_properties for consistency.
