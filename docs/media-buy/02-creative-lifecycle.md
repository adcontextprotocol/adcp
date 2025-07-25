# 2. Creative Lifecycle

ADCP V2.3 provides a comprehensive set of tools for managing the entire lifecycle of creative assets within a media buy. This includes initial submission, status tracking, and publisher-assisted adaptation.

## The Creative Model

A `Creative` is a simple object that links a user-defined ID to a specific format and the location of the asset.

- **`creative_id`**: A unique, client-defined identifier for the creative.
- **`format_id`**: The ID of the format the creative adheres to. This must match a format supported by the products in the media buy. See the [Creative Formats](creative-formats.md) guide for details.
- **`content_uri`**: The URI pointing to the creative asset (e.g., a VAST XML file, an image URL, or a ZIP file with HTML5 assets).

### Example Creative
```json
{
  "creative_id": "cr_video_catfood_promo_30s",
  "format_id": "video_standard_1080p",
  "content_uri": "https://example.com/assets/catfood_promo_30s.zip"
}
```

## The Submission & Approval Process

### 1. Submitting Creatives (`submit_creatives`)
Creatives are submitted for a specific media buy using the `submit_creatives` tool. The publisher's system (the "Creative Engine") then begins processing them.

- **Request**: `SubmitCreativesRequest` (contains `media_buy_id` and a list of `Creative` objects).
- **Response**: `SubmitCreativesResponse` (contains a list of `CreativeStatus` objects).

The `CreativeStatus` object includes the `status` ("pending_review", "approved", "rejected") and an estimated time for approval.

### 2. Checking Status (`check_creative_status`)
The client can poll the `check_creative_status` tool at any time to get the latest status for one or more creatives.

- **Request**: `CheckCreativeStatusRequest` (contains a list of `creative_ids`).
- **Response**: `CheckCreativeStatusResponse` (contains the corresponding list of `CreativeStatus` objects).

## Creative Adaptation (`adapt_creative`)

A key feature of the protocol is the ability to request that the publisher adapt an existing creative to a new format. This is useful for creating variations for different placements (e.g., adapting a 16:9 video to a vertical 9:16 format for mobile).

The `adapt_creative` tool allows the client to specify the original creative, the target format, a new ID for the adapted creative, and natural language instructions.

- **Request**: `AdaptCreativeRequest`
  ```json
  {
    "original_creative_id": "cr_video_catfood_promo_30s",
    "target_format_id": "video_vertical_mobile",
    "new_creative_id": "cr_video_catfood_promo_vertical",
    "instructions": "Please create a 9:16 vertical version of this ad. Focus on the cat in the first 3 seconds."
  }
  ```
- **Response**: A `CreativeStatus` object for the new creative, which will enter the standard approval workflow.
