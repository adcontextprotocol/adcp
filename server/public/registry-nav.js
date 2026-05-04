/**
 * Registry sub-navigation
 * Include after nav.js on any registry page:
 *   <script src="/registry-nav.js"></script>
 *
 * Renders a sticky sub-nav below the main nav with links to
 * registry sub-pages. Highlights the current page based on ?tab= parameter.
 */
(function () {
  'use strict';

  var path = window.location.pathname;
  var params = new URLSearchParams(window.location.search);
  var tab = params.get('tab');

  var links = [
    { href: '/registry?tab=agents', tab: 'agents', label: 'Agents' },
    { href: '/registry?tab=brands', tab: 'brands', label: 'Brands' },
    { href: '/registry?tab=properties', tab: 'properties', label: 'Properties' },
    { href: '/registry?tab=policies', tab: 'policies', label: 'Policies' },
    { href: '/registry?tab=members', tab: 'members', label: 'Members' },
    { href: '/registry/tools', tab: 'tools', label: 'Tools' },
  ];

  function isActive(link) {
    // Tools page has its own path
    if (link.tab === 'tools') {
      return path === '/registry/tools' || path === '/registry/tools/' || path === '/brand/builder' || path === '/adagents/builder';
    }
    // On /registry, match by tab param (default to agents)
    if (path === '/registry' || path === '/registry/') {
      var activeTab = tab || 'agents';
      return link.tab === activeTab;
    }
    // Detail pages under /brand/view highlight brands tab
    if (link.tab === 'brands' && path.startsWith('/brand/view')) return true;
    // Detail pages under /property/view or /publisher highlight properties tab
    if (link.tab === 'properties' && (path.startsWith('/property/view') || path.startsWith('/publisher/'))) return true;
    // /policies standalone page
    if (link.tab === 'policies' && path === '/policies') return true;
    // /members standalone page
    if (link.tab === 'members' && (path === '/members' || path.startsWith('/members/'))) return true;
    return false;
  }

  var html = '<nav class="sub-nav"><div class="sub-nav-inner" style="max-width:var(--container-xl)"><div class="sub-nav-links">';
  for (var i = 0; i < links.length; i++) {
    var l = links[i];
    html += '<a href="' + l.href + '"' + (isActive(l) ? ' class="active"' : '') + '>' + l.label + '</a>';
  }
  html += '</div></div></nav>';

  function insert() {
    var navbar = document.querySelector('.navbar');
    if (navbar) {
      navbar.insertAdjacentHTML('afterend', html);
    } else {
      // Fallback: insert after nav placeholder
      var placeholder = document.getElementById('adcp-nav');
      if (placeholder) {
        placeholder.insertAdjacentHTML('afterend', html);
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', insert);
  } else {
    // nav.js may not have run yet; defer to next tick
    setTimeout(insert, 0);
  }
})();
