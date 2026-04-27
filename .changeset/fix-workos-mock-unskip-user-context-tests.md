---
---

Fix WorkOS mock shape in user-context integration tests and narrow `getWebMemberContext` error handling so non-existent users return 404 instead of empty 200, while transient WorkOS errors leave authenticated sessions unaffected. Unskips all 10 tests in `user-context.test.ts`.
