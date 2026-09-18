---
"adcontextprotocol": patch
---

Test kits declare the account their storyboards address. `acme-outdoor` and `nova-motors`
now carry an `account:` block naming the operator (and both sandbox spellings) that
account-bearing steps send, so a seller implementing a kit can seed the accounts those
steps reference instead of inferring them from the storyboards' sample requests. Closes the
seeding half of #7588, where one unseeded account produced 19 check failures attributed to
the tools the steps name rather than to the account they could not resolve.
