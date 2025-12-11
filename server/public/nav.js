/**
 * Shared Navigation Component for AdCP
 * Automatically detects current page and localhost environment
 * Fetches config to conditionally show membership features and auth widget
 *
 * Host-based feature flagging:
 * - agenticadvertising.org (beta): New AAO branding, membership features, auth
 * - adcontextprotocol.org (production): Old AdCP branding, membership links redirect to AAO
 * - localhost: Follows beta behavior for testing
 *
 * Auth routing:
 * - All auth operations (login, logout, dashboard) route to agenticadvertising.org
 * - Users on adcontextprotocol.org see login/signup links that redirect to AAO
 * - Session cookies are domain-scoped to agenticadvertising.org
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

  // Determine base URLs based on site type and environment
  // AAO content (members, insights, about) always lives on agenticadvertising.org
  // Docs always live on docs.adcontextprotocol.org
  const aaoBaseUrl = 'https://agenticadvertising.org';
  const adcpBaseUrl = 'https://adcontextprotocol.org';
  const homeBaseUrl = isBetaSite ? aaoBaseUrl : adcpBaseUrl;
  let docsUrl = 'https://docs.adcontextprotocol.org';
  let adagentsUrl = `${aaoBaseUrl}/adagents`;
  let membersUrl = `${aaoBaseUrl}/members`;
  let homeUrl = homeBaseUrl;
  let apiBaseUrl = '';

  if (isLocal) {
    const currentPort = window.location.port;
    // Mintlify typically runs on HTTP port + 1
    // Common Conductor pattern: HTTP on 55020, Mintlify on 55021
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
    // Membership features always enabled - auth redirects to AAO site when on production
    const membershipEnabled = true;
    // Auth is enabled on beta site (AAO) with config flag, always available on production (redirects to AAO)
    const authEnabled = isBetaSite ? config?.authEnabled !== false : true;

    // Auth base URL - always points to AAO for auth operations
    const authBaseUrl = isBetaSite ? '' : 'https://agenticadvertising.org';

    // Build auth section based on state
    let authSection = '';
    if (authEnabled) {
      if (user && isBetaSite) {
        // User is logged in and on beta site - show account dropdown
        const displayName = user.firstName || user.email.split('@')[0];
        const adminLink = user.isAdmin ? `<a href="${authBaseUrl}/admin" class="navbar__dropdown-item">Admin</a>` : '';
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
              <a href="${authBaseUrl}/dashboard" class="navbar__dropdown-item">Dashboard</a>
              ${adminLink}
              <a href="${authBaseUrl}/auth/logout" class="navbar__dropdown-item navbar__dropdown-item--danger">Log out</a>
            </div>
          </div>
        `;
      } else if (membershipEnabled) {
        // Not logged in OR on production site - show login/signup (links to AAO)
        authSection = `
          <a href="${authBaseUrl}/auth/login" class="navbar__link">Log in</a>
          <a href="${authBaseUrl}/auth/login" class="navbar__btn navbar__btn--primary">Sign up</a>
        `;
      }
    }

    // Build members link (only if membership is enabled on beta site)
    const membersLink = membershipEnabled
      ? `<a href="${membersUrl}" class="navbar__link ${currentPath.startsWith('/members') ? 'active' : ''}">Members</a>`
      : '';

    // Build about link (only on beta site - links to trade association)
    // Spell out full name to clarify this is about the org, not the protocol
    const aboutUrl = isLocal ? '/about' : 'https://agenticadvertising.org/about';
    const aboutLink = membershipEnabled
      ? `<a href="${aboutUrl}" class="navbar__link ${currentPath === '/about' ? 'active' : ''}">About AgenticAdvertising.org</a>`
      : '';

    // Build insights link (only on beta site)
    const insightsUrl = isLocal ? '/insights' : 'https://agenticadvertising.org/insights';
    const insightsLink = membershipEnabled
      ? `<a href="${insightsUrl}" class="navbar__link ${currentPath.startsWith('/insights') ? 'active' : ''}">Insights</a>`
      : '';

    // Choose logo based on site - beta gets AAO, production gets AdCP
    const logoSrc = isBetaSite ? '/AAo.svg' : '/adcp_logo.svg';
    const logoAlt = isBetaSite ? 'Agentic Advertising' : 'AdCP';
    // AAO logo is white, needs invert on light background
    // AdCP logo should display normally
    const logoNeedsInvert = isBetaSite;

    // Only show AdCP link on beta site (AAO) - on production (AdCP) the logo already goes to adcontextprotocol.org
    const adcpLink = isBetaSite
      ? '<a href="https://adcontextprotocol.org" class="navbar__link">AdCP</a>'
      : '';

    return `
      <nav class="navbar">
        <div class="navbar__inner">
          <div class="navbar__items">
            <a class="navbar__brand" href="${homeUrl}">
              <div class="navbar__logo">
                <img src="${logoSrc}" alt="${logoAlt}" class="navbar__logo-img" ${logoNeedsInvert ? 'data-invert="true"' : ''}>
              </div>
            </a>
            <div class="navbar__links-desktop">
              ${membersLink}
              ${insightsLink}
              ${aboutLink}
            </div>
          </div>
          <div class="navbar__items navbar__items--right">
            <div class="navbar__links-desktop">
              ${adcpLink}
              <a href="${docsUrl}" class="navbar__link">Docs</a>
              <a href="https://github.com/adcontextprotocol/adcp" target="_blank" rel="noopener noreferrer" class="navbar__link">GitHub</a>
            </div>
            ${authSection}
            <button class="navbar__hamburger" id="mobileMenuBtn" aria-label="Toggle menu">
              <span class="navbar__hamburger-line"></span>
              <span class="navbar__hamburger-line"></span>
              <span class="navbar__hamburger-line"></span>
            </button>
          </div>
        </div>
        <div class="navbar__mobile-menu" id="mobileMenu">
          ${membersLink}
          ${insightsLink}
          ${aboutLink}
          ${adcpLink}
          <a href="${docsUrl}" class="navbar__link">Docs</a>
          <a href="https://github.com/adcontextprotocol/adcp" target="_blank" rel="noopener noreferrer" class="navbar__link">GitHub</a>
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
        color: #1a36b4;
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
        background: #1a36b4;
        color: #fff;
      }

      .navbar__btn--primary:hover {
        background: #2d4fd6;
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

      /* Logo styling */
      .navbar__logo-img {
        display: block;
        height: 24px;
      }

      /* AAO logo (white) needs invert for light backgrounds */
      .navbar__logo-img[data-invert="true"] {
        filter: invert(1);
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

        /* In dark mode, remove invert filter for AAO logo (it's already white) */
        .navbar__logo-img[data-invert="true"] {
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

      /* In dark mode, remove invert filter for AAO logo */
      [data-theme="dark"] .navbar__logo-img[data-invert="true"] {
        filter: none;
      }

      /* Hamburger menu button */
      .navbar__hamburger {
        display: none;
        flex-direction: column;
        justify-content: space-between;
        width: 24px;
        height: 18px;
        background: transparent;
        border: none;
        cursor: pointer;
        padding: 0;
        z-index: 1002;
      }

      .navbar__hamburger-line {
        display: block;
        width: 100%;
        height: 2px;
        background: #000;
        border-radius: 1px;
        transition: all 0.3s ease;
      }

      .navbar__hamburger.open .navbar__hamburger-line:nth-child(1) {
        transform: rotate(45deg) translate(5px, 5px);
      }

      .navbar__hamburger.open .navbar__hamburger-line:nth-child(2) {
        opacity: 0;
      }

      .navbar__hamburger.open .navbar__hamburger-line:nth-child(3) {
        transform: rotate(-45deg) translate(5px, -5px);
      }

      /* Mobile menu */
      .navbar__mobile-menu {
        display: none;
        position: absolute;
        top: 60px;
        left: 0;
        right: 0;
        background: #fff;
        border-top: 1px solid #e5e7eb;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
        padding: 1rem;
        flex-direction: column;
        gap: 0.5rem;
      }

      .navbar__mobile-menu.open {
        display: flex;
      }

      .navbar__mobile-menu .navbar__link {
        padding: 0.75rem 1rem;
        border-radius: 0.5rem;
        display: block;
      }

      .navbar__mobile-menu .navbar__link:hover {
        background: #f3f4f6;
      }

      /* Desktop-only links wrapper */
      .navbar__links-desktop {
        display: flex;
        align-items: center;
        gap: 1.5rem;
      }

      /* Mobile responsive breakpoint */
      @media (max-width: 768px) {
        .navbar__links-desktop {
          display: none;
        }

        .navbar__hamburger {
          display: flex;
        }

        .navbar__items--right {
          gap: 0.75rem;
        }
      }

      /* Dark mode for hamburger and mobile menu */
      @media (prefers-color-scheme: dark) {
        .navbar__hamburger-line {
          background: #fff;
        }

        .navbar__mobile-menu {
          background: #1b1b1d;
          border-top-color: #374151;
        }

        .navbar__mobile-menu .navbar__link:hover {
          background: rgba(255, 255, 255, 0.1);
        }
      }

      [data-theme="dark"] .navbar__hamburger-line {
        background: #fff;
      }

      [data-theme="dark"] .navbar__mobile-menu {
        background: #1b1b1d;
        border-top-color: #374151;
      }

      [data-theme="dark"] .navbar__mobile-menu .navbar__link:hover {
        background: rgba(255, 255, 255, 0.1);
      }
    </style>
  `;

  // Setup dropdown and mobile menu toggles after nav is inserted
  function setupDropdown() {
    const accountBtn = document.getElementById('accountMenuBtn');
    const accountDropdown = document.getElementById('accountDropdown');
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const mobileMenu = document.getElementById('mobileMenu');

    // Account dropdown toggle
    if (accountBtn && accountDropdown) {
      accountBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        accountDropdown.classList.toggle('open');
        // Close mobile menu if open
        if (mobileMenu) mobileMenu.classList.remove('open');
        if (mobileMenuBtn) mobileMenuBtn.classList.remove('open');
      });

      // Prevent dropdown from closing when clicking inside it
      accountDropdown.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    }

    // Mobile menu toggle
    if (mobileMenuBtn && mobileMenu) {
      mobileMenuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        mobileMenuBtn.classList.toggle('open');
        mobileMenu.classList.toggle('open');
        // Close account dropdown if open
        if (accountDropdown) accountDropdown.classList.remove('open');
      });

      // Close mobile menu when clicking a link
      mobileMenu.querySelectorAll('.navbar__link').forEach(link => {
        link.addEventListener('click', () => {
          mobileMenuBtn.classList.remove('open');
          mobileMenu.classList.remove('open');
        });
      });
    }

    // Close all menus when clicking outside
    document.addEventListener('click', () => {
      if (accountDropdown) accountDropdown.classList.remove('open');
      if (mobileMenu) mobileMenu.classList.remove('open');
      if (mobileMenuBtn) mobileMenuBtn.classList.remove('open');
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
