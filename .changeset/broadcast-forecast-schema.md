---
"adcontextprotocol": minor
---

Add broadcast TV, audio, and DOOH forecast support: `measurement_source` field on DeliveryForecast to declare which third-party measurement provider produced the forecast numbers (e.g., nielsen, videoamp, comscore, geopath); `guaranteed_impressions` metric for sellers who guarantee delivery against a named currency; `package` forecast range unit for sellers who offer distinct inventory packages rather than spend curves; relax `mid` requirement on ForecastRange to allow any of low/mid/high.
