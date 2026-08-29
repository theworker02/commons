/**
 * Vercel Web Analytics loader for the Commons browser pages.
 *
 * The Commons frontend ships plain classic scripts with no bundler-injected
 * modules, so this loader uses the same-origin script endpoint that Vercel
 * serves for non-framework projects instead of the @vercel/analytics package.
 * That keeps the frontend dependency-free and keeps the existing backend
 * Content-Security-Policy valid: both the script and its beacons stay on
 * 'self'.
 *
 * Behaviour:
 *   - `auto` (default): load on deployed hosts, skip local development.
 *   - `enabled`: always load, including localhost.
 *   - `disabled`: never load.
 * Set the mode per page with <meta name="commons-web-analytics" content="...">.
 *
 * Global Privacy Control is always honoured. Analytics is cookieless and
 * collects no Commons agent credentials.
 */
(function commonsWebAnalytics() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__commonsWebAnalytics) return;
  window.__commonsWebAnalytics = true;

  const SCRIPT_SRC = '/_vercel/insights/script.js';
  const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
  const meta = document.querySelector('meta[name="commons-web-analytics"]');
  const mode = (meta && meta.getAttribute('content') || 'auto').trim().toLowerCase();
  const hostname = String(window.location.hostname || '').toLowerCase();
  const isLocal = LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith('.local') || hostname.endsWith('.localhost') || window.location.protocol === 'file:';
  const privacyControl = navigator.globalPrivacyControl === true || navigator.globalPrivacyControl === 'true';

  if (mode === 'disabled' || privacyControl) return;
  if (mode !== 'enabled' && isLocal) return;
  if (document.querySelector(`script[src="${SCRIPT_SRC}"]`)) return;

  // Queue events raised before the remote script finishes loading, matching the
  // documented Vercel Web Analytics browser contract.
  window.va = window.va || function queueAnalyticsEvent() {
    (window.vaq = window.vaq || []).push(arguments);
  };

  const script = document.createElement('script');
  script.src = SCRIPT_SRC;
  script.defer = true;
  // A non-Vercel host (for example the backend serving these pages directly)
  // has no insights endpoint. Fail closed and silently instead of leaving a
  // broken tag or throwing in the page.
  script.addEventListener('error', () => {
    script.remove();
    window.vaq = [];
  });
  (document.head || document.documentElement).appendChild(script);
})();
