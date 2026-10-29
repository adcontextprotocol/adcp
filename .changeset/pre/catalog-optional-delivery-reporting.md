---
"adcontextprotocol": patch
---

`advanced_delivery_reporting` no longer seeds a video product. It grades
format-breakdown reporting only when your wholesale sandbox catalog contains a
non-guaranteed, fixed-price CPM product with
`reporting_capabilities.supports_format_breakdown: true`. When completed valid
catalog discovery finds no qualifying product, it reports `not_applicable`
(`fixture_unsatisfied`). Time-based-view checks move to a new
`time_based_delivery_reporting` storyboard, selected independently from native
wholesale sandbox products listing `time_based_views`, with the same
non-guaranteed, fixed-price CPM restriction. Neither requires a specific threshold, basis, format
kind or non-empty rows. Partially addresses #8254; collection storyboards are
unchanged.
