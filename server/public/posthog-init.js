/**
 * PostHog Analytics Initialization
 *
 * Reads config from window.__APP_CONFIG__.posthog (injected by server).
 * Initializes PostHog with autocapture enabled for:
 * - Rage clicks
 * - Dead clicks
 * - Session recordings
 * - Heatmaps
 * - Frontend error tracking
 */

(function() {
  'use strict';

  // Get config from server-injected app config
  const config = window.__APP_CONFIG__;
  if (!config || !config.posthog) {
    return;
  }

  const { apiKey, host } = config.posthog;
  if (!apiKey) {
    return;
  }

  // Load PostHog snippet
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug getPageViewId".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);

  // Initialize with config
  posthog.init(apiKey, {
    api_host: host,
    // Enable features for rage click and session analysis
    autocapture: true,
    capture_pageview: true,
    capture_pageleave: true,
    // Session recordings for debugging user issues
    disable_session_recording: false,
    // Heatmaps for seeing where users click
    enable_heatmaps: true,
    // Respect user privacy preferences
    respect_dnt: true,
    // Store across subdomains (agenticadvertising.org, docs.adcontextprotocol.org)
    cross_subdomain_cookie: true,
    // Mask sensitive data in session recordings
    session_recording: {
      maskAllInputs: true,
      maskInputFn: function(text, element) {
        // Handle null/undefined
        if (!text) {
          return text;
        }
        // Don't mask search inputs
        if (element && (element.type === 'search' || element.name === 'search' || element.name === 'q')) {
          return text;
        }
        // Mask everything else
        return '*'.repeat(text.length);
      },
    },
    // Capture performance metrics
    capture_performance: true,
    // Error tracking - capture unhandled errors and promise rejections
    capture_exceptions: true,
  });

  // Capture unhandled errors (using addEventListener to not overwrite existing handlers)
  window.addEventListener('error', function(event) {
    if (window.posthog && window.posthog.captureException) {
      posthog.captureException(event.error || new Error(event.message), {
        source: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      });
    }
  });

  // Capture unhandled promise rejections
  window.addEventListener('unhandledrejection', function(event) {
    if (window.posthog && window.posthog.captureException) {
      posthog.captureException(event.reason, {
        type: 'unhandledrejection',
      });
    }
  });

  // Identify user if logged in
  const user = config.user;
  if (user && user.id) {
    posthog.identify(user.id, {
      email: user.email,
      name: [user.firstName, user.lastName].filter(Boolean).join(' ') || undefined,
      is_admin: user.isAdmin,
    });
  }
})();
