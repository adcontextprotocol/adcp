/**
 * Shared Navigation Component for AdCP
 * Automatically detects current page and localhost environment
 */

(function() {
  'use strict';

  // Determine if running locally
  const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

  // In local dev, try to detect Mintlify port (usually HTTP port + 1)
  // Common Conductor pattern: HTTP on 55020, Mintlify on 55021
  let docsUrl = 'https://docs.adcontextprotocol.org';
  let registryUrl = 'https://adcontextprotocol.org/registry';
  let adagentsUrl = 'https://adcontextprotocol.org/adagents';
  let homeUrl = 'https://adcontextprotocol.org';

  if (isLocal) {
    const currentPort = window.location.port;
    // Mintlify typically runs on HTTP port + 1
    const likelyMintlifyPort = currentPort ? (parseInt(currentPort) + 1) : 3001;
    const likelyHttpPort = currentPort ? (parseInt(currentPort) - 1) : 55020;

    // If we're on the Mintlify docs site, link back to HTTP server
    // If we're on HTTP server, use relative links
    if (parseInt(currentPort) === likelyMintlifyPort || parseInt(currentPort) === 3001) {
      // We're on docs site, link back to HTTP server
      docsUrl = `http://localhost:${currentPort}`;
      registryUrl = `http://localhost:${likelyHttpPort}/registry`;
      adagentsUrl = `http://localhost:${likelyHttpPort}/adagents`;
      homeUrl = `http://localhost:${likelyHttpPort}`;
    } else {
      // We're on HTTP server, use relative links for same-server pages
      docsUrl = `http://localhost:${likelyMintlifyPort}`;
      registryUrl = '/registry';
      adagentsUrl = '/adagents';
      homeUrl = '/';
    }
  }

  // Get current path to mark active link
  const currentPath = window.location.pathname;

  // Navigation HTML
  const navHTML = `
    <nav class="navbar">
      <div class="navbar__inner">
        <div class="navbar__items">
          <a class="navbar__brand" href="${homeUrl}">
            <div class="navbar__logo">
              <img src="/adcp_logo.svg" alt="AdCP Logo">
            </div>
            <b class="navbar__title">AdCP</b>
          </a>
          <a href="${docsUrl}" class="navbar__link">Docs</a>
          <a href="${registryUrl}" class="navbar__link ${currentPath === '/registry' ? 'active' : ''}">Agent Registry</a>
          <a href="${adagentsUrl}" class="navbar__link ${currentPath === '/adagents' ? 'active' : ''}">AdAgents Manager</a>
        </div>
        <div class="navbar__items">
          <a href="https://github.com/adcontextprotocol/adcp" target="_blank" rel="noopener noreferrer" class="navbar__link">GitHub</a>
        </div>
      </div>
    </nav>
  `;

  // Navigation CSS
  const navCSS = `
    <style>
      /* Add padding to body to prevent navbar overlap */
      body {
        padding-top: 60px;
      }

      .navbar {
        background: #fff;
        box-shadow: 0 1px 2px 0 rgba(0,0,0,.1);
        height: 60px;
        padding: 0 1rem;
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        z-index: 1000;
      }

      .navbar__inner {
        display: flex;
        justify-content: space-between;
        align-items: center;
        max-width: 1440px;
        margin: 0 auto;
        height: 100%;
      }

      .navbar__items {
        display: flex;
        align-items: center;
        gap: 1.5rem;
      }

      .navbar__brand {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        text-decoration: none;
        color: inherit;
      }

      .navbar__logo {
        display: flex;
        align-items: center;
      }

      .navbar__logo img {
        height: 32px;
        width: 32px;
        display: block;
      }

      .navbar__title {
        font-size: 1.25rem;
        font-weight: 700;
        color: #000;
      }

      .navbar__link {
        text-decoration: none;
        color: #000;
        font-weight: 500;
        padding: 0.5rem 0.75rem;
        border-radius: 0.25rem;
        transition: background-color 0.2s;
      }

      .navbar__link:hover {
        background: rgba(0, 0, 0, 0.05);
      }

      .navbar__link.active {
        color: #10b981;
        font-weight: 600;
      }
    </style>
  `;

  // Insert CSS and navigation when DOM is ready
  function insertNav() {
    // Add CSS to head
    document.head.insertAdjacentHTML('beforeend', navCSS);

    // Find placeholder or insert at start of body
    const placeholder = document.getElementById('adcp-nav');
    if (placeholder) {
      placeholder.outerHTML = navHTML;
    } else {
      document.body.insertAdjacentHTML('afterbegin', navHTML);
    }
  }

  // Run when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', insertNav);
  } else {
    insertNav();
  }
})();
