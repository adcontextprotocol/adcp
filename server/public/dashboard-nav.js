// Shared dashboard navigation component with sidebar
// Include this in any dashboard page with: <script src="/dashboard-nav.js"></script>

(function() {
  'use strict';

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Check if legacy org needs profile info - runs on all dashboard pages
  // If profile info is missing, redirect to main dashboard which shows the modal
  async function checkProfileInfoRequired() {
    // Skip if already on main dashboard (it handles its own modal)
    const currentPath = window.location.pathname;
    if (currentPath === '/dashboard' || currentPath === '/dashboard/' || currentPath.startsWith('/dashboard/organization')) return;

    // Skip if we already checked this session
    if (sessionStorage.getItem('profileInfoChecked')) return;

    try {
      // Get current user and org
      const meResponse = await fetch('/api/me', { credentials: 'include' });
      if (!meResponse.ok) return; // Not logged in or error - let page handle it

      const meData = await meResponse.json();
      const orgs = meData.organizations || [];
      if (orgs.length === 0) return; // No orgs - let page handle redirect to onboarding

      const resolved = resolveOrg(orgs);
      if (!resolved.org) return; // No org selected yet, let the page handle it
      const selectedOrg = resolved.org;

      // Fetch billing info for this org
      const billingResponse = await fetch(`/api/organizations/${selectedOrg.id}/billing`, { credentials: 'include' });
      if (!billingResponse.ok) return; // Error - let page handle it

      const billingData = await billingResponse.json();

      // Check if org needs profile info (non-personal, no subscription, missing company_type or revenue_tier)
      const isPersonal = billingData.is_personal;
      const hasSubscription = billingData.subscription?.status === 'active';
      const hasProfileInfo = billingData.company_type && billingData.revenue_tier;

      if (!isPersonal && !hasSubscription && !hasProfileInfo) {
        // Redirect to main dashboard which will show the profile modal
        window.location.href = '/dashboard?org=' + selectedOrg.id;
        return;
      }

      // Mark as checked for this session
      sessionStorage.setItem('profileInfoChecked', 'true');
    } catch (error) {
      console.error('Error checking profile info:', error);
      // Don't block on errors - let the page load
    }
  }

  // Run check immediately (before page fully loads)
  checkProfileInfoRequired();

  // Navigation configuration
  // When on dashboard page, use anchor links; otherwise use full page links
  const isDashboardPage = window.location.pathname === '/dashboard' || window.location.pathname === '/dashboard/';

  const NAV_CONFIG = {
    logo: 'Dashboard',
    sections: [
      {
        label: 'Organization',
        items: [
          { href: '/dashboard/organization', label: 'Journey & overview', icon: '📊' },
        ]
      },
      {
        label: 'Account',
        items: [
          { href: isDashboardPage ? '#profile' : '/dashboard#profile', label: 'Profile', icon: '🏢', anchor: 'profile' },
          { href: isDashboardPage ? '#team' : '/dashboard#team', label: 'Team', icon: '👥', anchor: 'team' },
          { href: isDashboardPage ? '#membership' : '/dashboard#membership', label: 'Membership', icon: '⭐', anchor: 'membership' },
          { href: '/dashboard/settings', label: 'Settings', icon: '⚙️' },
          { href: '/dashboard/emails', label: 'Email preferences', icon: '📧' },
          { href: '/dashboard/api-keys', label: 'API keys', icon: '🔑' },
        ]
      }
    ],
    backLink: { href: 'https://agenticadvertising.org', label: '← Back to AAO' }
  };

  // Sidebar styles
  // Note: top nav is ~60px, so sidebar starts below it
  const SIDEBAR_STYLES = `
    .dashboard-layout {
      min-height: 100vh;
      padding-top: 60px; /* Space for top nav */
      display: flex;
      flex-direction: column;
    }

    .dashboard-sidebar {
      width: 260px;
      background: var(--color-bg-card);
      border-right: 1px solid var(--color-border);
      display: flex;
      flex-direction: column;
      position: fixed;
      top: 60px; /* Below top nav */
      left: 0;
      bottom: 0;
      z-index: 100;
      transition: transform 0.3s ease;
    }

    .dashboard-sidebar-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--color-border);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .dashboard-sidebar-org {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .dashboard-sidebar-org-name {
      font-size: 16px;
      font-weight: 600;
      color: var(--color-text-heading);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 200px;
    }

    .dashboard-sidebar-badges {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    .dashboard-sidebar-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 500;
    }

    .dashboard-sidebar-badge--team {
      background: var(--color-info-100);
      color: var(--color-info-700);
    }

    .dashboard-sidebar-badge--personal {
      background: var(--color-gray-100);
      color: var(--color-text-secondary);
    }

    .dashboard-sidebar-badge--subscribed {
      background: var(--color-success-100);
      color: var(--color-success-700);
    }

    .dashboard-sidebar-logo {
      font-size: 18px;
      font-weight: 600;
      color: var(--color-text-heading);
      text-decoration: none;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .dashboard-sidebar-logo img {
      width: 28px;
      height: 28px;
    }

    .dashboard-sidebar-nav {
      flex: 1;
      overflow-y: auto;
      padding: 16px 0;
    }

    .dashboard-nav-section {
      margin-bottom: 8px;
    }

    .dashboard-nav-section-label {
      padding: 8px 24px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--color-text-muted);
    }

    .dashboard-nav-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 24px;
      color: var(--color-text-secondary);
      text-decoration: none;
      font-size: 14px;
      transition: all 0.15s ease;
      border-left: 3px solid transparent;
    }

    .dashboard-nav-item:hover {
      background: var(--color-bg-subtle);
      color: var(--color-text-heading);
    }

    .dashboard-nav-item.active {
      background: var(--color-primary-50);
      color: var(--color-brand);
      border-left-color: var(--color-brand);
      font-weight: 500;
    }

    .dashboard-nav-icon {
      font-size: 16px;
      width: 20px;
      text-align: center;
    }

    .dashboard-sidebar-footer {
      padding: 16px 24px;
      border-top: 1px solid var(--color-border);
    }

    .dashboard-back-link {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--color-text-secondary);
      text-decoration: none;
      font-size: 13px;
      padding: 8px 0;
      transition: color 0.15s;
    }

    .dashboard-back-link:hover {
      color: var(--color-brand);
    }

    .dashboard-main {
      margin-left: 260px;
      flex: 1;
      background: var(--color-bg-page);
      width: calc(100% - 260px);
    }

    /* Container inside dashboard main should use full width since sidebar already constrains it */
    .dashboard-main .container {
      max-width: none;
      width: 100%;
      margin: 0;
      padding: 24px 32px;
      box-sizing: border-box;
    }

    /* Mobile sidebar toggle */
    .dashboard-sidebar-toggle {
      display: none;
      position: fixed;
      top: 76px; /* Below top nav */
      left: 16px;
      z-index: 101;
      background: var(--color-bg-card);
      border: 1px solid var(--color-border);
      border-radius: 8px;
      padding: 8px 12px;
      cursor: pointer;
      font-size: 20px;
    }

    .dashboard-sidebar-overlay {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 99;
    }

    /* Mobile responsive */
    @media (max-width: 768px) {
      .dashboard-sidebar {
        transform: translateX(-100%);
      }

      .dashboard-sidebar.open {
        transform: translateX(0);
      }

      .dashboard-sidebar-toggle {
        display: block;
      }

      .dashboard-sidebar-overlay.show {
        display: block;
      }

      .dashboard-main {
        margin-left: 0;
        width: 100%;
      }
    }

    /* Org switcher in sidebar */
    .dashboard-org-switcher {
      padding: 12px 24px;
      border-bottom: 1px solid var(--color-border);
    }

    .dashboard-org-btn {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      background: var(--color-bg-subtle);
      border: 1px solid var(--color-border);
      border-radius: 8px;
      cursor: pointer;
      font-size: 13px;
      color: var(--color-text-heading);
      transition: all 0.15s;
    }

    .dashboard-org-btn:hover {
      border-color: var(--color-brand);
    }

    .dashboard-org-name {
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 160px;
    }

    .dashboard-org-dropdown {
      display: none;
      position: absolute;
      left: 24px;
      right: 24px;
      background: var(--color-bg-card);
      border: 1px solid var(--color-border);
      border-radius: 8px;
      box-shadow: var(--shadow-lg);
      z-index: 200;
      max-height: 300px;
      overflow-y: auto;
      margin-top: 4px;
    }

    .dashboard-org-dropdown.show {
      display: block;
    }

    .dashboard-org-option {
      display: block;
      width: 100%;
      padding: 10px 12px;
      text-align: left;
      background: none;
      border: none;
      cursor: pointer;
      font-size: 13px;
      color: var(--color-text-secondary);
      transition: background 0.15s;
    }

    .dashboard-org-option:hover {
      background: var(--color-bg-subtle);
    }

    .dashboard-org-option.selected {
      background: var(--color-primary-50);
      color: var(--color-brand);
      font-weight: 500;
    }

    /* Admin link in sidebar */
    .dashboard-admin-link {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: var(--color-brand);
      color: white;
      text-decoration: none;
      font-size: 12px;
      font-weight: 500;
      border-radius: 6px;
      margin-top: 12px;
      transition: opacity 0.15s;
    }

    .dashboard-admin-link:hover {
      opacity: 0.9;
    }
  `;

  // Org picker styles (for inline picker shown to multi-org users)
  const ORG_PICKER_STYLES = `
    .org-picker {
      max-width: 480px;
      margin: 60px auto;
      text-align: center;
    }

    .org-picker h2 {
      color: var(--color-text-heading);
      margin: 0 0 8px 0;
      font-size: 22px;
    }

    .org-picker p {
      color: var(--color-text-secondary);
      margin: 0 0 24px 0;
      font-size: 14px;
    }

    .org-picker-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      text-align: left;
    }

    .org-picker-option {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 16px;
      background: var(--color-bg-card);
      border: 1px solid var(--color-border);
      border-radius: 8px;
      cursor: pointer;
      width: 100%;
      font-size: 14px;
      font-weight: 500;
      color: var(--color-text-heading);
      transition: all 0.15s;
    }

    .org-picker-option:hover {
      border-color: var(--color-brand);
      background: var(--color-primary-50);
    }

    .org-picker-icon {
      font-size: 20px;
    }
  `;

  // Resolve which org to use for multi-org users.
  // Returns { org, needsSelection }. If needsSelection is true,
  // the caller should show the org picker instead of loading page content.
  function resolveOrg(organizations) {
    if (!organizations || organizations.length === 0) {
      return { org: null, needsSelection: false };
    }

    if (organizations.length === 1) {
      return { org: organizations[0], needsSelection: false };
    }

    const urlParams = new URLSearchParams(window.location.search);
    const urlOrgId = urlParams.get('org');
    if (urlOrgId) {
      const org = organizations.find(o => o.id === urlOrgId);
      if (org) return { org, needsSelection: false };
    }

    const storedId = localStorage.getItem('selectedOrgId');
    if (storedId) {
      const org = organizations.find(o => o.id === storedId);
      if (org) return { org, needsSelection: false };
    }

    return { org: null, needsSelection: true };
  }

  // Render an inline org picker into the given container element.
  // Used when a multi-org user has no explicit org selection.
  function renderOrgPicker(organizations, containerEl) {
    containerEl.innerHTML = `
      <div class="org-picker">
        <h2>Select an organization</h2>
        <p>You belong to multiple organizations. Choose which one to manage.</p>
        <div class="org-picker-list">
          ${organizations.map(org => `
            <button type="button" class="org-picker-option" data-org-id="${escapeHtml(org.id)}">
              <span class="org-picker-icon">🏢</span>
              <span>${escapeHtml(org.name)}</span>
            </button>
          `).join('')}
        </div>
      </div>
    `;

    containerEl.querySelectorAll('.org-picker-option').forEach(btn => {
      btn.addEventListener('click', () => {
        const orgId = btn.dataset.orgId;
        localStorage.setItem('selectedOrgId', orgId);
        const url = new URL(window.location);
        url.searchParams.set('org', orgId);
        window.location.href = url.toString();
      });
    });
  }

  // Inject styles
  function injectStyles() {
    if (document.getElementById('dashboard-nav-styles')) return;

    const styleEl = document.createElement('style');
    styleEl.id = 'dashboard-nav-styles';
    styleEl.textContent = SIDEBAR_STYLES + ORG_PICKER_STYLES;
    document.head.appendChild(styleEl);
  }

  // Create sidebar HTML
  function createSidebarHTML(options = {}) {
    const currentPath = window.location.pathname;
    const appConfig = window.__APP_CONFIG__;
    const {
      showAdmin = false,
      showManage = !!(appConfig?.user?.isManage || appConfig?.user?.isAdmin),
      showOrgSwitcher = false,
      currentOrgName = 'Organization',
      isPersonal = false,
      isSubscribed = false,
      orgId = null
    } = options;

    const currentHash = window.location.hash;

    const sectionsHTML = NAV_CONFIG.sections.map(section => {
      const itemsHTML = section.items.map(item => {
        // Hide Team nav item for personal workspaces (no team features allowed)
        if (item.anchor === 'team' && isPersonal) {
          return '';
        }

        // For anchor links on dashboard, check hash; for page links, check path
        let isActive = false;
        if (item.anchor && isDashboardPage) {
          // On dashboard with anchor links - check if hash matches or default to profile
          isActive = currentHash === `#${item.anchor}` ||
                    (item.anchor === 'profile' && (!currentHash || currentHash === ''));
        } else if (!item.anchor) {
          // Regular page links
          isActive = currentPath === item.href ||
                    (item.href !== '/dashboard' && currentPath.startsWith(item.href));
        }
        const activeClass = isActive ? 'active' : '';
        const hiddenStyle = item.hidden ? ' style="display: none;"' : '';
        const idAttr = item.id ? ` id="${item.id}"` : '';

        // Build href with org param for cross-page links
        let href = item.href;
        if (orgId) {
          if (item.anchor && !isDashboardPage) {
            // e.g., /dashboard#profile -> /dashboard?org=xyz#profile
            href = `/dashboard?org=${orgId}#${item.anchor}`;
          } else if (!item.anchor) {
            // e.g., /dashboard/settings -> /dashboard/settings?org=xyz
            href = `${item.href}?org=${orgId}`;
          }
        }

        return `
          <a href="${href}" class="dashboard-nav-item ${activeClass}"${idAttr} ${item.anchor ? `data-anchor="${item.anchor}"` : ''}${hiddenStyle}>
            <span class="dashboard-nav-icon">${item.icon}</span>
            <span>${item.label}</span>
          </a>
        `;
      }).join('');

      return `
        <div class="dashboard-nav-section">
          <div class="dashboard-nav-section-label">${section.label}</div>
          ${itemsHTML}
        </div>
      `;
    }).join('');

    // Org switcher for users with multiple orgs
    const orgSwitcherHTML = showOrgSwitcher ? `
      <div class="dashboard-org-switcher">
        <button class="dashboard-org-btn" onclick="DashboardNav.toggleOrgDropdown()">
          <span class="dashboard-org-name" id="dashboardOrgName">${escapeHtml(currentOrgName)}</span>
          <span>▼</span>
        </button>
        <div class="dashboard-org-dropdown" id="dashboardOrgDropdown"></div>
      </div>
    ` : '';

    const manageLinkHTML = (showManage || showAdmin) ? `
      <a href="/manage" class="dashboard-admin-link">
        <span>⚡</span> Manage AAO
      </a>
    ` : '';

    const adminLinkHTML = showAdmin ? `
      <a href="/admin" class="dashboard-admin-link">
        <span>🔒</span> Admin panel
      </a>
    ` : '';

    // Build badges - only show Member badge for subscribers
    const subscribedBadge = isSubscribed
      ? '<span class="dashboard-sidebar-badge dashboard-sidebar-badge--subscribed">Member</span>'
      : '';

    return `
      <button class="dashboard-sidebar-toggle" onclick="DashboardNav.toggleSidebar()">☰</button>
      <div class="dashboard-sidebar-overlay" onclick="DashboardNav.closeSidebar()"></div>
      <aside class="dashboard-sidebar" id="dashboardSidebar">
        <div class="dashboard-sidebar-header">
          <div class="dashboard-sidebar-org">
            <span class="dashboard-sidebar-org-name" id="sidebarOrgName">${escapeHtml(currentOrgName)}</span>
          </div>
          <div class="dashboard-sidebar-badges" id="sidebarOrgBadges">
            ${subscribedBadge}
          </div>
        </div>
        ${orgSwitcherHTML}
        <nav class="dashboard-sidebar-nav">
          ${sectionsHTML}
        </nav>
        ${(manageLinkHTML || adminLinkHTML) ? `<div class="dashboard-sidebar-footer">${manageLinkHTML}${adminLinkHTML}</div>` : ''}
      </aside>
    `;
  }

  // Wrap content in main container
  function wrapContent() {
    // Find existing content wrapper or body content
    const existingMain = document.querySelector('.dashboard-main');
    if (existingMain) return; // Already wrapped

    // Get all body children except scripts, sidebar elements, nav, and footer
    const bodyChildren = Array.from(document.body.children).filter(el =>
      el.tagName !== 'SCRIPT' &&
      !el.classList.contains('dashboard-sidebar') &&
      !el.classList.contains('dashboard-sidebar-toggle') &&
      !el.classList.contains('dashboard-sidebar-overlay') &&
      !el.classList.contains('aao-footer') &&
      el.id !== 'adcp-nav'
    );

    // Create main wrapper
    const mainWrapper = document.createElement('main');
    mainWrapper.className = 'dashboard-main';

    // Move children to wrapper (except footer which stays at body level)
    bodyChildren.forEach(child => {
      mainWrapper.appendChild(child);
    });

    // Insert main wrapper before footer if footer exists, otherwise append to body
    const footer = document.querySelector('.aao-footer');
    if (footer) {
      document.body.insertBefore(mainWrapper, footer);
    } else {
      document.body.appendChild(mainWrapper);
    }
  }

  // Initialize navigation
  function init(options = {}) {
    injectStyles();

    // Insert sidebar after adcp-nav if present, otherwise at start of body
    const sidebarHTML = createSidebarHTML(options);
    const adcpNav = document.getElementById('adcp-nav');
    if (adcpNav) {
      adcpNav.insertAdjacentHTML('afterend', sidebarHTML);
    } else {
      document.body.insertAdjacentHTML('afterbegin', sidebarHTML);
    }

    // Add layout class to body
    document.body.classList.add('dashboard-layout');

    // Wrap existing content
    wrapContent();
  }

  // Toggle sidebar (mobile)
  function toggleSidebar() {
    const sidebar = document.getElementById('dashboardSidebar');
    const overlay = document.querySelector('.dashboard-sidebar-overlay');
    sidebar?.classList.toggle('open');
    overlay?.classList.toggle('show');
  }

  function closeSidebar() {
    const sidebar = document.getElementById('dashboardSidebar');
    const overlay = document.querySelector('.dashboard-sidebar-overlay');
    sidebar?.classList.remove('open');
    overlay?.classList.remove('show');
  }

  // Org dropdown functions
  function toggleOrgDropdown() {
    const dropdown = document.getElementById('dashboardOrgDropdown');
    dropdown?.classList.toggle('show');
  }

  function closeOrgDropdown() {
    const dropdown = document.getElementById('dashboardOrgDropdown');
    dropdown?.classList.remove('show');
  }

  function setOrgName(name) {
    // Update org switcher dropdown button
    const dropdownEl = document.getElementById('dashboardOrgName');
    if (dropdownEl) dropdownEl.textContent = name;

    // Update sidebar header org name
    const sidebarEl = document.getElementById('sidebarOrgName');
    if (sidebarEl) sidebarEl.textContent = name;
  }

  // Update sidebar badges based on org status
  function setOrgStatus(options = {}) {
    const { isPersonal = false, isSubscribed = false } = options;
    const badgesEl = document.getElementById('sidebarOrgBadges');
    if (!badgesEl) return;

    // Only show Member badge for subscribers
    const subscribedBadge = isSubscribed
      ? '<span class="dashboard-sidebar-badge dashboard-sidebar-badge--subscribed">Member</span>'
      : '';

    badgesEl.innerHTML = subscribedBadge;
  }

  function setOrgOptions(orgs, selectedId, onSelect) {
    const dropdown = document.getElementById('dashboardOrgDropdown');
    if (!dropdown) return;

    dropdown.innerHTML = orgs.map(org => `
      <button class="dashboard-org-option ${org.id === selectedId ? 'selected' : ''}"
              data-org-id="${escapeHtml(org.id)}">
        ${escapeHtml(org.name)}
      </button>
    `).join('');

    dropdown.querySelectorAll('.dashboard-org-option').forEach(btn => {
      btn.addEventListener('click', () => {
        DashboardNav.selectOrg(btn.dataset.orgId);
      });
    });

    // Store callback
    window._dashboardOrgSelectCallback = onSelect;
  }

  function selectOrg(orgId) {
    closeOrgDropdown();
    if (window._dashboardOrgSelectCallback) {
      window._dashboardOrgSelectCallback(orgId);
    }
  }

  // Show/hide admin link
  function showAdminLink(show) {
    const footer = document.querySelector('.dashboard-sidebar-footer');
    const existingLink = footer?.querySelector('.dashboard-admin-link');

    if (show && !existingLink && footer) {
      footer.insertAdjacentHTML('beforeend', `
        <a href="/admin" class="dashboard-admin-link">
          <span>🔒</span> Admin Panel
        </a>
      `);
    } else if (!show && existingLink) {
      existingLink.remove();
    }
  }

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.dashboard-org-switcher')) {
      closeOrgDropdown();
    }
  });

  // Update active nav item when hash changes (for anchor-based navigation)
  function updateActiveNavItem() {
    if (!isDashboardPage) return;

    const currentHash = window.location.hash;
    const navItems = document.querySelectorAll('.dashboard-nav-item[data-anchor]');

    navItems.forEach(item => {
      const anchor = item.getAttribute('data-anchor');
      const isActive = currentHash === `#${anchor}` ||
                      (anchor === 'profile' && (!currentHash || currentHash === ''));
      item.classList.toggle('active', isActive);
    });
  }

  // Listen for hash changes
  window.addEventListener('hashchange', updateActiveNavItem);

  // Also handle smooth scrolling and intersection observer for scroll-based updates
  if (isDashboardPage) {
    // Set up intersection observer for sections to update nav on scroll
    document.addEventListener('DOMContentLoaded', () => {
      const sections = document.querySelectorAll('.dashboard-section[id]');
      if (sections.length === 0) return;

      const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting && entry.intersectionRatio > 0.3) {
            const sectionId = entry.target.id;
            // Update hash without triggering scroll
            if (window.location.hash !== `#${sectionId}`) {
              history.replaceState(null, '', `#${sectionId}`);
              updateActiveNavItem();
            }
          }
        });
      }, {
        rootMargin: '-100px 0px -60% 0px',
        threshold: [0.3]
      });

      sections.forEach(section => observer.observe(section));
    });
  }

  // Show/hide leadership nav item based on whether user leads any committees
  function showLeadershipNav(show) {
    const leadershipNavItem = document.getElementById('leadershipNavItem');
    if (leadershipNavItem) {
      leadershipNavItem.style.display = show ? 'flex' : 'none';
    }
  }

  // Export API
  window.DashboardNav = {
    config: NAV_CONFIG,
    init,
    toggleSidebar,
    closeSidebar,
    toggleOrgDropdown,
    closeOrgDropdown,
    setOrgName,
    setOrgStatus,
    setOrgOptions,
    selectOrg,
    showAdminLink,
    showLeadershipNav,
    resolveOrg,
    renderOrgPicker
  };
})();
