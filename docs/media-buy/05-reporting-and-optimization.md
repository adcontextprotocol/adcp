# 5. Reporting & Optimization

ADCP V2.3 includes tools for monitoring campaign delivery and providing performance feedback, creating a closed loop for optimization.

## Delivery Reporting (`get_media_buy_delivery`)

The `get_media_buy_delivery` tool provides a real-time snapshot of a campaign's performance.

- **Request**:
  - **`media_buy_id`**: The ID of the media buy.
  - **`today`**: The simulated date for which to calculate delivery. This allows for replaying and analyzing historical data.

- **Response**: `GetMediaBuyDeliveryResponse`
  - **`status`**: The current status of the campaign ("pending_start", "live", "completed").
  - **`spend`**: The total amount of budget spent to date.
  - **`impressions`**: The total number of impressions delivered.
  - **`pacing`**: A string indicating if the campaign is on track to meet its goals ("on_track", "ahead", "behind").
  - **`days_elapsed` / `total_days`**: The progress of the campaign flight.

Clients should call this tool periodically to monitor their campaigns.

## Performance Feedback for Optimization (`update_performance_index`)

This tool is the key to enabling agentic, AI-driven optimization. It allows the client to provide performance feedback to the publisher's system.

The client can analyze its own internal metrics (e.g., sales lift, brand awareness, conversion rates) and translate that performance into a simple, normalized score for each product in the buy.

- **Request**: `UpdatePerformanceIndexRequest`
  - **`media_buy_id`**: The ID of the media buy.
  - **`performance_data`**: A list of `ProductPerformance` objects.

### The `ProductPerformance` Model
- **`product_id`**: The product being scored.
- **`performance_index`**: A normalized score. A value of `1.0` represents baseline performance. `1.2` means 20% better than baseline; `0.8` means 20% worse.
- **`confidence_score`**: (Optional) A value from 0.0 to 1.0 indicating the statistical confidence in the index.

**Example `performance_data`:**
```json
[
  {
    "product_id": "prod_video_instream_sports",
    "performance_index": 1.45,
    "confidence_score": 0.92
  },
  {
    "product_id": "prod_display_banner_news",
    "performance_index": 0.85,
    "confidence_score": 0.95
  }
]
```

### Enabling Advanced Optimization

By providing this feedback, the client gives the publisher's ad serving and optimization systems a clear signal about what is working. The publisher can then use this data to inform its own algorithms.

This creates a powerful feedback loop:
1.  Publisher delivers ads.
2.  Client measures business outcomes.
3.  Client sends performance index back to publisher.
4.  Publisher's system can now **optimize toward the client's true KPIs**, not just proxy metrics like CTR.

This is particularly powerful for techniques like **multi-armed bandit experimentation**, where the publisher's system can automatically shift delivery toward the products that the client has reported as performing best, maximizing the campaign's effectiveness in real time.
