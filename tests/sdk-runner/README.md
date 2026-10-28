# Private compliance test SDK

This fixture pins the published SDK 17.0.0-beta.3 testing API for auction-only
seller regressions. Its peers resolve inside the fixture package, so the
maintenance server keeps its existing SDK and peer dependencies.

Only the public `./testing` entry point is forwarded. Runtime code must use the
root `@adcp/sdk`, and this private package is a development dependency.
