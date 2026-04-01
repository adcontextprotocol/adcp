---
---

Billing tools: add invoice backdating (invoice_date, due_date) and configurable payment terms (net-30/45/60/90) to send_invoice and confirm_send_invoice. Fixes timezone bug where midnight UTC rendered as previous day on Stripe invoice PDFs.
