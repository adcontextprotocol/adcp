// Automatically attach the CSRF token header to state-changing fetch requests.
// Reads the csrf-token cookie and sends it as X-CSRF-Token on POST/PUT/DELETE/PATCH.
// If the server responds with 403 + X-CSRF-Retry header (cookie expired), uses the
// fresh token from the response body and retries once.
(function () {
  'use strict';

  // Token is always hex (crypto.randomBytes.toString('hex')), no URL-encoding concerns.
  function getCsrfToken() {
    var match = document.cookie.match('(?:^|; )csrf-token=([a-f0-9]*)');
    return match ? match[1] : '';
  }

  function isStateChanging(method) {
    return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
  }

  var originalFetch = window.fetch;
  window.fetch = function (input, init) {
    var self = this;
    init = init || {};
    var method = (init.method || 'GET').toUpperCase();

    if (!isStateChanging(method)) {
      return originalFetch.call(self, input, init);
    }

    // Clone init to avoid mutating the caller's object
    var fetchInit = Object.assign({}, init);
    fetchInit.headers = new Headers(init.headers || {});
    if (!fetchInit.headers.has('X-CSRF-Token')) {
      fetchInit.headers.set('X-CSRF-Token', getCsrfToken());
    }

    return originalFetch.call(self, input, fetchInit).then(function (response) {
      // If the server says our CSRF cookie was expired, it returns the fresh
      // token in the response body. Use it to retry once.
      if (response.status === 403 && response.headers.get('X-CSRF-Retry') === 'true' && !fetchInit._csrfRetried) {
        return response.json().then(function (body) {
          var retryInit = Object.assign({}, init);
          retryInit.headers = new Headers(init.headers || {});
          retryInit.headers.set('X-CSRF-Token', body.token || getCsrfToken());
          retryInit._csrfRetried = true;
          return originalFetch.call(self, input, retryInit);
        });
      }
      return response;
    });
  };
})();
