// Automatically attach the CSRF token header to state-changing fetch requests.
// Reads the csrf-token cookie and sends it as X-CSRF-Token on POST/PUT/DELETE/PATCH.
(function () {
  'use strict';

  function getCsrfToken() {
    var match = document.cookie.match('(?:^|; )csrf-token=([^;]*)');
    return match ? match[1] : '';
  }

  var originalFetch = window.fetch;
  window.fetch = function (input, init) {
    init = init || {};
    var method = (init.method || 'GET').toUpperCase();

    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      var headers = new Headers(init.headers || {});
      if (!headers.has('X-CSRF-Token')) {
        headers.set('X-CSRF-Token', getCsrfToken());
      }
      init.headers = headers;
    }

    return originalFetch.call(this, input, init);
  };
})();
