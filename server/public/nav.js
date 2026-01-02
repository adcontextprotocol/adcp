/**
 * Shared Navigation Component for Agentic Advertising
 * Automatically detects current page and localhost environment
 * Fetches config to conditionally show membership features and auth widget
 *
 * Auth routing:
 * - All auth operations (login, logout, dashboard) route to agenticadvertising.org
 * - Session cookies are domain-scoped to agenticadvertising.org
 */

(function() {
  'use strict';

  // Skip on Mintlify docs site - it has its own navigation
  // This prevents the nav from appearing when Mintlify accidentally bundles this script
  const hostname = window.location.hostname;
  if (hostname === 'docs.adcontextprotocol.org' ||
      hostname.includes('mintlify') ||
      document.querySelector('meta[name="generator"][content="Mintlify"]')) {
    return;
  }

  // Determine if running locally
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';

  // All sites use identical AAO-branded navigation
  // AAO content (members, insights, about) always lives on agenticadvertising.org
  // Docs always live on docs.adcontextprotocol.org
  const aaoBaseUrl = 'https://agenticadvertising.org';
  let docsUrl = 'https://docs.adcontextprotocol.org';
  let adagentsUrl = `${aaoBaseUrl}/adagents`;
  let membersUrl = `${aaoBaseUrl}/members`;
  let homeUrl = aaoBaseUrl;
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
    const authEnabled = config?.authEnabled !== false;

    // Auth uses relative URLs (all sites are AAO)
    const authBaseUrl = '';

    // Build auth section based on state
    let authSection = '';
    if (authEnabled) {
      if (user) {
        // User is logged in - show account dropdown
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
        // Not logged in - show login/signup (links to AAO)
        authSection = `
          <a href="${authBaseUrl}/auth/login" class="navbar__link">Log in</a>
          <a href="${authBaseUrl}/auth/signup?return_to=/onboarding?signup=true" class="navbar__btn navbar__btn--primary">Sign up</a>
        `;
      }
    }

    // Build Registry dropdown with submenu (Members, Agents, Publishers, Properties)
    const agentsUrl = isLocal ? '/registry' : `${aaoBaseUrl}/registry`;
    const publishersUrl = isLocal ? '/publishers' : `${aaoBaseUrl}/publishers`;
    const propertiesUrl = isLocal ? '/properties' : `${aaoBaseUrl}/properties`;
    const isRegistryActive = currentPath === '/members' || currentPath.startsWith('/members/') ||
                              currentPath === '/registry' || currentPath === '/publishers' || currentPath === '/properties';
    const registryDropdown = membershipEnabled
      ? `<div class="navbar__dropdown-wrapper">
          <button class="navbar__link navbar__dropdown-trigger ${isRegistryActive ? 'active' : ''}">
            Registry
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" style="margin-left: 4px;">
              <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.5" fill="none"/>
            </svg>
          </button>
          <div class="navbar__dropdown navbar__dropdown--nav">
            <a href="${membersUrl}" class="navbar__dropdown-item ${currentPath === '/members' || currentPath.startsWith('/members/') ? 'active' : ''}">Members</a>
            <a href="${agentsUrl}" class="navbar__dropdown-item ${currentPath === '/registry' ? 'active' : ''}">Agents</a>
            <a href="${publishersUrl}" class="navbar__dropdown-item ${currentPath === '/publishers' ? 'active' : ''}">Publishers</a>
            <a href="${propertiesUrl}" class="navbar__dropdown-item ${currentPath === '/properties' ? 'active' : ''}">Properties</a>
            <div class="navbar__dropdown-divider"></div>
            <div class="navbar__dropdown-mcp">
              <span class="navbar__mcp-badge">MCP</span>
              <span class="navbar__mcp-text">All data available via MCP</span>
            </div>
          </div>
        </div>`
      : '';

    // Build about dropdown (only on beta site - links to trade association)
    // Includes About page, Membership page, and Governance page
    const aboutUrl = isLocal ? '/about' : 'https://agenticadvertising.org/about';
    const membershipUrl = isLocal ? '/membership' : 'https://agenticadvertising.org/membership';
    const governanceUrl = isLocal ? '/governance' : 'https://agenticadvertising.org/governance';
    const aboutDropdown = membershipEnabled
      ? `<div class="navbar__dropdown-wrapper">
          <button class="navbar__link navbar__dropdown-trigger ${currentPath === '/about' || currentPath === '/membership' || currentPath === '/governance' ? 'active' : ''}">
            AgenticAdvertising.org
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" style="margin-left: 4px;">
              <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.5" fill="none"/>
            </svg>
          </button>
          <div class="navbar__dropdown navbar__dropdown--nav">
            <a href="${aboutUrl}" class="navbar__dropdown-item ${currentPath === '/about' ? 'active' : ''}">About</a>
            <a href="${membershipUrl}" class="navbar__dropdown-item ${currentPath === '/membership' ? 'active' : ''}">Membership</a>
            <a href="${governanceUrl}" class="navbar__dropdown-item ${currentPath === '/governance' ? 'active' : ''}">Governance</a>
          </div>
        </div>`
      : '';

    // Build perspectives link (only on beta site)
    const perspectivesUrl = isLocal ? '/perspectives' : 'https://agenticadvertising.org/perspectives';
    const perspectivesLink = membershipEnabled
      ? `<a href="${perspectivesUrl}" class="navbar__link ${currentPath.startsWith('/perspectives') ? 'active' : ''}">Perspectives</a>`
      : '';

    // Build committees dropdown (replaces working groups link)
    const workingGroupsUrl = isLocal ? '/working-groups' : 'https://agenticadvertising.org/working-groups';
    const councilsUrl = isLocal ? '/councils' : 'https://agenticadvertising.org/councils';
    const chaptersUrl = isLocal ? '/chapters' : 'https://agenticadvertising.org/chapters';
    const isCommitteesActive = currentPath.startsWith('/working-groups') || currentPath === '/councils' || currentPath === '/chapters';
    const committeesDropdown = membershipEnabled
      ? `<div class="navbar__dropdown-wrapper">
          <button class="navbar__link navbar__dropdown-trigger ${isCommitteesActive ? 'active' : ''}">
            Committees
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M6 9l6 6 6-6"/>
            </svg>
          </button>
          <div class="navbar__dropdown navbar__dropdown--nav">
            <a href="${workingGroupsUrl}" class="navbar__dropdown-item ${currentPath.startsWith('/working-groups') ? 'active' : ''}">Working Groups</a>
            <a href="${councilsUrl}" class="navbar__dropdown-item ${currentPath === '/councils' ? 'active' : ''}">Industry Councils</a>
            <a href="${chaptersUrl}" class="navbar__dropdown-item ${currentPath === '/chapters' ? 'active' : ''}">Regional Chapters</a>
          </div>
        </div>`
      : '';

    // Always use AAO logo
    const logoSrc = '/AAo.svg';
    const logoAlt = 'Agentic Advertising';
    // AAO logo is white, needs invert on light background
    const logoNeedsInvert = true;

    // About AdCP link always shown
    const aboutAdcpLink = '<a href="https://adcontextprotocol.org" class="navbar__link">About AdCP</a>';

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
              ${aboutAdcpLink}
              ${registryDropdown}
              ${perspectivesLink}
              ${committeesDropdown}
              ${aboutDropdown}
            </div>
          </div>
          <div class="navbar__items navbar__items--right">
            <div class="navbar__links-desktop">
              ${user?.isAdmin ? `<a href="/chat" class="navbar__link ${currentPath === '/chat' ? 'active' : ''}">Ask Addie</a>` : ''}
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
          ${aboutAdcpLink}
          <span class="navbar__link navbar__link--header">Registry</span>
          <a href="${membersUrl}" class="navbar__link navbar__link--indent ${currentPath === '/members' || currentPath.startsWith('/members/') ? 'active' : ''}">Members</a>
          <a href="${agentsUrl}" class="navbar__link navbar__link--indent ${currentPath === '/registry' ? 'active' : ''}">Agents</a>
          <a href="${publishersUrl}" class="navbar__link navbar__link--indent ${currentPath === '/publishers' ? 'active' : ''}">Publishers</a>
          <a href="${propertiesUrl}" class="navbar__link navbar__link--indent ${currentPath === '/properties' ? 'active' : ''}">Properties</a>
          ${perspectivesLink}
          ${membershipEnabled ? `<span class="navbar__link navbar__link--header">Committees</span>` : ''}
          ${membershipEnabled ? `<a href="${workingGroupsUrl}" class="navbar__link navbar__link--indent ${currentPath.startsWith('/working-groups') ? 'active' : ''}">Working Groups</a>` : ''}
          ${membershipEnabled ? `<a href="${councilsUrl}" class="navbar__link navbar__link--indent ${currentPath === '/councils' ? 'active' : ''}">Industry Councils</a>` : ''}
          ${membershipEnabled ? `<a href="${chaptersUrl}" class="navbar__link navbar__link--indent ${currentPath === '/chapters' ? 'active' : ''}">Regional Chapters</a>` : ''}
          <a href="${aboutUrl}" class="navbar__link ${currentPath === '/about' ? 'active' : ''}">About</a>
          <a href="${membershipUrl}" class="navbar__link navbar__link--indent ${currentPath === '/membership' ? 'active' : ''}">Membership</a>
          <a href="${governanceUrl}" class="navbar__link navbar__link--indent ${currentPath === '/governance' ? 'active' : ''}">Governance</a>
          ${user?.isAdmin ? `<a href="/chat" class="navbar__link ${currentPath === '/chat' ? 'active' : ''}">Ask Addie</a>` : ''}
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
        color: var(--aao-primary, #1a36b4);
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

      /* Nav dropdown wrapper for hover menus */
      .navbar__dropdown-wrapper {
        position: relative;
      }

      .navbar__dropdown-trigger {
        display: flex;
        align-items: center;
        background: none;
        border: none;
        cursor: pointer;
        font-size: inherit;
        font-family: inherit;
        padding: 0.5rem 0.75rem;
        padding-bottom: 1rem;
        margin-bottom: -0.5rem;
      }

      .navbar__dropdown--nav {
        display: none;
        position: absolute;
        top: 100%;
        left: 0;
        min-width: 220px;
      }

      .navbar__dropdown-wrapper:hover .navbar__dropdown--nav {
        display: block;
      }

      .navbar__dropdown--nav .navbar__dropdown-item.active {
        color: var(--aao-primary, #1a36b4);
        font-weight: 600;
      }

      .navbar__dropdown-divider {
        height: 1px;
        background: #e5e7eb;
        margin: 0.5rem 0;
      }

      .navbar__dropdown-mcp {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 1rem;
        font-size: 0.75rem;
        color: #6b7280;
      }

      .navbar__mcp-badge {
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
        padding: 0.125rem 0.375rem;
        border-radius: 0.25rem;
        font-size: 0.625rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .navbar__mcp-text {
        color: #9ca3af;
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

        .navbar__dropdown--nav .navbar__dropdown-item.active {
          color: var(--color-primary-400, #60a5fa);
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

      [data-theme="dark"] .navbar__dropdown--nav .navbar__dropdown-item.active {
        color: var(--color-primary-400, #60a5fa);
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

      .navbar__mobile-menu .navbar__link--indent {
        padding-left: 2rem;
        font-size: 0.9rem;
      }

      .navbar__mobile-menu .navbar__link--header {
        padding: 0.75rem 1rem;
        color: #6b7280;
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        cursor: default;
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

  // Build footer HTML
  function buildFooterHTML() {
    const currentYear = new Date().getFullYear();

    return `
      <footer class="aao-footer">
        <div class="aao-footer__inner">
          <div class="aao-footer__columns">
            <div class="aao-footer__column">
              <div class="aao-footer__title">AdCP</div>
              <ul class="aao-footer__list">
                <li><a href="https://docs.adcontextprotocol.org/docs/intro" target="_blank" rel="noopener noreferrer">Getting Started</a></li>
                <li><a href="https://docs.adcontextprotocol.org/docs/signals/overview" target="_blank" rel="noopener noreferrer">Signals Protocol</a></li>
              </ul>
            </div>
            <div class="aao-footer__column">
              <div class="aao-footer__title">adagents.json</div>
              <ul class="aao-footer__list">
                <li><a href="/adagents">Builder</a></li>
                <li><a href="https://docs.adcontextprotocol.org/docs/media-buy/capability-discovery/adagents" target="_blank" rel="noopener noreferrer">Specification</a></li>
              </ul>
            </div>
            <div class="aao-footer__column">
              <div class="aao-footer__title">Developers</div>
              <ul class="aao-footer__list">
                <li><a href="https://github.com/adcontextprotocol/adcp" target="_blank" rel="noopener noreferrer">GitHub</a></li>
                <li><a href="https://join.slack.com/t/agenticads/shared_invite/zt-3h15gj6c0-FRTrD_y4HqmeXDKBl2TDEA" target="_blank" rel="noopener noreferrer">Slack</a></li>
              </ul>
            </div>
            <div class="aao-footer__column">
              <div class="aao-footer__title">Registry</div>
              <ul class="aao-footer__list">
                <li><a href="/members">Members</a></li>
                <li><a href="/registry">Agents</a></li>
                <li><a href="/publishers">Publishers</a></li>
                <li><a href="/properties">Properties</a></li>
              </ul>
            </div>
            <div class="aao-footer__column">
              <div class="aao-footer__title">Organization</div>
              <ul class="aao-footer__list">
                <li><a href="/about">About</a></li>
                <li><a href="/governance">Governance</a></li>
                <li><a href="/membership">Membership</a></li>
              </ul>
            </div>
            <div class="aao-footer__column">
              <div class="aao-footer__title">Legal</div>
              <ul class="aao-footer__list">
                <li><a href="/api/agreement?type=privacy_policy">Privacy Policy</a></li>
                <li><a href="/api/agreement?type=terms_of_service">Terms of Service</a></li>
                <li><a href="/api/agreement?type=bylaws">Bylaws</a></li>
                <li><a href="/api/agreement?type=ip_policy">IP Policy</a></li>
              </ul>
            </div>
          </div>
          <div class="aao-footer__bottom">
            <div class="aao-footer__copyright">
              © ${currentYear} Agentic Advertising Organization
            </div>
          </div>
        </div>
      </footer>
    `;
  }

  // Footer CSS
  const footerCSS = `
    <style>
      .aao-footer {
        background: #1b1b1d;
        color: #9ca3af;
        padding: 2.5rem 1rem 1.5rem;
        margin-top: auto;
      }

      .aao-footer__inner {
        max-width: 1140px;
        margin: 0 auto;
      }

      .aao-footer__columns {
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        gap: 2rem;
        margin-bottom: 2rem;
      }

      .aao-footer__column {
        min-width: 0;
      }

      .aao-footer__title {
        color: #fff;
        font-size: 0.875rem;
        font-weight: 600;
        margin-bottom: 0.75rem;
      }

      .aao-footer__list {
        list-style: none;
        margin: 0;
        padding: 0;
      }

      .aao-footer__list li {
        margin-bottom: 0.5rem;
      }

      .aao-footer__list a {
        color: #9ca3af;
        text-decoration: none;
        font-size: 0.875rem;
        transition: color 0.2s;
      }

      .aao-footer__list a:hover {
        color: #fff;
      }

      .aao-footer__bottom {
        border-top: 1px solid #374151;
        padding-top: 1.5rem;
        text-align: center;
      }

      .aao-footer__copyright {
        font-size: 0.75rem;
        color: #6b7280;
      }

      @media (max-width: 768px) {
        .aao-footer__columns {
          grid-template-columns: repeat(2, 1fr);
          gap: 1.5rem;
        }
      }

      @media (max-width: 480px) {
        .aao-footer__columns {
          grid-template-columns: 1fr;
          gap: 1.5rem;
        }
      }

      /* Sidebar layout support - footer respects sidebar width */
      .dashboard-layout .aao-footer,
      .admin-layout .aao-footer {
        margin-left: 260px;
      }

      @media (max-width: 768px) {
        .dashboard-layout .aao-footer,
        .admin-layout .aao-footer {
          margin-left: 0;
        }
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

  // Insert CSS, navigation, and footer when DOM is ready
  function insertNav() {
    // Add CSS to head first
    document.head.insertAdjacentHTML('beforeend', navCSS);
    document.head.insertAdjacentHTML('beforeend', footerCSS);

    // Read config from embedded script (injected by server) - no async fetch needed
    // Falls back to defaults if config not embedded (e.g., static file serving without middleware)
    const config = window.__APP_CONFIG__ || { membershipEnabled: true, authEnabled: false, user: null };

    const navHTML = buildNavHTML(config);

    // Find placeholder or insert at start of body
    const placeholder = document.getElementById('adcp-nav');
    if (placeholder) {
      placeholder.outerHTML = navHTML;
    } else {
      document.body.insertAdjacentHTML('afterbegin', navHTML);
    }

    // Insert footer at end of body (or replace placeholder if exists)
    const footerPlaceholder = document.getElementById('adcp-footer');
    if (footerPlaceholder) {
      footerPlaceholder.outerHTML = buildFooterHTML();
    } else {
      // Only auto-insert footer if there's no existing footer element
      // This prevents duplicate footers on pages like index.html that have their own
      const existingFooter = document.querySelector('footer');
      if (!existingFooter) {
        document.body.insertAdjacentHTML('beforeend', buildFooterHTML());
      }
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
