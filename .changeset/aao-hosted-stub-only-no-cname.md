---
---

Publisher self-service page now teaches `authoritative_location` stub
as the only supported AAO-hosting pattern, and stops mentioning CNAME
as a tradeoff option.

The previous copy hinted at CNAME / 301 redirect from the publisher's
`/.well-known/adagents.json` to AAO as an alternative with a "buy-side
note" caveat. That framing accommodates a pattern we explicitly don't
want to support: CNAMEing puts AAO behind the publisher's TLS, breaking
the spec's origin-attestation model — buyers can't chain trust through
the publisher's origin if AAO's certificate is what answers.

The supported pattern is the stub: publisher hosts a small file at their
own `/.well-known/adagents.json` with `authoritative_location` pointing
at an AAO URL. The publisher's TLS attests the pointer; AAO serves the
body but never claims to be the publisher. Buyers always start at the
publisher origin.

Page copy now shows the stub JSON inline and explicitly frames AAO's
role as "we serve the body, your origin still attests the pointer."
