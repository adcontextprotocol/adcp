# Fly.io Deployment Setup for AdCP Docs

This guide will help you deploy the AdCP documentation to Fly.io.

## Prerequisites

1. Install the Fly.io CLI: https://fly.io/docs/hands-on/install-flyctl/
2. Sign up for a Fly.io account: https://fly.io/app/sign-up
3. Log in: `flyctl auth login`

## Initial Setup

### 1. Create the Fly.io App

```bash
# Create a new app (you can choose a different name)
flyctl apps create adcp-docs

# Or if you want to use a different name:
# flyctl apps create your-chosen-name
# Then update the app name in fly.toml
```

### 2. Set up Custom Domain

```bash
# Add your custom domain
flyctl certs add adcontextprotocol.org

# Add www subdomain if needed
flyctl certs add www.adcontextprotocol.org

# Check certificate status
flyctl certs check adcontextprotocol.org
```

### 3. Configure DNS

Add these DNS records to your domain:

**For apex domain (adcontextprotocol.org):**
- Type: A
- Name: @
- Value: (IP addresses from `flyctl ips list`)

**For www subdomain:**
- Type: CNAME  
- Name: www
- Value: adcontextprotocol.org

### 4. Deploy

```bash
# Deploy the application
flyctl deploy

# Monitor the deployment
flyctl logs
```

## GitHub Actions Setup

1. Get your Fly.io API token:
   ```bash
   flyctl auth token
   ```

2. Add the token to GitHub Secrets:
   - Go to your GitHub repository
   - Settings → Secrets and variables → Actions
   - Add new secret: `FLY_API_TOKEN` with your token

3. Push to main branch to trigger deployment

## Monitoring

```bash
# Check app status
flyctl status

# View logs
flyctl logs

# Check app info
flyctl info

# Scale if needed
flyctl scale count 2
```

## Troubleshooting

### Build Issues
```bash
# Build locally to test
docker build -t adcp-docs .
docker run -p 8080:8080 adcp-docs
```

### Domain Issues
```bash
# Check certificate status
flyctl certs check adcontextprotocol.org

# List all certificates
flyctl certs list
```

### Performance Issues
```bash
# Check current scaling
flyctl scale show

# Scale up if needed
flyctl scale count 2
flyctl scale memory 1024
```

## Configuration Files

- `fly.toml` - Main Fly.io configuration
- `Dockerfile` - Multi-stage build for the documentation site
- `nginx.conf` - Web server configuration with optimizations
- `.github/workflows/fly-deploy.yml` - CI/CD pipeline

The setup includes:
- Automatic HTTPS
- Gzip compression
- Static asset caching
- Health checks
- Auto-scaling (can scale to 0 when not in use)
- Custom domain support