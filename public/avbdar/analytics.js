/**
 * avbdar: server-side analytics client
 * Copyright (c) 2026 MB Atakos vektorius
 * Released under the MIT License
 *
 * No Google script in the browser: events are POSTed to your own Worker endpoint, which sets an
 * HttpOnly first-party cookie and forwards the data to GA4 (the same /g/collect endpoint gtag.js uses).
 * The Worker re-checks consent server-side from the consent cookie.
 * Engagement time is measured like gtag.js (only while the page is visible) and sent as
 * user_engagement when the page is hidden or left.
 *
 * Usage:
 *   <script defer src="/avbdar/analytics.js"></script>
 *
 * Optional data attributes on the <script> tag:
 *   data-endpoint="/api/metrics"          Worker base path
 *   data-consent-cookie="cc_cookie"       consent cookie name (CookieConsent v2/v3)
 *   data-consent-category="analytics"     category that must be granted
 *   data-auto-pageview="false"            disable the automatic page_view
 *   data-legacy-cookies="_ga,_ga_*,_gid,_clck,_clsk"
 *                                         cookies left by gtag.js / Clarity, erased on load;
 *                                         "" disables the cleanup
 *
 * API:
 *   avAnalytics.trackEvent('generate_lead', { form: 'contact' })
 *   avAnalytics.pageView()
 *   avAnalytics.forget()   // call on consent withdrawal (HttpOnly cookies can only be cleared by the server)
 */
(function () {
    'use strict';

    var script = document.currentScript;
    var data = (script && script.dataset) || {};

    var endpoint = (data.endpoint || '/api/metrics').replace(/\/+$/, '');
    var consentCookie = data.consentCookie || 'cc_cookie';
    var consentCategory = data.consentCategory || 'analytics';
    var autoPageView = data.autoPageview !== 'false';
    var legacyCookies = (data.legacyCookies !== undefined ? data.legacyCookies : '_ga,_ga_*,_gid,_clck,_clsk')
        .split(',')
        .map(function (s) { return s.trim(); })
        .filter(Boolean);

    var MIN_ENGAGEMENT_MSEC = 1000;

    var pageViewSent = false;
    var hitSequence = 0;
    // Visible time not yet reported to GA4 (gtag.js-style engagement)
    var engagedMs = 0;
    var visibleSince = document.visibilityState === 'visible' ? Date.now() : null;

    function pauseEngagement() {
        if (visibleSince === null) return;
        engagedMs += Date.now() - visibleSince;
        visibleSince = null;
    }

    function takeEngagement() {
        var wasVisible = visibleSince !== null;
        pauseEngagement();
        if (wasVisible) visibleSince = Date.now();
        var ms = engagedMs;
        engagedMs = 0;
        return ms;
    }

    function readCookie(name) {
        var parts = document.cookie ? document.cookie.split(';') : [];
        for (var i = 0; i < parts.length; i++) {
            var idx = parts[i].indexOf('=');
            if (idx !== -1 && parts[i].slice(0, idx).trim() === name) return parts[i].slice(idx + 1).trim();
        }
        return null;
    }

    // The consent library may load lazily, so the consent cookie is read directly
    function hasAnalyticsConsent() {
        var raw = readCookie(consentCookie);
        if (!raw) return false;
        var candidates = [raw];
        try { candidates.push(decodeURIComponent(raw)); } catch (e) { /* ignore */ }
        for (var i = 0; i < candidates.length; i++) {
            try {
                var value = JSON.parse(candidates[i]);
                var level = Array.isArray(value.level) ? value.level : value.categories;
                return Array.isArray(level) && level.indexOf(consentCategory) !== -1;
            } catch (e) { /* try next */ }
        }
        return false;
    }

    function trackEvent(name, params) {
        if (!hasAnalyticsConsent()) return Promise.resolve();

        return fetch(endpoint, {
            method: 'POST',
            keepalive: true,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                event_name: name,
                page_location: window.location.href,
                page_title: document.title,
                page_referrer: document.referrer || undefined,
                engagement_time_msec: takeEngagement(),
                hit_sequence: ++hitSequence,
                screen_resolution: window.screen ? window.screen.width + 'x' + window.screen.height : undefined,
                params: params || {}
            })
        }).catch(function () { /* analytics must never break the page */ });
    }

    function pageView() {
        if (pageViewSent || !hasAnalyticsConsent()) return;
        pageViewSent = true;
        takeEngagement(); // time before the page_view (e.g. waiting for consent) is not counted
        trackEvent('page_view');
    }

    // Page hidden or left: report the accumulated visible time (gtag.js user_engagement)
    function flushEngagement() {
        pauseEngagement();
        if (pageViewSent && engagedMs >= MIN_ENGAGEMENT_MSEC) trackEvent('user_engagement');
    }

    function forget() {
        pageViewSent = false;
        return fetch(endpoint + '/forget', {
            method: 'POST',
            keepalive: true
        }).catch(function () { /* ignore */ });
    }

    function eraseLegacyCookies() {
        if (!legacyCookies.length) return;
        var names = document.cookie ? document.cookie.split(';').map(function (c) { return c.split('=')[0].trim(); }) : [];
        var expire = '=; Max-Age=0; Path=/';
        var host = location.hostname;
        var apex = host.replace(/^www\./, '');
        names.forEach(function (name) {
            var match = legacyCookies.some(function (pattern) {
                return pattern.slice(-1) === '*' ? name.indexOf(pattern.slice(0, -1)) === 0 : name === pattern;
            });
            if (!match) return;
            document.cookie = name + expire;
            document.cookie = name + expire + '; Domain=' + host;
            document.cookie = name + expire + '; Domain=.' + apex;
        });
    }

    eraseLegacyCookies();

    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') {
            if (visibleSince === null) visibleSince = Date.now();
        } else {
            flushEngagement();
        }
    });
    // Safari does not always fire visibilitychange when the page is left
    window.addEventListener('pagehide', flushEngagement);

    window.avAnalytics = {
        trackEvent: trackEvent,
        pageView: pageView,
        forget: forget,
        hasAnalyticsConsent: hasAnalyticsConsent
    };

    if (autoPageView) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', pageView);
        } else {
            pageView();
        }
    }
})();
