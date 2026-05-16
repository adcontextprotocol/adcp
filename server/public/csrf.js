// Automatically attach the CSRF token header to state-changing fetch requests.
// Reads the csrf-token cookie and sends it as X-CSRF-Token on POST/PUT/DELETE/PATCH.
// If the server responds with 403 + X-CSRF-Retry header (cookie expired), uses the
// fresh token from the response body and retries once.
//
// Also tracks slow API calls (>3s) as PostHog events so we get alerted
// when backend endpoints hang or external services (Stripe, WorkOS) are slow.
(function () {
  'use strict';

  var SLOW_THRESHOLD_MS = 3000;

  function getCsrfToken() {
    var match = document.cookie.match('(?:^|; )csrf-token=([a-f0-9]*)');
    return match ? match[1] : '';
  }

  function isStateChanging(method) {
    return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
  }

  function getPathname(input) {
    try {
      if (typeof input === 'string') {
        return new URL(input, window.location.origin).pathname;
      }
      if (input && input.url) {
        return new URL(input.url, window.location.origin).pathname;
      }
    } catch (_) {}
    return '/unknown';
  }

  // Only attach X-CSRF-Token to same-origin requests. Cross-origin fetches
  // (e.g. third-party SDKs like @daily-co/daily-js calling daily.co) trigger
  // a CORS preflight that fails because the third-party server doesn't list
  // X-CSRF-Token in Access-Control-Allow-Headers — and cross-origin requests
  // don't need our CSRF token anyway (they can't read our session cookie).
  function isSameOrigin(input) {
    try {
      var urlStr = typeof input === 'string' ? input : (input && input.url);
      if (!urlStr) return true; // relative-ish; treat as same-origin
      var url = new URL(urlStr, window.location.origin);
      return url.origin === window.location.origin;
    } catch (_) {
      return true; // on parse failure, default to attaching (preserves prior behavior for relative URLs)
    }
  }

  function trackSlowFetch(input, method, durationMs, status) {
    if (durationMs < SLOW_THRESHOLD_MS) return;
    if (typeof window.posthog === 'undefined' || !window.posthog.capture) return;
    window.posthog.capture('slow_api_call', {
      pathname: getPathname(input),
      method: method,
      duration_ms: Math.round(durationMs),
      status: status,
      page: window.location.pathname,
    });
  }

  var originalFetch = window.fetch;
  window.fetch = function (input, init) {
    var self = this;
    init = init || {};
    var method = (init.method || 'GET').toUpperCase();
    var start = performance.now();

    // GET/HEAD/OPTIONS: no CSRF, just track timing
    if (!isStateChanging(method)) {
      return originalFetch.call(self, input, init).then(function (response) {
        trackSlowFetch(input, method, performance.now() - start, response.status);
        return response;
      }, function (err) {
        trackSlowFetch(input, method, performance.now() - start, 0);
        throw err;
      });
    }

    // Cross-origin state-changing fetches: pass through unmodified so we
    // don't break third-party SDKs (Daily.co, Stripe, etc.) with a CORS
    // preflight on a header those servers don't allowlist.
    if (!isSameOrigin(input)) {
      return originalFetch.call(self, input, init).then(function (response) {
        trackSlowFetch(input, method, performance.now() - start, response.status);
        return response;
      }, function (err) {
        trackSlowFetch(input, method, performance.now() - start, 0);
        throw err;
      });
    }

    // Clone init to avoid mutating the caller's object
    var fetchInit = Object.assign({}, init);
    fetchInit.headers = new Headers(init.headers || {});
    if (!fetchInit.headers.has('X-CSRF-Token')) {
      fetchInit.headers.set('X-CSRF-Token', getCsrfToken());
    }

    return originalFetch.call(self, input, fetchInit).then(function (response) {
      trackSlowFetch(input, method, performance.now() - start, response.status);

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
    }, function (err) {
      trackSlowFetch(input, method, performance.now() - start, 0);
      throw err;
    });
  };
})();
