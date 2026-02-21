---
"adcontextprotocol": patch
---

Download brand logos from Brandfetch CDN to our own PostgreSQL-backed store when enriching brands. Logos are served from `/logos/brands/:domain/:idx` so external agents can download them without hitting Brandfetch hotlinking restrictions.
