// Shared admin sidebar navigation component
// Include this in any admin page with: <script src="/admin-sidebar.js"></script>

(function() {
  'use strict';

  // Navigation configuration
  const NAV_CONFIG = {
    logo: 'Admin',
    sections: [
      {
        label: 'Overview',
        items: [
          { href: '/admin', label: 'Dashboard', icon: '📊' },
        ]
      },
      {
        label: 'Members',
        items: [
          { href: '/admin/prospects', label: 'Prospects', icon: '🎯' },
          { href: '/admin/members', label: 'Members', icon: '🏢' },
          { href: '/admin/users', label: 'Users', icon: '👤' },
        ]
      },
      {
        label: 'Community',
        items: [
          { href: '/admin/working-groups', label: 'Working Groups', icon: '🏛️' },
          { href: '/admin/perspectives', label: 'Perspectives', icon: '💡' },
        ]
      },
      {
        label: 'Billing',
        items: [
          { href: '/admin/products', label: 'Products', icon: '💳' },
          { href: '/admin/billing', label: 'Stripe Linking', icon: '🔗' },
        ]
      },
      {
        label: 'Engagement',
        items: [
          { href: '/admin/contacts', label: 'Contacts', icon: '👥' },
          { href: '/admin/insights', label: 'Member Insights', icon: '🧠' },
          { href: '/admin/insight-types', label: 'Insight Types', icon: '🏷️' },
          { href: '/admin/outreach', label: 'Outreach', icon: '📣' },
        ]
      },
      {
        label: 'System',
        items: [
          { href: '/admin/agreements', label: 'Agreements', icon: '📋' },
          { href: '/admin/email', label: 'Email', icon: '📧' },
          { href: '/admin/addie', label: 'Addie', icon: '🤖' },
          { href: '/admin/feeds', label: 'Industry Feeds', icon: '📰' },
          { href: '/admin/notification-channels', label: 'Alert Channels', icon: '📢' },
          { href: '/admin/api-keys', label: 'API Keys', icon: '🔑' },
          { href: '/admin/analytics', label: 'Analytics', icon: '📈' },
          { href: '/admin/audit', label: 'Audit Log', icon: '📜' },
        ]
      }
    ]
  };

  // Sidebar styles
  const SIDEBAR_STYLES = `
    .admin-layout {
      min-height: 100vh;
      padding-top: 60px; /* Space for top nav */
    }

    .admin-sidebar {
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

    .admin-sidebar-header {
      padding: 20px 24px;
      border-bottom: 1px solid var(--color-border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: linear-gradient(135deg, var(--color-brand) 0%, var(--color-primary-600) 100%);
    }

    .admin-sidebar-logo {
      font-size: 18px;
      font-weight: 600;
      color: white;
      text-decoration: none;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .admin-sidebar-logo img {
      width: 28px;
      height: 28px;
    }

    .admin-sidebar-nav {
      flex: 1;
      overflow-y: auto;
      padding: 16px 0;
    }

    .admin-nav-section {
      margin-bottom: 8px;
    }

    .admin-nav-section-label {
      padding: 8px 24px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--color-text-muted);
    }

    .admin-nav-item {
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

    .admin-nav-item:hover {
      background: var(--color-bg-subtle);
      color: var(--color-text-heading);
    }

    .admin-nav-item.active {
      background: var(--color-primary-50);
      color: var(--color-brand);
      border-left-color: var(--color-brand);
      font-weight: 500;
    }

    .admin-nav-icon {
      font-size: 16px;
      width: 20px;
      text-align: center;
    }

    .admin-sidebar-footer {
      padding: 16px 24px;
      border-top: 1px solid var(--color-border);
    }

    .admin-back-link {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--color-text-secondary);
      text-decoration: none;
      font-size: 13px;
      padding: 8px 0;
      transition: color 0.15s;
    }

    .admin-back-link:hover {
      color: var(--color-brand);
    }

    .admin-main {
      margin-left: 260px;
      min-height: calc(100vh - 60px); /* Full height minus top nav */
      background: var(--color-bg-page);
    }

    /* Container inside admin main should use full width since sidebar already constrains it */
    .admin-main .container {
      max-width: none;
      margin-left: 0;
      margin-right: 0;
    }

    /* Mobile sidebar toggle */
    .admin-sidebar-toggle {
      display: none;
      position: fixed;
      top: 76px;
      left: 16px;
      z-index: 101;
      background: var(--color-bg-card);
      border: 1px solid var(--color-border);
      border-radius: 8px;
      padding: 8px 12px;
      cursor: pointer;
      font-size: 20px;
    }

    .admin-sidebar-overlay {
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
      .admin-sidebar {
        transform: translateX(-100%);
      }

      .admin-sidebar.open {
        transform: translateX(0);
      }

      .admin-sidebar-toggle {
        display: block;
      }

      .admin-sidebar-overlay.show {
        display: block;
      }

      .admin-main {
        margin-left: 0;
      }
    }
  `;

  // Inject styles
  function injectStyles() {
    if (document.getElementById('admin-sidebar-styles')) return;

    const styleEl = document.createElement('style');
    styleEl.id = 'admin-sidebar-styles';
    styleEl.textContent = SIDEBAR_STYLES;
    document.head.appendChild(styleEl);
  }

  // Create sidebar HTML
  function createSidebarHTML() {
    const currentPath = window.location.pathname;

    const sectionsHTML = NAV_CONFIG.sections.map(section => {
      const itemsHTML = section.items.map(item => {
        const isActive = currentPath === item.href ||
                        (item.href !== '/admin' && currentPath.startsWith(item.href));
        const activeClass = isActive ? 'active' : '';
        return `
          <a href="${item.href}" class="admin-nav-item ${activeClass}">
            <span class="admin-nav-icon">${item.icon}</span>
            <span>${item.label}</span>
          </a>
        `;
      }).join('');

      return `
        <div class="admin-nav-section">
          <div class="admin-nav-section-label">${section.label}</div>
          ${itemsHTML}
        </div>
      `;
    }).join('');

    return `
      <button class="admin-sidebar-toggle" onclick="AdminSidebar.toggleSidebar()">☰</button>
      <div class="admin-sidebar-overlay" onclick="AdminSidebar.closeSidebar()"></div>
      <aside class="admin-sidebar" id="adminSidebar">
        <div class="admin-sidebar-header">
          <a href="/admin" class="admin-sidebar-logo">
            <img src="/AAo.svg" alt="AAO">
            <span>${NAV_CONFIG.logo}</span>
          </a>
        </div>
        <nav class="admin-sidebar-nav">
          ${sectionsHTML}
        </nav>
        <div class="admin-sidebar-footer">
          <a href="/dashboard" class="admin-back-link">
            ← Back to Dashboard
          </a>
        </div>
      </aside>
    `;
  }

  // Wrap content in main container
  function wrapContent() {
    // Find existing content wrapper or body content
    const existingMain = document.querySelector('.admin-main');
    if (existingMain) return; // Already wrapped

    // Get all body children except scripts, sidebar elements, nav, and footer/footer placeholder
    const bodyChildren = Array.from(document.body.children).filter(el =>
      el.tagName !== 'SCRIPT' &&
      !el.classList.contains('admin-sidebar') &&
      !el.classList.contains('admin-sidebar-toggle') &&
      !el.classList.contains('admin-sidebar-overlay') &&
      !el.classList.contains('aao-footer') &&
      el.id !== 'adcp-nav' &&
      el.id !== 'adcp-footer'
    );

    // Create main wrapper
    const mainWrapper = document.createElement('main');
    mainWrapper.className = 'admin-main';

    // Move children to wrapper
    bodyChildren.forEach(child => {
      mainWrapper.appendChild(child);
    });

    // Find footer placeholder or actual footer to insert before
    const footerPlaceholder = document.getElementById('adcp-footer');
    const actualFooter = document.querySelector('.aao-footer');
    const insertBeforeElement = footerPlaceholder || actualFooter;

    // Insert main wrapper before footer if it exists, otherwise append to body
    if (insertBeforeElement) {
      document.body.insertBefore(mainWrapper, insertBeforeElement);
    } else {
      document.body.appendChild(mainWrapper);
    }
  }

  // Initialize navigation
  function init() {
    injectStyles();

    // Remove old header nav if present
    const oldHeader = document.querySelector('.admin-header');
    if (oldHeader) {
      oldHeader.remove();
    }

    // Insert sidebar at start of body (after adcp-nav if present)
    const sidebarHTML = createSidebarHTML();
    const adcpNav = document.getElementById('adcp-nav');
    if (adcpNav) {
      adcpNav.insertAdjacentHTML('afterend', sidebarHTML);
    } else {
      document.body.insertAdjacentHTML('afterbegin', sidebarHTML);
    }

    // Add layout class to body
    document.body.classList.add('admin-layout');

    // Wrap existing content
    wrapContent();
  }

  // Toggle sidebar (mobile)
  function toggleSidebar() {
    const sidebar = document.getElementById('adminSidebar');
    const overlay = document.querySelector('.admin-sidebar-overlay');
    sidebar?.classList.toggle('open');
    overlay?.classList.toggle('show');
  }

  function closeSidebar() {
    const sidebar = document.getElementById('adminSidebar');
    const overlay = document.querySelector('.admin-sidebar-overlay');
    sidebar?.classList.remove('open');
    overlay?.classList.remove('show');
  }

  // Utility function to redirect to login with return_to parameter
  function redirectToLogin() {
    const returnUrl = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/auth/login?return_to=${returnUrl}`;
  }

  // Auto-initialize only on admin pages
  function shouldInitialize() {
    return window.location.pathname.startsWith('/admin');
  }

  if (shouldInitialize()) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  // Export API
  window.AdminSidebar = {
    config: NAV_CONFIG,
    init,
    toggleSidebar,
    closeSidebar,
    redirectToLogin
  };
})();
