# Artifact CDN Worker

This Worker serves the public AdCP artifact paths from the `adcp-artifacts` R2
bucket while preserving the path aliases currently handled by the Fly app.

## Shadow Deploy

Use the normal Worker config for shadow deploys. It only exposes the
`workers.dev` URL.

```sh
npm run deploy:cdn-artifacts-worker
npm run verify:cdn-artifacts-cutover
```

## Production Cutover

The cutover config is deliberately separate from `wrangler.toml` so a normal
Worker deploy does not attach production routes.

1. Refresh mutable artifacts in R2.

   ```sh
   npm run backfill:cdn-artifacts -- --bucket adcp-artifacts --quiet
   ```

2. Verify the shadow Worker against current production.

   ```sh
   npm run verify:cdn-artifacts-cutover
   ```

3. Dry-run the routed deploy.

   ```sh
   npm run deploy:cdn-artifacts-cutover:dry-run
   ```

4. Attach the production routes.

   ```sh
   npm run deploy:cdn-artifacts-cutover
   ```

5. Verify the production routes now match the shadow Worker.

   ```sh
   npm run verify:cdn-artifacts-cutover -- \
     --reference https://adcp-artifacts-cdn.brian-8ca.workers.dev \
     --candidate https://adcontextprotocol.org
   ```

The cutover config routes only these paths:

- `/schemas` and `/schemas/*`
- `/compliance` and `/compliance/*`
- `/protocol` and `/protocol/*`
