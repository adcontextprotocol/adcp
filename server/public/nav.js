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

  // Skip when running inside an iframe (native app embeds the page)
  // The native app provides its own header/navigation
  if (window.self !== window.top) {
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
  let brandUrl = `${aaoBaseUrl}/brand`;
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
      brandUrl = `http://localhost:${likelyHttpPort}/brand`;
      membersUrl = `http://localhost:${likelyHttpPort}/members`;
      homeUrl = `http://localhost:${likelyHttpPort}`;
      apiBaseUrl = `http://localhost:${likelyHttpPort}`;
    } else {
      // We're on HTTP server, use relative links for same-server pages
      docsUrl = `http://localhost:${likelyMintlifyPort}`;
      adagentsUrl = '/adagents';
      brandUrl = '/brand';
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

    // Registry URLs used in Projects dropdown and mobile menu
    const agentsUrl = isLocal ? '/registry' : `${aaoBaseUrl}/registry`;
    const brandsUrl = isLocal ? '/brands' : `${aaoBaseUrl}/brands`;
    const publishersUrl = isLocal ? '/publishers' : `${aaoBaseUrl}/publishers`;

    // Build about dropdown (only on beta site - links to trade association)
    // Includes About page, Membership page, and Governance page
    const aboutUrl = isLocal ? '/about' : 'https://agenticadvertising.org/about';
    const membershipUrl = isLocal ? '/membership' : 'https://agenticadvertising.org/membership';
    const governanceUrl = isLocal ? '/governance' : 'https://agenticadvertising.org/governance';
    const aboutDropdown = membershipEnabled
      ? `<div class="navbar__dropdown-wrapper">
          <button class="navbar__link navbar__dropdown-trigger ${currentPath === '/about' || currentPath === '/membership' || currentPath === '/governance' ? 'active' : ''}">
            About
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

    // Build Projects dropdown
    const adagentsUrlLocal = isLocal ? '/adagents' : `${aaoBaseUrl}/adagents`;
    const brandUrlLocal = isLocal ? '/brand' : `${aaoBaseUrl}/brand`;
    const isProjectsActive = currentPath === '/adagents' || currentPath.startsWith('/adagents/') ||
                             currentPath === '/brand' || currentPath.startsWith('/brand/') ||
                             currentPath === '/members' || currentPath.startsWith('/members/') ||
                             currentPath === '/registry' || currentPath === '/brands' || currentPath === '/publishers';
    const projectsDropdown = `<div class="navbar__dropdown-wrapper">
          <button class="navbar__link navbar__dropdown-trigger ${isProjectsActive ? 'active' : ''}">
            Projects
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" style="margin-left: 4px;">
              <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.5" fill="none"/>
            </svg>
          </button>
          <div class="navbar__dropdown navbar__dropdown--nav">
            <a href="https://adcontextprotocol.org" class="navbar__dropdown-item">AdCP</a>
            <a href="${adagentsUrlLocal}" class="navbar__dropdown-item ${currentPath === '/adagents' || currentPath.startsWith('/adagents/') ? 'active' : ''}">adagents.json</a>
            <a href="${brandUrlLocal}" class="navbar__dropdown-item ${currentPath === '/brand' || currentPath.startsWith('/brand/') ? 'active' : ''}">brand.json</a>
            <div class="navbar__dropdown-divider"></div>
            <span class="navbar__dropdown-header-text">Registry</span>
            <div class="navbar__dropdown-search">
              <input type="search" class="navbar__dropdown-search-input" id="registrySearchInput"
                     placeholder="Search registries..." autocomplete="off" aria-label="Search brands, publishers, and properties" />
              <div class="navbar__dropdown-search-results" id="registrySearchResults" role="listbox" aria-label="Search results"></div>
            </div>
            <a href="${membersUrl}" class="navbar__dropdown-item ${currentPath === '/members' || currentPath.startsWith('/members/') ? 'active' : ''}">Members</a>
            <a href="${agentsUrl}" class="navbar__dropdown-item ${currentPath === '/registry' ? 'active' : ''}">Agents</a>
            <a href="${brandsUrl}" class="navbar__dropdown-item ${currentPath === '/brands' ? 'active' : ''}">Brands</a>
            <a href="${publishersUrl}" class="navbar__dropdown-item ${currentPath === '/publishers' ? 'active' : ''}">Publishers</a>
          </div>
        </div>`;

    // Build "The Latest" dropdown
    const latestBaseUrl = isLocal ? '/latest' : `${aaoBaseUrl}/latest`;
    const isLatestActive = currentPath.startsWith('/latest') || currentPath.startsWith('/perspectives');
    const latestDropdown = membershipEnabled
      ? `<div class="navbar__dropdown-wrapper">
          <button class="navbar__link navbar__dropdown-trigger ${isLatestActive ? 'active' : ''}">
            The Latest
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" style="margin-left: 4px;">
              <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.5" fill="none"/>
            </svg>
          </button>
          <div class="navbar__dropdown navbar__dropdown--nav">
            <a href="${latestBaseUrl}/perspectives" class="navbar__dropdown-item ${currentPath === '/latest/perspectives' ? 'active' : ''}">Perspectives</a>
            <a href="${latestBaseUrl}/industry-news" class="navbar__dropdown-item ${currentPath === '/latest/industry-news' ? 'active' : ''}">Industry News</a>
            <a href="${latestBaseUrl}/learning" class="navbar__dropdown-item ${currentPath === '/latest/learning' ? 'active' : ''}">Learning Agentic</a>
            <a href="${latestBaseUrl}/announcements" class="navbar__dropdown-item ${currentPath === '/latest/announcements' ? 'active' : ''}">Announcements</a>
          </div>
        </div>`
      : '';

    // Build "Participate" dropdown (combines Events + Committees)
    const eventsUrl = isLocal ? '/events' : `${aaoBaseUrl}/events`;
    const isEventsActive = currentPath.startsWith('/events');
    const committeesBaseUrl = isLocal ? '/committees' : 'https://agenticadvertising.org/committees';
    const meetingsUrl = isLocal ? '/meetings' : 'https://agenticadvertising.org/meetings';
    const workingGroupsUrl = `${committeesBaseUrl}?type=working_group`;
    const councilsUrl = `${committeesBaseUrl}?type=council`;
    const chaptersUrl = `${committeesBaseUrl}?type=chapter`;
    const gatheringsUrl = `${committeesBaseUrl}?type=industry_gathering`;
    const communityHubUrl = isLocal ? '/community' : `${aaoBaseUrl}/community`;
    const communityPeopleUrl = isLocal ? '/community/people' : `${aaoBaseUrl}/community/people`;
    const isCommunityActive = currentPath.startsWith('/community');
    const isCommitteesActive = currentPath.startsWith('/committees') || currentPath.startsWith('/working-groups') || currentPath.startsWith('/industry-gatherings') || currentPath.startsWith('/meetings');
    const isParticipateActive = isEventsActive || isCommitteesActive || isCommunityActive;
    const participateDropdown = membershipEnabled
      ? `<div class="navbar__dropdown-wrapper">
          <button class="navbar__link navbar__dropdown-trigger ${isParticipateActive ? 'active' : ''}">
            Participate
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" style="margin-left: 4px;">
              <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.5" fill="none"/>
            </svg>
          </button>
          <div class="navbar__dropdown navbar__dropdown--nav">
            <a href="${communityHubUrl}" class="navbar__dropdown-item ${currentPath === '/community' ? 'active' : ''}">Community hub</a>
            <a href="${communityPeopleUrl}" class="navbar__dropdown-item ${currentPath.startsWith('/community/people') ? 'active' : ''}">People</a>
            <div class="navbar__dropdown-divider"></div>
            <a href="${eventsUrl}" class="navbar__dropdown-item ${isEventsActive ? 'active' : ''}">Events</a>
            <a href="${committeesBaseUrl}" class="navbar__dropdown-item ${currentPath === '/committees' ? 'active' : ''}">Committees</a>
            <a href="${meetingsUrl}" class="navbar__dropdown-item ${currentPath === '/meetings' ? 'active' : ''}">Meetings</a>
            <div class="navbar__dropdown-divider"></div>
            <a href="${workingGroupsUrl}" class="navbar__dropdown-item">Working Groups</a>
            <a href="${councilsUrl}" class="navbar__dropdown-item">Industry Councils</a>
            <a href="${chaptersUrl}" class="navbar__dropdown-item">Regional Chapters</a>
            <a href="${gatheringsUrl}" class="navbar__dropdown-item ${currentPath === '/industry-gatherings' ? 'active' : ''}">Industry Gatherings</a>
          </div>
        </div>`
      : '';

    // Always use AAO logo
    const logoSrc = '/AAo.svg';
    const logoAlt = 'Agentic Advertising';
    // AAO logo is white, needs invert on light background
    const logoNeedsInvert = true;

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
              ${projectsDropdown}
              ${latestDropdown}
              ${participateDropdown}
              ${aboutDropdown}
            </div>
          </div>
          <div class="navbar__items navbar__items--right">
            <div class="navbar__links-desktop">
              <a href="/chat" class="navbar__link ${currentPath === '/chat' ? 'active' : ''}">Ask Addie</a>
              <a href="${docsUrl}" class="navbar__link">Docs</a>
            </div>
            ${authSection}
            <button class="navbar__search-mobile-btn" id="mobileSearchBtn" aria-label="Search">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            </button>
            <button class="navbar__hamburger" id="mobileMenuBtn" aria-label="Toggle menu" aria-expanded="false" aria-controls="mobileMenu">
              <span class="navbar__hamburger-line"></span>
              <span class="navbar__hamburger-line"></span>
              <span class="navbar__hamburger-line"></span>
            </button>
          </div>
        </div>
        <div class="navbar__backdrop" id="mobileBackdrop" aria-hidden="true" role="presentation"></div>
        <div class="navbar__mobile-menu" id="mobileMenu" role="navigation" aria-label="Mobile navigation">
          <span class="navbar__link navbar__link--header">Projects</span>
          <a href="https://adcontextprotocol.org" class="navbar__link navbar__link--indent">AdCP</a>
          <a href="${adagentsUrl}" class="navbar__link navbar__link--indent ${currentPath === '/adagents' ? 'active' : ''}">adagents.json</a>
          <a href="${brandUrl}" class="navbar__link navbar__link--indent ${currentPath === '/brand' ? 'active' : ''}">brand.json</a>
          <span class="navbar__link navbar__link--subheader">Registry</span>
          <a href="${membersUrl}" class="navbar__link navbar__link--indent ${currentPath === '/members' || currentPath.startsWith('/members/') ? 'active' : ''}">Members</a>
          <a href="${agentsUrl}" class="navbar__link navbar__link--indent ${currentPath === '/registry' ? 'active' : ''}">Agents</a>
          <a href="${brandsUrl}" class="navbar__link navbar__link--indent ${currentPath === '/brands' ? 'active' : ''}">Brands</a>
          <a href="${publishersUrl}" class="navbar__link navbar__link--indent ${currentPath === '/publishers' ? 'active' : ''}">Publishers</a>
          ${membershipEnabled ? `<span class="navbar__link navbar__link--header">The Latest</span>` : ''}
          ${membershipEnabled ? `<a href="${latestBaseUrl}/perspectives" class="navbar__link navbar__link--indent ${currentPath === '/latest/perspectives' ? 'active' : ''}">Perspectives</a>` : ''}
          ${membershipEnabled ? `<a href="${latestBaseUrl}/industry-news" class="navbar__link navbar__link--indent ${currentPath === '/latest/industry-news' ? 'active' : ''}">Industry News</a>` : ''}
          ${membershipEnabled ? `<a href="${latestBaseUrl}/learning" class="navbar__link navbar__link--indent ${currentPath === '/latest/learning' ? 'active' : ''}">Learning Agentic</a>` : ''}
          ${membershipEnabled ? `<a href="${latestBaseUrl}/announcements" class="navbar__link navbar__link--indent ${currentPath === '/latest/announcements' ? 'active' : ''}">Announcements</a>` : ''}
          ${membershipEnabled ? `<span class="navbar__link navbar__link--header">Participate</span>` : ''}
          ${membershipEnabled ? `<a href="${communityHubUrl}" class="navbar__link navbar__link--indent ${currentPath === '/community' ? 'active' : ''}">Community hub</a>` : ''}
          ${membershipEnabled ? `<a href="${communityPeopleUrl}" class="navbar__link navbar__link--indent ${currentPath.startsWith('/community/people') ? 'active' : ''}">People</a>` : ''}
          ${membershipEnabled ? `<a href="${eventsUrl}" class="navbar__link navbar__link--indent ${currentPath === '/events' ? 'active' : ''}">Events</a>` : ''}
          ${membershipEnabled ? `<a href="${committeesBaseUrl}" class="navbar__link navbar__link--indent ${currentPath === '/committees' ? 'active' : ''}">Committees</a>` : ''}
          ${membershipEnabled ? `<a href="${meetingsUrl}" class="navbar__link navbar__link--indent ${currentPath === '/meetings' ? 'active' : ''}">Meetings</a>` : ''}
          ${membershipEnabled ? `<a href="${workingGroupsUrl}" class="navbar__link navbar__link--indent">Working Groups</a>` : ''}
          ${membershipEnabled ? `<a href="${councilsUrl}" class="navbar__link navbar__link--indent">Industry Councils</a>` : ''}
          ${membershipEnabled ? `<a href="${chaptersUrl}" class="navbar__link navbar__link--indent">Regional Chapters</a>` : ''}
          ${membershipEnabled ? `<a href="${gatheringsUrl}" class="navbar__link navbar__link--indent ${currentPath === '/industry-gatherings' ? 'active' : ''}">Industry Gatherings</a>` : ''}
          <span class="navbar__link navbar__link--header">About</span>
          <a href="${aboutUrl}" class="navbar__link navbar__link--indent ${currentPath === '/about' ? 'active' : ''}">About</a>
          <a href="${membershipUrl}" class="navbar__link navbar__link--indent ${currentPath === '/membership' ? 'active' : ''}">Membership</a>
          <a href="${governanceUrl}" class="navbar__link navbar__link--indent ${currentPath === '/governance' ? 'active' : ''}">Governance</a>
          <a href="/chat" class="navbar__link ${currentPath === '/chat' ? 'active' : ''}">Ask Addie</a>
          <a href="${docsUrl}" class="navbar__link">Docs</a>
        </div>
        <div class="navbar__search-overlay" id="searchOverlay">
          <div class="navbar__search-overlay-header">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            <input type="search" class="navbar__search-overlay-input" id="mobileSearchInput"
                   placeholder="Search brands, publishers, properties..."
                   autocomplete="off" aria-label="Search registries" />
            <button class="navbar__search-overlay-close" id="searchOverlayClose" aria-label="Close search">&times;</button>
          </div>
          <div class="navbar__search-overlay-results" id="mobileSearchResults" role="listbox" aria-label="Search results"></div>
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

      .navbar__dropdown-header-text {
        display: block;
        padding: 0.5rem 1rem 0.25rem;
        font-size: 0.7rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: #6b7280;
      }

      /* Search inside dropdown */
      .navbar__dropdown-search {
        padding: 0.375rem 0.75rem;
        position: relative;
      }

      .navbar__dropdown-search-input {
        width: 100%;
        padding: 5px 10px;
        border: 1px solid #e5e7eb;
        border-radius: 0.375rem;
        font-size: 0.8125rem;
        font-family: inherit;
        background: #f9fafb;
        color: #000;
        outline: none;
        transition: border-color 0.2s;
        box-sizing: border-box;
      }

      .navbar__dropdown-search-input::placeholder {
        color: #9ca3af;
      }

      .navbar__dropdown-search-input:focus {
        border-color: var(--aao-primary, #1a36b4);
        background: #fff;
      }

      .navbar__dropdown-search-input::-webkit-search-cancel-button {
        -webkit-appearance: none;
      }

      .navbar__dropdown-search-results {
        display: none;
        max-height: 280px;
        overflow-y: auto;
        border-top: 1px solid #e5e7eb;
        margin-top: 0.375rem;
      }

      .navbar__dropdown-search-results.open {
        display: block;
      }

      .navbar__dropdown-wrapper--pinned .navbar__dropdown--nav {
        display: block;
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

      /* Mobile menu - full screen slide-in for app-like feel */
      .navbar__mobile-menu {
        display: flex;
        flex-direction: column;
        position: fixed;
        top: 60px;
        left: 0;
        right: 0;
        bottom: 0;
        background: #fff;
        border-top: 1px solid #e5e7eb;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
        padding: 0;
        overflow-y: auto;
        -webkit-overflow-scrolling: touch;
        transform: translateX(100%);
        transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        z-index: 999;
        visibility: hidden;
      }

      .navbar__mobile-menu.open {
        transform: translateX(0);
        visibility: visible;
      }

      /* Backdrop overlay when menu is open */
      .navbar__backdrop {
        display: none;
        position: fixed;
        top: 60px;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.3);
        z-index: 998;
        opacity: 0;
        transition: opacity 0.3s ease;
      }

      .navbar__backdrop.open {
        display: block;
        opacity: 1;
      }

      .navbar__mobile-menu .navbar__link {
        padding: 1rem 1.25rem;
        border-radius: 0;
        display: flex;
        align-items: center;
        min-height: 48px;
        border-bottom: 1px solid #e5e7eb;
        font-size: 1rem;
        transition: background-color 0.15s ease;
      }

      .navbar__mobile-menu .navbar__link:hover,
      .navbar__mobile-menu .navbar__link:active {
        background: #f3f4f6;
      }

      .navbar__mobile-menu .navbar__link--indent {
        padding-left: 2.5rem;
        font-size: 0.9375rem;
        background: #fafafa;
      }

      .navbar__mobile-menu .navbar__link--header {
        padding: 1rem 1.25rem 0.5rem;
        color: #6b7280;
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        cursor: default;
        min-height: auto;
        border-bottom: none;
        background: #f9fafb;
        margin-top: 0.5rem;
      }

      .navbar__mobile-menu .navbar__link--header:first-child {
        margin-top: 0;
      }

      .navbar__mobile-menu .navbar__link--subheader {
        padding: 0.75rem 1.25rem 0.25rem;
        color: #9ca3af;
        font-size: 0.6875rem;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        cursor: default;
        min-height: auto;
        border-bottom: none;
        background: #fafafa;
      }

      /* Safe area padding at bottom of mobile menu */
      .navbar__mobile-menu::after {
        content: '';
        display: block;
        padding-bottom: env(safe-area-inset-bottom, 1rem);
      }

      /* Desktop-only links wrapper */
      .navbar__links-desktop {
        display: flex;
        align-items: center;
        gap: 1.5rem;
      }

      /* ========== Search Results (shared by dropdown + mobile overlay) ========== */
      .navbar__search-group {
        padding: 4px 0;
      }

      .navbar__search-group:not(:last-child) {
        border-bottom: 1px solid #e5e7eb;
      }

      .navbar__search-group-header {
        padding: 8px 12px 4px;
        font-size: 0.6875rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: #6b7280;
      }

      .navbar__search-item {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 12px;
        text-decoration: none;
        color: #000;
        font-size: 0.8125rem;
        transition: background-color 0.15s;
        cursor: pointer;
      }

      .navbar__search-item:hover,
      .navbar__search-item.active {
        background: #f3f4f6;
      }

      .navbar__search-item-icon {
        width: 28px;
        height: 28px;
        border-radius: 6px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0.75rem;
        flex-shrink: 0;
      }

      .navbar__search-item-icon--brand {
        background: #eff0ff;
        color: #1a36b4;
      }

      .navbar__search-item-icon--publisher {
        background: #ecfdf5;
        color: #059669;
      }

      .navbar__search-item-icon--property {
        background: #f3e8ff;
        color: #7c3aed;
      }

      .navbar__search-item-content {
        flex: 1;
        min-width: 0;
      }

      .navbar__search-item-title {
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .navbar__search-item-meta {
        font-size: 0.6875rem;
        color: #6b7280;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .navbar__search-empty,
      .navbar__search-loading {
        padding: 16px 12px;
        text-align: center;
        font-size: 0.8125rem;
        color: #6b7280;
      }

      /* Mobile search button */
      .navbar__search-mobile-btn {
        display: none;
        background: none;
        border: none;
        cursor: pointer;
        padding: 4px;
        color: #000;
        line-height: 0;
      }

      /* Mobile search overlay */
      .navbar__search-overlay {
        display: none;
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: #fff;
        z-index: 1002;
        flex-direction: column;
      }

      .navbar__search-overlay.open {
        display: flex;
      }

      .navbar__search-overlay-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 16px;
        border-bottom: 1px solid #e5e7eb;
      }

      .navbar__search-overlay-input {
        flex: 1;
        padding: 8px 12px;
        border: 1px solid #e5e7eb;
        border-radius: 0.5rem;
        font-size: 1rem;
        font-family: inherit;
        outline: none;
        color: #000;
      }

      .navbar__search-overlay-input:focus {
        border-color: var(--aao-primary, #1a36b4);
      }

      .navbar__search-overlay-close {
        font-size: 1.5rem;
        background: none;
        border: none;
        cursor: pointer;
        padding: 4px 8px;
        color: #6b7280;
        line-height: 1;
      }

      .navbar__search-overlay-results {
        flex: 1;
        overflow-y: auto;
        padding: 8px 0;
      }

      .navbar__search-overlay-results .navbar__search-item {
        padding: 12px 16px;
      }

      .navbar__search-overlay-results .navbar__search-group-header {
        padding: 12px 16px 6px;
      }

      /* Mobile responsive breakpoint */
      @media (max-width: 768px) {
        .navbar__links-desktop {
          display: none;
        }

        .navbar__hamburger {
          display: flex;
        }


        .navbar__search-mobile-btn {
          display: block;
        }

        .navbar__items--right {
          gap: 0.75rem;
        }
      }

      /* Dark mode for search */
      @media (prefers-color-scheme: dark) {
        .navbar__dropdown-search-input {
          background: #374151;
          border-color: #4b5563;
          color: #fff;
        }
        .navbar__dropdown-search-input:focus {
          background: #1f2937;
          border-color: var(--color-primary-400, #60a5fa);
        }
        .navbar__dropdown-search-results {
          border-color: #374151;
        }
        .navbar__search-item {
          color: #fff;
        }
        .navbar__search-item:hover,
        .navbar__search-item.active {
          background: #374151;
        }
        .navbar__search-group:not(:last-child) {
          border-color: #374151;
        }
        .navbar__search-mobile-btn {
          color: #fff;
        }
        .navbar__search-overlay {
          background: #1b1b1d;
        }
        .navbar__search-overlay-header {
          border-color: #374151;
        }
        .navbar__search-overlay-input {
          background: #374151;
          border-color: #4b5563;
          color: #fff;
        }
      }

      [data-theme="dark"] .navbar__dropdown-search-input {
        background: #374151;
        border-color: #4b5563;
        color: #fff;
      }
      [data-theme="dark"] .navbar__dropdown-search-input:focus {
        background: #1f2937;
        border-color: var(--color-primary-400, #60a5fa);
      }
      [data-theme="dark"] .navbar__dropdown-search-results {
        border-color: #374151;
      }
      [data-theme="dark"] .navbar__search-item {
        color: #fff;
      }
      [data-theme="dark"] .navbar__search-item:hover,
      [data-theme="dark"] .navbar__search-item.active {
        background: #374151;
      }
      [data-theme="dark"] .navbar__search-mobile-btn {
        color: #fff;
      }
      [data-theme="dark"] .navbar__search-overlay {
        background: #1b1b1d;
      }
      [data-theme="dark"] .navbar__search-overlay-header {
        border-color: #374151;
      }
      [data-theme="dark"] .navbar__search-overlay-input {
        background: #374151;
        border-color: #4b5563;
        color: #fff;
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

        .navbar__mobile-menu .navbar__link {
          border-bottom-color: #374151;
        }

        .navbar__mobile-menu .navbar__link:hover,
        .navbar__mobile-menu .navbar__link:active {
          background: rgba(255, 255, 255, 0.1);
        }

        .navbar__mobile-menu .navbar__link--indent {
          background: #141414;
        }

        .navbar__mobile-menu .navbar__link--header {
          background: #111;
        }

        .navbar__mobile-menu .navbar__link--subheader {
          background: #141414;
        }

        .navbar__backdrop {
          background: rgba(0, 0, 0, 0.5);
        }
      }

      [data-theme="dark"] .navbar__hamburger-line {
        background: #fff;
      }

      [data-theme="dark"] .navbar__mobile-menu {
        background: #1b1b1d;
        border-top-color: #374151;
      }

      [data-theme="dark"] .navbar__mobile-menu .navbar__link {
        border-bottom-color: #374151;
      }

      [data-theme="dark"] .navbar__mobile-menu .navbar__link:hover,
      [data-theme="dark"] .navbar__mobile-menu .navbar__link:active {
        background: rgba(255, 255, 255, 0.1);
      }

      [data-theme="dark"] .navbar__mobile-menu .navbar__link--indent {
        background: #141414;
      }

      [data-theme="dark"] .navbar__mobile-menu .navbar__link--header {
        background: #111;
      }

      [data-theme="dark"] .navbar__mobile-menu .navbar__link--subheader {
        background: #141414;
      }

      [data-theme="dark"] .navbar__backdrop {
        background: rgba(0, 0, 0, 0.5);
      }

      /* Respect reduced motion preferences */
      @media (prefers-reduced-motion: reduce) {
        .navbar__mobile-menu {
          transition: none;
        }
        .navbar__backdrop {
          transition: none;
        }
        .navbar__hamburger-line {
          transition: none;
        }
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
                <li><a href="/adagents/builder">Builder</a></li>
                <li><a href="https://docs.adcontextprotocol.org/docs/media-buy/capability-discovery/adagents" target="_blank" rel="noopener noreferrer">Specification</a></li>
              </ul>
            </div>
            <div class="aao-footer__column">
              <div class="aao-footer__title">brand.json</div>
              <ul class="aao-footer__list">
                <li><a href="/brand/builder">Builder</a></li>
                <li><a href="https://docs.adcontextprotocol.org/docs/brand-protocol/brand-json" target="_blank" rel="noopener noreferrer">Specification</a></li>
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
                <li><a href="/brands">Brands</a></li>
                <li><a href="/publishers">Publishers</a></li>
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
                <li><a href="/api/agreement?type=terms_of_service">Terms of Use</a></li>
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
    const mobileBackdrop = document.getElementById('mobileBackdrop');

    // Helper to toggle mobile menu state
    function toggleMobileMenu(open) {
      const isOpen = open !== undefined ? open : !mobileMenu.classList.contains('open');

      // Update aria-expanded for accessibility
      mobileMenuBtn.setAttribute('aria-expanded', String(isOpen));

      if (isOpen) {
        mobileMenuBtn.classList.add('open');
        mobileMenu.classList.add('open');
        if (mobileBackdrop) mobileBackdrop.classList.add('open');
        // Prevent body scroll when menu is open
        document.body.style.overflow = 'hidden';
        // Focus first interactive element in menu for accessibility
        const firstLink = mobileMenu.querySelector('a.navbar__link');
        if (firstLink) firstLink.focus();
      } else {
        mobileMenuBtn.classList.remove('open');
        mobileMenu.classList.remove('open');
        if (mobileBackdrop) mobileBackdrop.classList.remove('open');
        // Restore body scroll
        document.body.style.overflow = '';
        // Return focus to hamburger button
        mobileMenuBtn.focus();
      }
    }

    // Account dropdown toggle
    if (accountBtn && accountDropdown) {
      accountBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        accountDropdown.classList.toggle('open');
        // Close mobile menu if open
        if (mobileMenu && mobileMenu.classList.contains('open')) {
          toggleMobileMenu(false);
        }
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
        toggleMobileMenu();
        // Close account dropdown if open
        if (accountDropdown) accountDropdown.classList.remove('open');
      });

      // Close mobile menu when clicking a link
      mobileMenu.querySelectorAll('.navbar__link:not(.navbar__link--header):not(.navbar__link--subheader)').forEach(link => {
        link.addEventListener('click', () => {
          toggleMobileMenu(false);
        });
      });

      // Close mobile menu when clicking backdrop
      if (mobileBackdrop) {
        mobileBackdrop.addEventListener('click', () => {
          toggleMobileMenu(false);
        });
      }
    }

    // Close all menus when clicking outside
    document.addEventListener('click', (e) => {
      if (accountDropdown) accountDropdown.classList.remove('open');
      if (mobileMenu && mobileMenu.classList.contains('open')) {
        toggleMobileMenu(false);
      }
      // Close registry search results if clicking outside
      const regSearchResults = document.getElementById('registrySearchResults');
      const regSearchInput = document.getElementById('registrySearchInput');
      if (regSearchResults && regSearchInput && !regSearchInput.contains(e.target) && !regSearchResults.contains(e.target)) {
        regSearchResults.classList.remove('open');
      }
    });

    // Close menu on escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (accountDropdown) accountDropdown.classList.remove('open');
        if (mobileMenu && mobileMenu.classList.contains('open')) {
          toggleMobileMenu(false);
        }
        // Close registry search and unpin dropdown
        const regSearchEl = document.getElementById('registrySearchInput');
        const regResults = document.getElementById('registrySearchResults');
        if (regResults) regResults.classList.remove('open');
        if (regSearchEl) regSearchEl.blur();
        const searchOverlay = document.getElementById('searchOverlay');
        if (searchOverlay && searchOverlay.classList.contains('open')) {
          searchOverlay.classList.remove('open');
          document.body.style.overflow = '';
        }
      }
    });
  }

  // Global search functionality
  function setupGlobalSearch() {
    const registrySearchInput = document.getElementById('registrySearchInput');
    const registrySearchResults = document.getElementById('registrySearchResults');
    const mobileSearchBtn = document.getElementById('mobileSearchBtn');
    const searchOverlay = document.getElementById('searchOverlay');
    const mobileSearchInput = document.getElementById('mobileSearchInput');
    const mobileSearchResults = document.getElementById('mobileSearchResults');
    const searchOverlayClose = document.getElementById('searchOverlayClose');

    let searchTimeout;
    let searchAbortController;
    let activeIndex = -1;

    function escapeHtml(str) {
      if (!str) return '';
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    function renderResults(data, container) {
      const totalResults = (data.brands?.length || 0) +
                           (data.publishers?.length || 0) +
                           (data.properties?.length || 0);

      if (totalResults === 0) {
        container.innerHTML = '<div class="navbar__search-empty">No results found</div>';
        return;
      }

      let html = '';

      if (data.brands && data.brands.length > 0) {
        html += '<div class="navbar__search-group">';
        html += '<div class="navbar__search-group-header">Brands</div>';
        data.brands.forEach(function(brand) {
          html += '<a href="/brand/view/' + encodeURIComponent(brand.domain) + '" class="navbar__search-item" role="option">';
          html += '<div class="navbar__search-item-icon navbar__search-item-icon--brand">B</div>';
          html += '<div class="navbar__search-item-content">';
          html += '<div class="navbar__search-item-title">' + escapeHtml(brand.brand_name || brand.domain) + '</div>';
          html += '<div class="navbar__search-item-meta">' + escapeHtml(brand.domain) + '</div>';
          html += '</div></a>';
        });
        html += '</div>';
      }

      // Merge publishers (member-org) and properties (registry) into one group
      var allPublishers = [];
      var seenDomains = {};
      if (data.properties && data.properties.length > 0) {
        data.properties.forEach(function(prop) {
          allPublishers.push({ domain: prop.domain, meta: prop.source + (prop.property_count ? ' \u00b7 ' + prop.property_count + ' properties' : '') });
          seenDomains[prop.domain] = true;
        });
      }
      if (data.publishers && data.publishers.length > 0) {
        data.publishers.forEach(function(pub) {
          if (!seenDomains[pub.domain]) {
            allPublishers.push({ domain: pub.domain, meta: pub.member && pub.member.display_name ? pub.member.display_name : '' });
            seenDomains[pub.domain] = true;
          }
        });
      }
      if (allPublishers.length > 0) {
        html += '<div class="navbar__search-group">';
        html += '<div class="navbar__search-group-header">Publishers</div>';
        allPublishers.forEach(function(pub) {
          html += '<a href="/property/view/' + encodeURIComponent(pub.domain) + '" class="navbar__search-item" role="option">';
          html += '<div class="navbar__search-item-icon navbar__search-item-icon--publisher">P</div>';
          html += '<div class="navbar__search-item-content">';
          html += '<div class="navbar__search-item-title">' + escapeHtml(pub.domain) + '</div>';
          if (pub.meta) {
            html += '<div class="navbar__search-item-meta">' + escapeHtml(pub.meta) + '</div>';
          }
          html += '</div></a>';
        });
        html += '</div>';
      }

      container.innerHTML = html;
    }

    async function performSearch(query, resultsContainer) {
      if (searchAbortController) {
        searchAbortController.abort();
      }
      searchAbortController = new AbortController();

      resultsContainer.innerHTML = '<div class="navbar__search-loading">Searching...</div>';
      if (!resultsContainer.classList.contains('open')) {
        resultsContainer.classList.add('open');
      }

      try {
        const response = await fetch('/api/search?q=' + encodeURIComponent(query), {
          signal: searchAbortController.signal
        });
        if (!response.ok) throw new Error('Search failed');
        const data = await response.json();
        renderResults(data, resultsContainer);
        activeIndex = -1;
      } catch (error) {
        if (error.name === 'AbortError') return;
        resultsContainer.innerHTML = '<div class="navbar__search-empty">Search failed</div>';
      }
    }

    function handleInput(input, resultsContainer) {
      const query = input.value.trim();
      if (query.length < 2) {
        resultsContainer.classList.remove('open');
        resultsContainer.innerHTML = '';
        return;
      }
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(function() {
        performSearch(query, resultsContainer);
      }, 300);
    }

    function handleKeydown(e, resultsContainer) {
      const items = resultsContainer.querySelectorAll('.navbar__search-item');
      if (!items.length) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIndex = Math.min(activeIndex + 1, items.length - 1);
        updateActive(items);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIndex = Math.max(activeIndex - 1, -1);
        updateActive(items);
      } else if (e.key === 'Enter' && activeIndex >= 0 && items[activeIndex]) {
        e.preventDefault();
        items[activeIndex].click();
      }
    }

    function updateActive(items) {
      items.forEach(function(item, i) {
        if (i === activeIndex) {
          item.classList.add('active');
          item.scrollIntoView({ block: 'nearest' });
        } else {
          item.classList.remove('active');
        }
      });
    }

    // Registry search inside Projects dropdown
    if (registrySearchInput && registrySearchResults) {
      // Pin the dropdown open while search input is focused or has results
      const dropdownWrapper = registrySearchInput.closest('.navbar__dropdown-wrapper');

      function pinDropdown(pin) {
        if (dropdownWrapper) {
          dropdownWrapper.classList.toggle('navbar__dropdown-wrapper--pinned', pin);
        }
      }

      registrySearchInput.addEventListener('focus', function() {
        pinDropdown(true);
      });

      registrySearchInput.addEventListener('blur', function() {
        // Delay to allow click on search results
        setTimeout(function() {
          if (!registrySearchInput.matches(':focus')) {
            pinDropdown(false);
            registrySearchResults.classList.remove('open');
          }
        }, 200);
      });

      // Stop click events from bubbling (prevents dropdown close)
      registrySearchInput.addEventListener('click', function(e) {
        e.stopPropagation();
      });
      registrySearchResults.addEventListener('click', function(e) {
        e.stopPropagation();
      });

      registrySearchInput.addEventListener('input', function() {
        handleInput(registrySearchInput, registrySearchResults);
      });
      registrySearchInput.addEventListener('keydown', function(e) {
        handleKeydown(e, registrySearchResults);
      });
    }

    // Mobile search overlay
    if (mobileSearchBtn && searchOverlay) {
      mobileSearchBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        searchOverlay.classList.add('open');
        document.body.style.overflow = 'hidden';
        if (mobileSearchInput) {
          setTimeout(function() { mobileSearchInput.focus(); }, 100);
        }
      });
    }

    if (searchOverlayClose && searchOverlay) {
      searchOverlayClose.addEventListener('click', function() {
        searchOverlay.classList.remove('open');
        document.body.style.overflow = '';
        if (mobileSearchInput) {
          mobileSearchInput.value = '';
        }
        if (mobileSearchResults) {
          mobileSearchResults.innerHTML = '';
        }
      });
    }

    if (mobileSearchInput && mobileSearchResults) {
      mobileSearchInput.addEventListener('input', function() {
        handleInput(mobileSearchInput, mobileSearchResults);
      });
      mobileSearchInput.addEventListener('keydown', function(e) {
        handleKeydown(e, mobileSearchResults);
      });
    }
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

    // Setup dropdown toggle and global search
    setupDropdown();
    setupGlobalSearch();
  }

  // Run when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', insertNav);
  } else {
    insertNav();
  }
})();
