/**
 * Registry sub-navigation
 * Include after nav.js on any registry page:
 *   <script src="/registry-nav.js"></script>
 *
 * Renders a sticky sub-nav below the main nav with links to
 * registry sub-pages. Highlights the current page.
 */
(function () {
  'use strict';

  var path = window.location.pathname;

  var links = [
    { href: '/registry', label: 'Overview' },
    { href: '/agents', label: 'Agents' },
    { href: '/brands', label: 'Brands' },
    { href: '/publishers', label: 'Properties' },
    { href: '/members', label: 'Members' },
    { href: '/registry/tools', label: 'Tools' },
  ];

  function isActive(href) {
    if (href === '/registry') return path === '/registry' || path === '/registry/';
    if (href === '/registry/tools') return path === '/registry/tools' || path === '/registry/tools/' || path === '/brand/builder' || path === '/adagents/builder';
    if (href === '/brands') return path === '/brands' || path.startsWith('/brand/view');
    if (href === '/publishers') return path === '/publishers' || path.startsWith('/property/view');
    return path === href || path.startsWith(href + '/');
  }

  var html = '<nav class="sub-nav"><div class="sub-nav-inner" style="max-width:var(--container-xl)"><div class="sub-nav-links">';
  for (var i = 0; i < links.length; i++) {
    var l = links[i];
    html += '<a href="' + l.href + '"' + (isActive(l.href) ? ' class="active"' : '') + '>' + l.label + '</a>';
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
