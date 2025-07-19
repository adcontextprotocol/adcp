# Ad Context Protocol (ADCP)

Docs and reference implementation for the Ad Context Protocol

## Documentation Website

This repository contains the documentation website built using [Docusaurus](https://docusaurus.io/), a modern static website generator.

The documentation is automatically deployed to [https://adcontextprotocol.github.io/](https://adcontextprotocol.github.io/) when changes are pushed to the main branch.

## Local Development

### Installation

```bash
npm install
```

### Start Development Server

```bash
npm start
```

This command starts a local development server and opens up a browser window. Most changes are reflected live without having to restart the server.

### Build

```bash
npm run build
```

This command generates static content into the `build` directory and can be served using any static contents hosting service.

## Deployment

The site automatically deploys to GitHub Pages when you push to the main branch using GitHub Actions. The deployment workflow is configured in `.github/workflows/deploy.yml`.
