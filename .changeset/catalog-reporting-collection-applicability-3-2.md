---
"adcontextprotocol": patch
---

Stop the 3.2 collection and reporting storyboards from failing sellers on features they do not offer. Backports the applicability part of #8336 and narrows #8428 for the 3.2 runner (#8744).

`advanced_delivery_reporting` no longer seeds a video product. It discovers a native wholesale sandbox product that advertises format breakdown, with a fixed-price CPM option, and grades metric narrowing, the `by_format` array, truncation disclosure and the applied-sort echo on that product. When no product qualifies, the storyboard reports `fixture_unsatisfied`: the feature was not tested, which is neither a pass nor proof of nonsupport. It no longer grades `time_based_views`, because the controller cannot inject view observations and the old checks expected an invented 2-second threshold.

`collection_selection` and `owner_sold_channel_carriage` keep their existing checks. They now run only when wholesale discovery finds a native product that allows collection targeting and declares at least one domain-qualified collection. Otherwise they report `fixture_unsatisfied`. Discovery failures still fail. Sellers that do not advertise the wholesale buying mode grade all three storyboards not applicable.

Full independent collection grading needs the 3.3 fixture contract and runner, and ships in 3.3. No schema changes.
