---
"adcontextprotocol": patch
---

Remove a literal tab character from a comment line in
`static/compliance/source/universal/runner-output-contract.yaml` (line 303).
Tabs cannot start a token in YAML, so strict parsers fail to load the file
entirely — platform engines consuming the packaged 3.1.4/3.1.5 compliance
caches could not parse the runner output contract. Comment text unchanged;
no semantic content changes.
