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

Before cutover, GitHub Actions must have R2 credentials so release and deploy
workflows keep the bucket fresh:

- `R2_ACCOUNT_ID` or `CLOUDFLARE_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID` or `AWS_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY` or `AWS_SECRET_ACCESS_KEY`
- optional variable: `ADCP_ARTIFACT_R2_BUCKET` (defaults to `adcp-artifacts`)

Automation after these are set:

- `release.yml` uploads only the approved version after publishing its signed
  GitHub Release, using `--version VERSION --skip-latest`. See `RELEASING.md`
  for freshness fences, progressive visibility, and explicit recovery.
- `deploy.yml` rebuilds and uploads mutable `latest` artifacts after the Fly
  deploy, machine-image check, tenant smoke, and console cleanup all pass.

1. Refresh mutable artifacts in R2.

   ```sh
   npm run backfill:cdn-artifacts -- --bucket adcp-artifacts --latest-only --quiet
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
