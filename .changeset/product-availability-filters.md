---
"adcontextprotocol": minor
---

Add availability and budget filters to get_products request.

Enables buyers to filter products by campaign dates and budget range:
- **start_date/end_date**: Campaign date range for availability checks (ISO 8601 date format)
- **budget_range**: Min/max budget range to filter appropriate products
- **currency**: ISO 4217 currency code for budget filtering

These optional filters help sales agents return only products that match the buyer's timing and budget constraints, improving product discovery efficiency.
