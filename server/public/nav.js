/**
 * Shared Navigation Component for AdCP
 * Automatically detects current page and localhost environment
 * Fetches config to conditionally show membership features and auth widget
 *
 * Host-based feature flagging:
 * - agenticadvertising.org (beta): New AAO branding + membership features
 * - adcontextprotocol.org (production): Old AdCP branding, no membership
 * - localhost: Follows beta behavior for testing
 */

(function() {
  'use strict';

  // Determine if running locally
  const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

  // Determine if this is the beta site (AAO) or production site (AdCP)
  // Beta sites: agenticadvertising.org, localhost (for testing)
  // Production sites: adcontextprotocol.org
  //
  // Local testing: Add ?beta=false to URL to simulate production site
  //                Add ?beta=true to force beta mode (default for localhost)
  const hostname = window.location.hostname;
  const urlParams = new URLSearchParams(window.location.search);
  const betaOverride = urlParams.get('beta');

  let isBetaSite;
  if (betaOverride !== null) {
    // URL parameter overrides hostname detection
    isBetaSite = betaOverride !== 'false';
  } else {
    // Default: localhost and agenticadvertising.org are beta
    isBetaSite = isLocal || hostname.includes('agenticadvertising');
  }

  // In local dev, try to detect Mintlify port (usually HTTP port + 1)
  // Common Conductor pattern: HTTP on 55020, Mintlify on 55021
  let docsUrl = 'https://docs.adcontextprotocol.org';
  let adagentsUrl = 'https://adcontextprotocol.org/adagents';
  let membersUrl = 'https://adcontextprotocol.org/members';
  let homeUrl = 'https://adcontextprotocol.org';
  let apiBaseUrl = '';

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
      adagentsUrl = `http://localhost:${likelyHttpPort}/adagents`;
      membersUrl = `http://localhost:${likelyHttpPort}/members`;
      homeUrl = `http://localhost:${likelyHttpPort}`;
      apiBaseUrl = `http://localhost:${likelyHttpPort}`;
    } else {
      // We're on HTTP server, use relative links for same-server pages
      docsUrl = `http://localhost:${likelyMintlifyPort}`;
      adagentsUrl = '/adagents';
      membersUrl = '/members';
      homeUrl = '/';
      apiBaseUrl = '';
    }
  }

  // Get current path to mark active link
  const currentPath = window.location.pathname;

  // Build navigation HTML - will be updated after config fetch
  function buildNavHTML(config) {
    const user = config?.user;
    // Membership features only enabled on beta site AND when config allows
    const membershipEnabled = isBetaSite && config?.membershipEnabled !== false;
    const authEnabled = isBetaSite && config?.authEnabled !== false;

    // Build auth section based on state
    let authSection = '';
    if (authEnabled) {
      if (user) {
        // User is logged in - show account dropdown
        const displayName = user.firstName || user.email.split('@')[0];
        const adminLink = user.isAdmin ? '<a href="/admin" class="navbar__dropdown-item">Admin</a>' : '';
        authSection = `
          <div class="navbar__account">
            <button class="navbar__account-btn" id="accountMenuBtn">
              <span class="navbar__account-name">${displayName}</span>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                <path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" stroke-width="1.5" fill="none"/>
              </svg>
            </button>
            <div class="navbar__dropdown" id="accountDropdown">
              <div class="navbar__dropdown-header">${user.email}</div>
              <a href="/dashboard" class="navbar__dropdown-item">Dashboard</a>
              ${adminLink}
              <a href="/auth/logout" class="navbar__dropdown-item navbar__dropdown-item--danger">Log out</a>
            </div>
          </div>
        `;
      } else if (membershipEnabled) {
        // Not logged in but auth is available and membership enabled - show login/signup
        authSection = `
          <a href="/auth/login" class="navbar__link">Log in</a>
          <a href="/auth/login" class="navbar__btn navbar__btn--primary">Sign up</a>
        `;
      }
    }

    // Build members link (only if membership is enabled on beta site)
    const membersLink = membershipEnabled
      ? `<a href="${membersUrl}" class="navbar__link ${currentPath.startsWith('/members') ? 'active' : ''}">Members</a>`
      : '';

    // Build about link (only on beta site - links to trade association)
    const aboutUrl = isLocal ? '/about' : 'https://agenticadvertising.org/about';
    const aboutLink = membershipEnabled
      ? `<a href="${aboutUrl}" class="navbar__link ${currentPath === '/about' ? 'active' : ''}">About</a>`
      : '';

    // Choose logo based on site - beta gets AAO, production gets AdCP
    const logoSrc = isBetaSite ? '/AAo.svg' : '/adcp_logo.svg';
    const logoAlt = isBetaSite ? 'Agentic Advertising' : 'AdCP';
    // AAO logo is white, needs invert on light background
    // AdCP logo should display normally
    const logoNeedsInvert = isBetaSite;

    return `
      <nav class="navbar">
        <div class="navbar__inner">
          <div class="navbar__items">
            <a class="navbar__brand" href="${homeUrl}">
              <div class="navbar__logo">
                <img src="${logoSrc}" alt="${logoAlt}" class="logo-light" ${logoNeedsInvert ? '' : 'style="filter: none;"'}>
                <img src="${logoSrc}" alt="${logoAlt}" class="logo-dark" ${logoNeedsInvert ? '' : 'style="filter: none;"'}>
              </div>
            </a>
            <a href="${docsUrl}" class="navbar__link">Docs</a>
            <a href="${adagentsUrl}" class="navbar__link ${currentPath === '/adagents' ? 'active' : ''}">adagents.json</a>
            ${membersLink}
            ${aboutLink}
          </div>
          <div class="navbar__items navbar__items--right">
            <a href="https://github.com/adcontextprotocol/adcp" target="_blank" rel="noopener noreferrer" class="navbar__link">GitHub</a>
            ${authSection}
          </div>
        </div>
      </nav>
    `;
  }

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

      .navbar__items--right {
        gap: 1rem;
      }

      .navbar__brand {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        text-decoration: none;
        color: inherit;
        cursor: pointer;
      }

      .navbar__logo {
        display: flex;
        align-items: center;
        min-width: 50px;
        min-height: 20px;
      }

      .navbar__logo img {
        height: 20px;
        width: auto;
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

      /* Primary button style */
      .navbar__btn {
        display: inline-flex;
        align-items: center;
        padding: 0.5rem 1rem;
        border-radius: 0.375rem;
        font-weight: 500;
        text-decoration: none;
        transition: all 0.2s;
      }

      .navbar__btn--primary {
        background: #10b981;
        color: #fff;
      }

      .navbar__btn--primary:hover {
        background: #059669;
      }

      /* Account dropdown */
      .navbar__account {
        position: relative;
      }

      .navbar__account-btn {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 0.75rem;
        background: transparent;
        border: 1px solid #e5e7eb;
        border-radius: 0.375rem;
        cursor: pointer;
        font-size: 0.875rem;
        font-weight: 500;
        color: #000;
        transition: all 0.2s;
      }

      .navbar__account-btn:hover {
        background: rgba(0, 0, 0, 0.05);
        border-color: #d1d5db;
      }

      .navbar__dropdown {
        display: none;
        position: absolute;
        top: calc(100% + 0.5rem);
        right: 0;
        min-width: 200px;
        background: #fff;
        border: 1px solid #e5e7eb;
        border-radius: 0.5rem;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        overflow: hidden;
        z-index: 1001;
      }

      .navbar__dropdown.open {
        display: block;
      }

      .navbar__dropdown-header {
        padding: 0.75rem 1rem;
        font-size: 0.75rem;
        color: #6b7280;
        border-bottom: 1px solid #e5e7eb;
        background: #f9fafb;
      }

      .navbar__dropdown-item {
        display: block;
        padding: 0.75rem 1rem;
        text-decoration: none;
        color: #000;
        font-size: 0.875rem;
        transition: background-color 0.2s;
      }

      .navbar__dropdown-item:hover {
        background: #f3f4f6;
      }

      .navbar__dropdown-item--danger {
        color: #dc2626;
      }

      .navbar__dropdown-item--danger:hover {
        background: #fef2f2;
      }

      /* Logo switching for dark mode */
      /* The AAO logo is white text - needs invert for light backgrounds */
      .logo-light {
        display: block;
        height: 24px;
        filter: invert(1);
      }

      .logo-dark {
        display: none;
        height: 24px;
      }

      /* Dark mode support */
      @media (prefers-color-scheme: dark) {
        .navbar {
          background: #1b1b1d;
          box-shadow: 0 1px 2px 0 rgba(255,255,255,.1);
        }

        .navbar__title,
        .navbar__link {
          color: #fff;
        }

        .navbar__link:hover {
          background: rgba(255, 255, 255, 0.1);
        }

        .navbar__account-btn {
          color: #fff;
          border-color: #374151;
        }

        .navbar__account-btn:hover {
          background: rgba(255, 255, 255, 0.1);
          border-color: #4b5563;
        }

        .navbar__dropdown {
          background: #1f2937;
          border-color: #374151;
        }

        .navbar__dropdown-header {
          background: #111827;
          border-color: #374151;
          color: #9ca3af;
        }

        .navbar__dropdown-item {
          color: #fff;
        }

        .navbar__dropdown-item:hover {
          background: #374151;
        }

        .navbar__dropdown-item--danger:hover {
          background: #7f1d1d;
        }

        .logo-light {
          display: none !important;
        }

        .logo-dark {
          display: block !important;
          filter: none;
        }
      }

      [data-theme="dark"] .navbar {
        background: #1b1b1d;
        box-shadow: 0 1px 2px 0 rgba(255,255,255,.1);
      }

      [data-theme="dark"] .navbar__title,
      [data-theme="dark"] .navbar__link {
        color: #fff;
      }

      [data-theme="dark"] .navbar__link:hover {
        background: rgba(255, 255, 255, 0.1);
      }

      [data-theme="dark"] .navbar__account-btn {
        color: #fff;
        border-color: #374151;
      }

      [data-theme="dark"] .navbar__account-btn:hover {
        background: rgba(255, 255, 255, 0.1);
        border-color: #4b5563;
      }

      [data-theme="dark"] .navbar__dropdown {
        background: #1f2937;
        border-color: #374151;
      }

      [data-theme="dark"] .navbar__dropdown-header {
        background: #111827;
        border-color: #374151;
        color: #9ca3af;
      }

      [data-theme="dark"] .navbar__dropdown-item {
        color: #fff;
      }

      [data-theme="dark"] .navbar__dropdown-item:hover {
        background: #374151;
      }

      [data-theme="dark"] .navbar__dropdown-item--danger:hover {
        background: #7f1d1d;
      }

      [data-theme="dark"] .logo-light {
        display: none !important;
      }

      [data-theme="dark"] .logo-dark {
        display: block !important;
        filter: none;
      }
    </style>
  `;

  // Setup dropdown toggle after nav is inserted
  function setupDropdown() {
    const btn = document.getElementById('accountMenuBtn');
    const dropdown = document.getElementById('accountDropdown');

    if (!btn || !dropdown) return;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('open');
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', () => {
      dropdown.classList.remove('open');
    });

    // Prevent dropdown from closing when clicking inside it
    dropdown.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  }

  // Insert CSS and navigation when DOM is ready
  async function insertNav() {
    // Add CSS to head first
    document.head.insertAdjacentHTML('beforeend', navCSS);

    // Fetch config to determine what to show
    let config = { membershipEnabled: true, authEnabled: false, user: null };
    try {
      const response = await fetch(`${apiBaseUrl}/api/config`, {
        credentials: 'include'
      });
      if (response.ok) {
        config = await response.json();
      }
    } catch (err) {
      // Config fetch failed, use defaults (membership enabled, auth disabled)
      console.debug('Nav config fetch failed, using defaults:', err);
    }

    const navHTML = buildNavHTML(config);

    // Find placeholder or insert at start of body
    const placeholder = document.getElementById('adcp-nav');
    if (placeholder) {
      placeholder.outerHTML = navHTML;
    } else {
      document.body.insertAdjacentHTML('afterbegin', navHTML);
    }

    // Setup dropdown toggle
    setupDropdown();
  }

  // Run when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', insertNav);
  } else {
    insertNav();
  }
})();
