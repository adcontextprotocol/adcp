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

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Determine if running locally
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';

  // All sites use identical AAO-branded navigation
  // AAO content (members, insights, about) always lives on agenticadvertising.org
  // Docs always live on docs.adcontextprotocol.org
  const aaoBaseUrl = 'https://agenticadvertising.org';
  let docsUrl = 'https://docs.adcontextprotocol.org';
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
      homeUrl = `http://localhost:${likelyHttpPort}`;
      apiBaseUrl = `http://localhost:${likelyHttpPort}`;
    } else {
      // We're on HTTP server, use relative links for same-server pages
      docsUrl = `http://localhost:${likelyMintlifyPort}`;
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
        const manageLink = user.isManage ? `<a href="${authBaseUrl}/manage" class="navbar__dropdown-item">Manage AAO</a>` : '';
        const adminLink = user.isAdmin ? `<a href="${authBaseUrl}/admin" class="navbar__dropdown-item">Admin</a>` : '';
        authSection = `
          <button class="navbar__notif-btn" id="notifBell" aria-label="Notifications">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
              <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
            </svg>
            <span class="navbar__notif-badge" id="notifBadge" style="display:none;"></span>
          </button>
          <div class="navbar__notif-dropdown" id="notifDropdown">
            <div class="navbar__notif-header">
              <span>Notifications</span>
              <a href="${authBaseUrl}/community/notifications" class="navbar__notif-view-all">View all</a>
            </div>
            <div class="navbar__notif-list" id="notifList"></div>
          </div>
          <div class="navbar__account">
            <button class="navbar__account-btn" id="accountMenuBtn">
              <span class="navbar__account-avatar" id="accountAvatar">${escapeHtml((user.firstName || '')[0] || user.email[0]).toUpperCase()}</span>
              <span class="navbar__account-name">${escapeHtml(displayName)}</span>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                <path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" stroke-width="1.5" fill="none"/>
              </svg>
            </button>
            <div class="navbar__dropdown" id="accountDropdown">
              <div class="navbar__dropdown-header">${escapeHtml(user.email)}</div>
              <a href="${authBaseUrl}/dashboard" class="navbar__dropdown-item">Dashboard</a>
              <a href="${authBaseUrl}/community/profile/edit" class="navbar__dropdown-item">Edit profile</a>
              ${manageLink}
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

    const isStoriesActive = currentPath.startsWith('/stories') || currentPath.startsWith('/explore') || currentPath.startsWith('/perspectives') || currentPath.startsWith('/latest');
    const isCertificationActive = currentPath.startsWith('/academy') || currentPath.startsWith('/certification') || currentPath.startsWith('/study-guide');
    const isCommunityActive = currentPath.startsWith('/community') || currentPath.startsWith('/events') || currentPath.startsWith('/committees') || currentPath.startsWith('/meetings');
    const isRegistryActive = currentPath === '/registry'
      || currentPath.startsWith('/registry/')
      || currentPath === '/agents'
      || currentPath === '/brands'
      || currentPath === '/publishers'
      || currentPath.startsWith('/brand')
      || currentPath.startsWith('/adagents')
      || currentPath.startsWith('/property/view');
    const communityUrl = isLocal ? '/community' : 'https://agenticadvertising.org/community';
    const membershipUrl = isLocal ? '/membership' : 'https://agenticadvertising.org/membership';

    // Contextual CTA: "Dashboard" for logged-in users, "Get started" for visitors
    const ctaText = user ? 'Dashboard' : 'Get started';
    const ctaUrl = user ? `${authBaseUrl}/dashboard` : membershipUrl;

    // Always use AAO logo
    const logoSrc = '/AAo.svg';
    const logoAlt = 'Agentic Advertising';
    // AAO logo is white, needs invert on light background
    const logoNeedsInvert = true;

    // Founding member banner — show for anonymous users only, dismissible
    const foundingBanner = !user ? `
      <div class="founding-banner" id="foundingBanner">
        <div class="founding-banner__inner">
          <span class="founding-banner__text"><strong>Founding member window closes March 31.</strong> Lock in permanent rates and shape the standards from day one.</span>
          <a href="${membershipUrl}" class="founding-banner__cta">Learn more &rarr;</a>
          <button class="founding-banner__close" id="foundingBannerClose" aria-label="Dismiss">&times;</button>
        </div>
      </div>
    ` : '';

    return `
      ${foundingBanner}
      <nav class="navbar" ${!user ? 'style="top: var(--founding-banner-height, 0px)"' : ''}>
        <div class="navbar__inner">
          <div class="navbar__items">
            <a class="navbar__brand" href="${homeUrl}">
              <div class="navbar__logo">
                <img src="${logoSrc}" alt="${logoAlt}" class="navbar__logo-img" ${logoNeedsInvert ? 'data-invert="true"' : ''}>
              </div>
            </a>
            <div class="navbar__links-desktop">
              <a href="/stories" class="navbar__link ${isStoriesActive ? 'active' : ''}">Stories</a>
              <a href="/academy" class="navbar__link ${isCertificationActive ? 'active' : ''}">Academy</a>
              <a href="/chat" class="navbar__link ${currentPath === '/chat' ? 'active' : ''}">Ask Addie</a>
              <a href="${communityUrl}" class="navbar__link ${isCommunityActive ? 'active' : ''}">Community</a>
              <a href="${ctaUrl}" class="navbar__btn--cta">${ctaText}</a>
            </div>
          </div>
          <div class="navbar__items navbar__items--right">
            <div class="navbar__links-desktop">
              <div class="navbar__divider"></div>
              <a href="/registry" class="navbar__link ${isRegistryActive ? 'active' : ''}">Registry</a>
              <a href="${docsUrl}" class="navbar__link">AdCP Docs</a>
            </div>
            ${authSection}
            <button class="navbar__hamburger" id="mobileMenuBtn" aria-label="Toggle menu" aria-expanded="false" aria-controls="mobileMenu">
              <span class="navbar__hamburger-line"></span>
              <span class="navbar__hamburger-line"></span>
              <span class="navbar__hamburger-line"></span>
            </button>
          </div>
        </div>
        <div class="navbar__backdrop" id="mobileBackdrop" aria-hidden="true" role="presentation"></div>
        <div class="navbar__mobile-menu" id="mobileMenu" role="navigation" aria-label="Mobile navigation">
          <a href="/stories" class="navbar__link ${isStoriesActive ? 'active' : ''}">Stories</a>
          <a href="/academy" class="navbar__link ${isCertificationActive ? 'active' : ''}">Academy</a>
          <a href="/chat" class="navbar__link ${currentPath === '/chat' ? 'active' : ''}">Ask Addie</a>
          <a href="${communityUrl}" class="navbar__link ${isCommunityActive ? 'active' : ''}">Community</a>
          <a href="${ctaUrl}" class="navbar__link ${currentPath === '/membership' || currentPath === '/dashboard' ? 'active' : ''}">${ctaText}</a>
          <a href="/registry" class="navbar__link ${isRegistryActive ? 'active' : ''}">Registry</a>
          <a href="${docsUrl}" class="navbar__link">AdCP Docs</a>
        </div>
      </nav>
    `;
  }

  // Navigation CSS
  const navCSS = `
    <style>
      /* Founding member banner */
      :root {
        --founding-banner-height: 0px;
      }
      .founding-banner {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        z-index: 1001;
        background: linear-gradient(90deg, #1a36b4 0%, #2d4eb4 100%);
        color: #fff;
        font-size: 0.8125rem;
        line-height: 1.4;
      }
      .founding-banner__inner {
        max-width: 1140px;
        margin: 0 auto;
        padding: 0.5rem 1rem;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.75rem;
      }
      .founding-banner__text {
        text-align: center;
      }
      .founding-banner__text strong {
        font-weight: 700;
      }
      .founding-banner__cta {
        color: #fff;
        text-decoration: none;
        font-weight: 600;
        white-space: nowrap;
        opacity: 0.9;
      }
      .founding-banner__cta:hover { opacity: 1; text-decoration: underline; }
      .founding-banner__close {
        background: none;
        border: none;
        color: rgba(255,255,255,0.6);
        font-size: 1.25rem;
        cursor: pointer;
        padding: 0 0.25rem;
        line-height: 1;
      }
      .founding-banner__close:hover { color: #fff; }
      .founding-banner--hidden { display: none; }
      @media (max-width: 600px) {
        .founding-banner__inner { flex-wrap: wrap; font-size: 0.75rem; padding: 0.375rem 0.75rem; }
      }

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

      /* CTA button */
      .navbar__btn--cta {
        display: inline-flex;
        align-items: center;
        padding: 6px 16px;
        background: var(--color-brand);
        color: white !important;
        border-radius: var(--radius-md, 6px);
        font-size: 14px;
        font-weight: 600;
        text-decoration: none;
        transition: background 0.15s ease;
        border: none;
        cursor: pointer;
      }
      .navbar__btn--cta:hover {
        background: var(--color-brand-hover);
        text-decoration: none;
      }

      /* Vertical divider between left and right nav items */
      .navbar__divider {
        width: 1px;
        height: 20px;
        background: var(--color-border, #e2e8f0);
        margin: 0 8px;
        align-self: center;
      }

      /* Notification bell */
      .navbar__notif-btn {
        position: relative;
        background: none;
        border: none;
        cursor: pointer;
        padding: 0.375rem;
        color: var(--color-gray-500);
        transition: color 0.2s;
        display: flex;
        align-items: center;
      }
      .navbar__notif-btn:hover { color: var(--color-gray-900); }
      .navbar__notif-badge {
        position: absolute;
        top: 2px;
        right: 0;
        min-width: 16px;
        height: 16px;
        padding: 0 4px;
        background: var(--color-error-500);
        color: #fff;
        font-size: 10px;
        font-weight: 700;
        border-radius: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        line-height: 1;
      }
      .navbar__notif-dropdown {
        display: none;
        position: absolute;
        top: calc(100% + 0.5rem);
        right: 0;
        width: 360px;
        max-height: 420px;
        background: var(--color-bg-card);
        border: 1px solid var(--color-border);
        border-radius: 0.5rem;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        z-index: 1002;
        overflow: hidden;
      }
      .navbar__notif-dropdown.open { display: block; }
      .navbar__notif-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 0.75rem 1rem;
        border-bottom: 1px solid var(--color-border);
        font-weight: 600;
        font-size: 0.875rem;
      }
      .navbar__notif-view-all {
        font-size: 0.75rem;
        color: var(--color-brand);
        text-decoration: none;
        font-weight: 500;
      }
      .navbar__notif-view-all:hover { text-decoration: underline; }
      .navbar__notif-list {
        max-height: 340px;
        overflow-y: auto;
      }
      .navbar__notif-item {
        display: flex;
        align-items: flex-start;
        gap: 0.625rem;
        padding: 0.625rem 1rem;
        text-decoration: none;
        color: inherit;
        transition: background 0.15s;
        border-bottom: 1px solid var(--color-gray-100);
      }
      .navbar__notif-item:hover { background: var(--color-bg-subtle); }
      .navbar__notif-item.unread { background: var(--color-primary-50); }
      .navbar__notif-item-avatar {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        background: var(--gradient-primary);
        color: #fff;
        font-size: 10px;
        font-weight: 700;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        overflow: hidden;
      }
      .navbar__notif-item-avatar img { width: 100%; height: 100%; object-fit: cover; }
      .navbar__notif-item-text {
        font-size: 0.8125rem;
        line-height: 1.35;
        color: var(--color-gray-700);
      }
      .navbar__notif-item-time {
        font-size: 0.6875rem;
        color: var(--color-text-muted);
        margin-top: 2px;
      }
      .navbar__notif-empty {
        padding: 2rem 1rem;
        text-align: center;
        color: var(--color-text-muted);
        font-size: 0.8125rem;
      }

      /* Account dropdown */
      .navbar__account {
        position: relative;
      }

      .navbar__account-avatar {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        background: linear-gradient(135deg, #b45309, #d97706);
        color: #fff;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0.75rem;
        font-weight: 600;
        flex-shrink: 0;
        overflow: hidden;
      }
      .navbar__account-avatar img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        border-radius: 50%;
      }

      .navbar__account-btn {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.35rem 0.75rem 0.35rem 0.35rem;
        background: transparent;
        border: 1px solid #e5e7eb;
        border-radius: 9999px;
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
        body:not([data-nav-theme="light"]) .navbar {
          background: #1b1b1d;
          box-shadow: 0 1px 2px 0 rgba(255,255,255,.1);
        }

        body:not([data-nav-theme="light"]) .navbar__title,
        body:not([data-nav-theme="light"]) .navbar__link {
          color: #fff;
        }

        body:not([data-nav-theme="light"]) .navbar__link:hover {
          background: rgba(255, 255, 255, 0.1);
        }

        body:not([data-nav-theme="light"]) .navbar__account-btn {
          color: #fff;
          border-color: #374151;
        }

        body:not([data-nav-theme="light"]) .navbar__account-btn:hover {
          background: rgba(255, 255, 255, 0.1);
          border-color: #4b5563;
        }

        body:not([data-nav-theme="light"]) .navbar__dropdown {
          background: #1f2937;
          border-color: #374151;
        }

        body:not([data-nav-theme="light"]) .navbar__dropdown-header {
          background: #111827;
          border-color: #374151;
          color: #9ca3af;
        }

        body:not([data-nav-theme="light"]) .navbar__dropdown-item {
          color: #fff;
        }

        body:not([data-nav-theme="light"]) .navbar__dropdown-item:hover {
          background: #374151;
        }

        body:not([data-nav-theme="light"]) .navbar__dropdown-item--danger:hover {
          background: #7f1d1d;
        }

        /* In dark mode, remove invert filter for AAO logo (it's already white) */
        body:not([data-nav-theme="light"]) .navbar__logo-img[data-invert="true"] {
          filter: none;
        }

        body:not([data-nav-theme="light"]) .navbar__btn--cta {
          background: var(--color-primary-400, #60a5fa);
          color: #1b1b1d !important;
        }
        body:not([data-nav-theme="light"]) .navbar__btn--cta:hover {
          background: var(--color-primary-300, #93c5fd);
        }

        body:not([data-nav-theme="light"]) .navbar__divider {
          background: #374151;
        }
      }

      body[data-theme="dark"]:not([data-nav-theme="light"]) .navbar {
        background: #1b1b1d;
        box-shadow: 0 1px 2px 0 rgba(255,255,255,.1);
      }

      body[data-theme="dark"]:not([data-nav-theme="light"]) .navbar__title,
      body[data-theme="dark"]:not([data-nav-theme="light"]) .navbar__link {
        color: #fff;
      }

      body[data-theme="dark"]:not([data-nav-theme="light"]) .navbar__link:hover {
        background: rgba(255, 255, 255, 0.1);
      }

      body[data-theme="dark"]:not([data-nav-theme="light"]) .navbar__account-btn {
        color: #fff;
        border-color: #374151;
      }

      body[data-theme="dark"]:not([data-nav-theme="light"]) .navbar__account-btn:hover {
        background: rgba(255, 255, 255, 0.1);
        border-color: #4b5563;
      }

      body[data-theme="dark"]:not([data-nav-theme="light"]) .navbar__dropdown {
        background: #1f2937;
        border-color: #374151;
      }

      body[data-theme="dark"]:not([data-nav-theme="light"]) .navbar__dropdown-header {
        background: #111827;
        border-color: #374151;
        color: #9ca3af;
      }

      body[data-theme="dark"]:not([data-nav-theme="light"]) .navbar__dropdown-item {
        color: #fff;
      }

      body[data-theme="dark"]:not([data-nav-theme="light"]) .navbar__dropdown-item:hover {
        background: #374151;
      }

      body[data-theme="dark"]:not([data-nav-theme="light"]) .navbar__dropdown-item--danger:hover {
        background: #7f1d1d;
      }

      /* In dark mode, remove invert filter for AAO logo */
      body[data-theme="dark"]:not([data-nav-theme="light"]) .navbar__logo-img[data-invert="true"] {
        filter: none;
      }

      body[data-theme="dark"]:not([data-nav-theme="light"]) .navbar__btn--cta {
        background: var(--color-primary-400, #60a5fa);
        color: #1b1b1d !important;
      }
      body[data-theme="dark"]:not([data-nav-theme="light"]) .navbar__btn--cta:hover {
        background: var(--color-primary-300, #93c5fd);
      }

      body[data-theme="dark"]:not([data-nav-theme="light"]) .navbar__divider {
        background: #374151;
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
        body:not([data-nav-theme="light"]) .navbar__hamburger-line {
          background: #fff;
        }

        body:not([data-nav-theme="light"]) .navbar__mobile-menu {
          background: #1b1b1d;
          border-top-color: #374151;
        }

        body:not([data-nav-theme="light"]) .navbar__mobile-menu .navbar__link {
          border-bottom-color: #374151;
        }

        body:not([data-nav-theme="light"]) .navbar__mobile-menu .navbar__link:hover,
        body:not([data-nav-theme="light"]) .navbar__mobile-menu .navbar__link:active {
          background: rgba(255, 255, 255, 0.1);
        }

        body:not([data-nav-theme="light"]) .navbar__backdrop {
          background: rgba(0, 0, 0, 0.5);
        }
      }

      body[data-theme="dark"]:not([data-nav-theme="light"]) .navbar__hamburger-line {
        background: #fff;
      }

      body[data-theme="dark"]:not([data-nav-theme="light"]) .navbar__mobile-menu {
        background: #1b1b1d;
        border-top-color: #374151;
      }

      body[data-theme="dark"]:not([data-nav-theme="light"]) .navbar__mobile-menu .navbar__link {
        border-bottom-color: #374151;
      }

      body[data-theme="dark"]:not([data-nav-theme="light"]) .navbar__mobile-menu .navbar__link:hover,
      body[data-theme="dark"]:not([data-nav-theme="light"]) .navbar__mobile-menu .navbar__link:active {
        background: rgba(255, 255, 255, 0.1);
      }

      body[data-theme="dark"]:not([data-nav-theme="light"]) .navbar__backdrop {
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

    // Footer URLs - use relative on local, full AAO URLs on production
    const aboutUrl = isLocal ? '/about' : `${aaoBaseUrl}/about`;
    const membershipUrl = isLocal ? '/membership' : `${aaoBaseUrl}/membership`;
    const leadershipUrl = isLocal ? '/about#leadership' : `${aaoBaseUrl}/about#leadership`;
    const membersUrl = isLocal ? '/members' : `${aaoBaseUrl}/members`;
    const eventsUrl = isLocal ? '/events' : `${aaoBaseUrl}/events`;
    const committeesUrl = isLocal ? '/committees' : `${aaoBaseUrl}/committees`;
    const latestBaseUrl = isLocal ? '/latest' : `${aaoBaseUrl}/latest`;

    return `
      <footer class="aao-footer">
        <div class="aao-footer__inner">
          <div class="aao-footer__columns">
            <div class="aao-footer__column aao-footer__column--brand">
              <div class="aao-footer__brand-name">AgenticAdvertising.org</div>
              <p class="aao-footer__brand-mission">The trade association for agentic advertising. We develop open standards, certify practitioners, and bring together the companies building the future of AI-powered media.</p>
            </div>
            <div class="aao-footer__column">
              <div class="aao-footer__title">Organization</div>
              <ul class="aao-footer__list">
                <li><a href="${aboutUrl}">About</a></li>
                <li><a href="${membershipUrl}">Membership</a></li>
                <li><a href="${leadershipUrl}">Leadership</a></li>
                <li><a href="${membersUrl}">Members</a></li>
              </ul>
            </div>
            <div class="aao-footer__column">
              <div class="aao-footer__title">Resources</div>
              <ul class="aao-footer__list">
                <li><a href="/academy">Academy</a></li>
                <li><a href="/chat">Ask Addie</a></li>
                <li><a href="${docsUrl}">AdCP Docs</a></li>
                <li><a href="https://github.com/adcontextprotocol/adcp" target="_blank" rel="noopener noreferrer">GitHub</a></li>
              </ul>
            </div>
            <div class="aao-footer__column">
              <div class="aao-footer__title">Community</div>
              <ul class="aao-footer__list">
                <li><a href="${eventsUrl}">Events</a></li>
                <li><a href="${committeesUrl}">Committees</a></li>
                <li><a href="/stories">Perspectives</a></li>
                <li><a href="/stories">Announcements</a></li>
              </ul>
            </div>
          </div>
          <div class="aao-footer__bottom">
            <div class="aao-footer__legal">
              <a href="/api/agreement?type=privacy_policy">Privacy</a>
              <a href="/api/agreement?type=terms_of_service">Terms</a>
              <a href="/api/agreement?type=bylaws">Bylaws</a>
            </div>
            <div class="aao-footer__copyright">
              &copy; ${currentYear} Agentic Advertising Organization
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
        grid-template-columns: 2fr 1fr 1fr 1fr;
        gap: 2rem;
        margin-bottom: 2rem;
      }

      .aao-footer__column {
        min-width: 0;
      }

      .aao-footer__column--brand {
        padding-right: 2rem;
      }

      .aao-footer__brand-name {
        color: #fff;
        font-size: 1rem;
        font-weight: 700;
        margin-bottom: 0.75rem;
      }

      .aao-footer__brand-mission {
        font-size: 0.875rem;
        line-height: 1.6;
        color: #9ca3af;
        margin: 0;
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
        display: flex;
        justify-content: space-between;
        align-items: center;
      }

      .aao-footer__legal {
        display: flex;
        gap: 1.5rem;
      }

      .aao-footer__legal a {
        color: #6b7280;
        text-decoration: none;
        font-size: 0.75rem;
        transition: color 0.2s;
      }

      .aao-footer__legal a:hover {
        color: #9ca3af;
      }

      .aao-footer__copyright {
        font-size: 0.75rem;
        color: #6b7280;
      }

      @media (max-width: 768px) {
        .aao-footer__columns {
          grid-template-columns: 1fr 1fr;
          gap: 1.5rem;
        }

        .aao-footer__column--brand {
          grid-column: 1 / -1;
          padding-right: 0;
        }

        .aao-footer__bottom {
          flex-direction: column;
          gap: 0.75rem;
          text-align: center;
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

    // Notification bell
    const notifBell = document.getElementById('notifBell');
    const notifDropdown = document.getElementById('notifDropdown');
    const notifBadge = document.getElementById('notifBadge');
    const notifList = document.getElementById('notifList');

    if (notifBell && notifDropdown) {
      // Poll unread count
      async function updateNotifCount() {
        try {
          const res = await fetch('/api/notifications/count', { credentials: 'include' });
          if (!res.ok) return;
          const { count } = await res.json();
          if (count > 0) {
            notifBadge.textContent = count > 99 ? '99+' : String(count);
            notifBadge.style.display = 'flex';
          } else {
            notifBadge.style.display = 'none';
          }
        } catch {}
      }
      updateNotifCount();
      setInterval(updateNotifCount, 30000);

      function notifTimeAgo(dateStr) {
        const diff = Date.now() - new Date(dateStr).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return 'now';
        if (mins < 60) return mins + 'm';
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return hrs + 'h';
        const days = Math.floor(hrs / 24);
        return days + 'd';
      }

      notifBell.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (accountDropdown) accountDropdown.classList.remove('open');
        const wasOpen = notifDropdown.classList.contains('open');
        notifDropdown.classList.toggle('open');
        if (!wasOpen) {
          notifList.innerHTML = '<div class="navbar__notif-empty">Loading...</div>';
          try {
            const res = await fetch('/api/notifications?limit=10&unread_only=true', { credentials: 'include' });
            if (!res.ok) throw new Error();
            const data = await res.json();
            if (data.notifications.length === 0) {
              notifList.innerHTML = '<div class="navbar__notif-empty">No new notifications</div>';
              return;
            }
            function esc(str) {
              if (!str) return '';
              return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            }
            notifList.innerHTML = data.notifications.map(function(n) {
              const fi = (n.actor_first_name || '')[0] || '';
              const li = (n.actor_last_name || '')[0] || '';
              const initials = esc(fi + li) || '?';
              const avatar = n.actor_avatar_url
                ? '<img src="' + esc(n.actor_avatar_url) + '" alt="">'
                : initials;
              const tag = n.url ? 'a' : 'div';
              const href = n.url ? ' href="' + esc(n.url) + '"' : '';
              return '<' + tag + href + ' class="navbar__notif-item' + (n.is_read ? '' : ' unread') + '" data-id="' + esc(n.id) + '">'
                + '<div class="navbar__notif-item-avatar">' + avatar + '</div>'
                + '<div><div class="navbar__notif-item-text">' + esc(n.title) + '</div>'
                + '<div class="navbar__notif-item-time">' + notifTimeAgo(n.created_at) + '</div></div>'
                + '</' + tag + '>';
            }).join('');

            // Mark as read on click
            notifList.querySelectorAll('.navbar__notif-item[data-id]').forEach(function(el) {
              el.addEventListener('click', function() {
                fetch('/api/notifications/' + el.dataset.id + '/read', { method: 'POST', credentials: 'include' }).catch(function(){});
                el.classList.remove('unread');
                updateNotifCount();
              });
            });
          } catch {
            notifList.innerHTML = '<div class="navbar__notif-empty">Failed to load</div>';
          }
        }
      });

      notifDropdown.addEventListener('click', function(e) { e.stopPropagation(); });
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
      mobileMenu.querySelectorAll('.navbar__link').forEach(link => {
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
      if (notifDropdown) notifDropdown.classList.remove('open');
      if (mobileMenu && mobileMenu.classList.contains('open')) {
        toggleMobileMenu(false);
      }
    });

    // Close menu on escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (accountDropdown) accountDropdown.classList.remove('open');
        if (notifDropdown) notifDropdown.classList.remove('open');
        if (mobileMenu && mobileMenu.classList.contains('open')) {
          toggleMobileMenu(false);
        }
      }
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

    // Load avatar image asynchronously
    loadNavAvatar();

    // Founding member banner — adjust body padding and handle dismiss
    setupFoundingBanner();
  }

  function setupFoundingBanner() {
    const banner = document.getElementById('foundingBanner');
    if (!banner) return;

    // Check if previously dismissed
    if (localStorage.getItem('founding-banner-dismissed')) {
      banner.remove();
      return;
    }

    // Measure and set CSS variable for body padding offset
    function updateBannerHeight() {
      const h = banner.offsetHeight;
      document.documentElement.style.setProperty('--founding-banner-height', h + 'px');
      document.body.style.paddingTop = (60 + h) + 'px';
    }
    updateBannerHeight();
    window.addEventListener('resize', updateBannerHeight);

    // Dismiss
    const closeBtn = document.getElementById('foundingBannerClose');
    if (closeBtn) {
      closeBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        banner.classList.add('founding-banner--hidden');
        document.body.style.paddingTop = '60px';
        document.querySelector('.navbar').style.top = '0';
        document.documentElement.style.setProperty('--founding-banner-height', '0px');
        localStorage.setItem('founding-banner-dismissed', '1');
      });
    }
  }

  function loadNavAvatar() {
    var el = document.getElementById('accountAvatar');
    if (!el) return;

    // Try portrait first, fall back to community profile avatar
    fetch(apiBaseUrl + '/api/me/portrait', { credentials: 'include' })
      .then(function(res) { return res.ok ? res.json() : null; })
      .then(function(data) {
        if (data && data.portrait) {
          el.innerHTML = '<img src="' + escapeHtml(data.portrait.image_url) + '" alt="">';
          return;
        }
        // No portrait — try community profile avatar
        return fetch(apiBaseUrl + '/api/me/community/hub', { credentials: 'include' })
          .then(function(res) { return res.ok ? res.json() : null; })
          .then(function(hubData) {
            if (!hubData) return;
            var url = hubData.profile?.avatar_url;
            if (url) {
              el.innerHTML = '<img src="' + escapeHtml(url) + '" alt="">';
            }
          });
      })
      .catch(function() {});
  }

  // Run when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', insertNav);
  } else {
    insertNav();
  }
})();
