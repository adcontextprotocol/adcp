---
"adcontextprotocol": minor
---

Add structured business entity data to accounts and media buys for B2B invoicing. New `billing_entity` field on accounts provides default invoicing details (legal name, VAT ID, tax ID, address, contact, bank). New `invoice_recipient` on media buys enables per-buy billing overrides. Add `billing: "advertiser"` option for when operator places orders but advertiser pays directly. Bank details are write-only (never echoed in responses).
