// Shared dashboard navigation component with sidebar
// Include this in any dashboard page with: <script src="/dashboard-nav.js"></script>

(function() {
  'use strict';

  // Navigation configuration
  const NAV_CONFIG = {
    logo: 'Dashboard',
    sections: [
      {
        label: 'Overview',
        items: [
          { href: '/dashboard', label: 'Home', icon: '🏠' },
        ]
      },
      {
        label: 'Organization',
        items: [
          { href: '/member-profile', label: 'Member Profile', icon: '🏢' },
          { href: '/team', label: 'Team', icon: '👥' },
          { href: '/working-groups', label: 'Working Groups', icon: '🏛️' },
        ]
      },
      {
        label: 'Account',
        items: [
          { href: '/dashboard/billing', label: 'Billing', icon: '💳' },
          { href: '/dashboard/settings', label: 'Settings', icon: '⚙️' },
          { href: '/dashboard/emails', label: 'Email Preferences', icon: '📧' },
        ]
      }
    ],
    backLink: { href: 'https://agenticadvertising.org', label: '← Back to AAO' }
  };

  // Sidebar styles
  // Note: top nav is ~60px, so sidebar starts below it
  const SIDEBAR_STYLES = `
    .dashboard-layout {
      display: flex;
      min-height: 100vh;
      padding-top: 60px; /* Space for top nav */
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
      padding: 20px 24px;
      border-bottom: 1px solid var(--color-border);
      display: flex;
      align-items: center;
      justify-content: space-between;
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
      flex: 1;
      margin-left: 260px;
      min-height: 100vh;
      background: var(--color-bg-page);
    }

    /* Mobile sidebar toggle */
    .dashboard-sidebar-toggle {
      display: none;
      position: fixed;
      top: 16px;
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

  // Inject styles
  function injectStyles() {
    if (document.getElementById('dashboard-nav-styles')) return;

    const styleEl = document.createElement('style');
    styleEl.id = 'dashboard-nav-styles';
    styleEl.textContent = SIDEBAR_STYLES;
    document.head.appendChild(styleEl);
  }

  // Create sidebar HTML
  function createSidebarHTML(options = {}) {
    const currentPath = window.location.pathname;
    const { showAdmin = false, showOrgSwitcher = false, currentOrgName = 'Select Organization' } = options;

    const sectionsHTML = NAV_CONFIG.sections.map(section => {
      const itemsHTML = section.items.map(item => {
        const isActive = currentPath === item.href ||
                        (item.href !== '/dashboard' && currentPath.startsWith(item.href));
        const activeClass = isActive ? 'active' : '';
        return `
          <a href="${item.href}" class="dashboard-nav-item ${activeClass}">
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

    const orgSwitcherHTML = showOrgSwitcher ? `
      <div class="dashboard-org-switcher">
        <button class="dashboard-org-btn" onclick="DashboardNav.toggleOrgDropdown()">
          <span class="dashboard-org-name" id="dashboardOrgName">${currentOrgName}</span>
          <span>▼</span>
        </button>
        <div class="dashboard-org-dropdown" id="dashboardOrgDropdown"></div>
      </div>
    ` : '';

    const adminLinkHTML = showAdmin ? `
      <a href="/admin" class="dashboard-admin-link">
        <span>🔒</span> Admin Panel
      </a>
    ` : '';

    return `
      <button class="dashboard-sidebar-toggle" onclick="DashboardNav.toggleSidebar()">☰</button>
      <div class="dashboard-sidebar-overlay" onclick="DashboardNav.closeSidebar()"></div>
      <aside class="dashboard-sidebar" id="dashboardSidebar">
        <div class="dashboard-sidebar-header">
          <a href="/dashboard" class="dashboard-sidebar-logo">
            <img src="/AAo.svg" alt="AAO">
            <span>${NAV_CONFIG.logo}</span>
          </a>
        </div>
        ${orgSwitcherHTML}
        <nav class="dashboard-sidebar-nav">
          ${sectionsHTML}
        </nav>
        ${adminLinkHTML ? `<div class="dashboard-sidebar-footer">${adminLinkHTML}</div>` : ''}
      </aside>
    `;
  }

  // Wrap content in main container
  function wrapContent() {
    // Find existing content wrapper or body content
    const existingMain = document.querySelector('.dashboard-main');
    if (existingMain) return; // Already wrapped

    // Get all body children except scripts and the sidebar
    const bodyChildren = Array.from(document.body.children).filter(el =>
      el.tagName !== 'SCRIPT' &&
      !el.classList.contains('dashboard-sidebar') &&
      !el.classList.contains('dashboard-sidebar-toggle') &&
      !el.classList.contains('dashboard-sidebar-overlay')
    );

    // Create main wrapper
    const mainWrapper = document.createElement('main');
    mainWrapper.className = 'dashboard-main';

    // Move children to wrapper
    bodyChildren.forEach(child => {
      mainWrapper.appendChild(child);
    });

    // Add wrapper to body
    document.body.appendChild(mainWrapper);
  }

  // Initialize navigation
  function init(options = {}) {
    injectStyles();

    // Insert sidebar at start of body
    const sidebarHTML = createSidebarHTML(options);
    document.body.insertAdjacentHTML('afterbegin', sidebarHTML);

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
    const el = document.getElementById('dashboardOrgName');
    if (el) el.textContent = name;
  }

  function setOrgOptions(orgs, selectedId, onSelect) {
    const dropdown = document.getElementById('dashboardOrgDropdown');
    if (!dropdown) return;

    dropdown.innerHTML = orgs.map(org => `
      <button class="dashboard-org-option ${org.id === selectedId ? 'selected' : ''}"
              onclick="DashboardNav.selectOrg('${org.id}')">
        ${org.name}
      </button>
    `).join('');

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

  // Export API
  window.DashboardNav = {
    config: NAV_CONFIG,
    init,
    toggleSidebar,
    closeSidebar,
    toggleOrgDropdown,
    closeOrgDropdown,
    setOrgName,
    setOrgOptions,
    selectOrg,
    showAdminLink
  };
})();
