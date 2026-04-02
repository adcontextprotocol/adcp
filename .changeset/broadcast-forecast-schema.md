---
"adcontextprotocol": minor
---

Add broadcast TV, audio, and DOOH forecast support: `measurement_source` field on DeliveryForecast to declare which third-party measurement provider produced the forecast numbers (includes global providers: nielsen, videoamp, comscore, geopath, barb, agf, oztam, kantar, barc, route, rajar, triton); `measured_impressions` metric for delivery as counted by the measurement_source provider (independent of guarantee — works with both guaranteed and modeled forecasts); `downloads` metric for podcast advertising; `plays` metric for DOOH raw play counts before impression multiplier; `package` forecast range unit for sellers who offer distinct inventory packages rather than spend curves; `label` field on ForecastPoint to identify packages by name; relax `mid` requirement on ForecastRange to accept either `mid` or both `low`+`high`.
