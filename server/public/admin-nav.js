// Shared admin navigation component
// Include this in any admin page with: <script src="/admin-nav.js"></script>

(function() {
  'use strict';

  // Navigation configuration
  const NAV_CONFIG = {
    logo: 'AdCP Admin',
    links: [
      { href: '/admin/members', label: 'Members' },
      { href: '/admin/users', label: 'Users' },
      { href: '/admin/working-groups', label: 'Working Groups' },
      { href: '/admin/agreements', label: 'Agreements' },
      { href: '/admin/perspectives', label: 'Perspectives' },
      { href: '/admin/analytics', label: 'Analytics' },
      { href: '/admin/audit', label: 'Audit Log' }
    ],
    backLink: { href: '/dashboard', label: '← Back to Dashboard' }
  };

  // Shared header styles
  const HEADER_STYLES = `
    .admin-header {
      background-color: var(--color-brand, #667eea);
      color: white;
      padding: 20px 40px;
      box-shadow: var(--shadow-sm, 0 2px 4px rgba(0,0,0,0.1));
    }
    .admin-header-content {
      max-width: 1400px;
      margin: 0 auto;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .admin-header h1 {
      font-size: 28px;
      font-weight: 600;
      margin: 0;
    }
    .admin-header h1 a {
      color: white;
      text-decoration: none;
    }
    .admin-header h1 a:hover {
      opacity: 0.9;
    }
    .admin-header nav {
      display: flex;
      gap: 20px;
      align-items: center;
    }
    .admin-header nav a {
      color: white;
      text-decoration: none;
      padding: 8px 16px;
      border-radius: 6px;
      transition: background-color 0.2s;
      font-size: 15px;
    }
    .admin-header nav a:hover {
      background-color: rgba(255, 255, 255, 0.1);
    }
    .admin-header nav a.active {
      background-color: rgba(255, 255, 255, 0.2);
      font-weight: 600;
    }
  `;

  // Inject styles
  function injectStyles() {
    if (document.getElementById('admin-nav-styles')) return;

    const styleEl = document.createElement('style');
    styleEl.id = 'admin-nav-styles';
    styleEl.textContent = HEADER_STYLES;
    document.head.appendChild(styleEl);
  }

  // Create navigation HTML
  function createNavHTML() {
    const currentPath = window.location.pathname;

    const navLinks = NAV_CONFIG.links
      .map(link => {
        const isActive = currentPath === link.href ||
                        currentPath.startsWith(link.href + '/');
        const activeClass = isActive ? 'active' : '';
        return `<a href="${link.href}" class="${activeClass}">${link.label}</a>`;
      })
      .join('');

    return `
      <header class="admin-header">
        <div class="admin-header-content">
          <h1><a href="/admin">${NAV_CONFIG.logo}</a></h1>
          <nav>
            ${navLinks}
          </nav>
        </div>
      </header>
    `;
  }

  // Replace existing header or inject new one
  function injectNavigation() {
    // Find existing header element
    const existingHeader = document.querySelector('header, .header');

    const navHTML = createNavHTML();

    if (existingHeader) {
      // Replace existing header
      existingHeader.outerHTML = navHTML;
    } else {
      // Inject at start of body
      document.body.insertAdjacentHTML('afterbegin', navHTML);
    }
  }

  // Initialize when DOM is ready
  function init() {
    injectStyles();
    injectNavigation();
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

  // Utility function to redirect to login with return_to parameter
  function redirectToLogin() {
    const returnUrl = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/auth/login?return_to=${returnUrl}`;
  }

  // Export configuration and utilities
  window.AdminNav = {
    config: NAV_CONFIG,
    reinit: init,
    redirectToLogin: redirectToLogin
  };
})();
