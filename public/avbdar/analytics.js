/**
 * avbdar: server-side analytics client
 * Copyright (c) 2026 MB Atakos vektorius
 * Released under the MIT License
 *
 * No Google script in the browser: events are POSTed to your own Worker endpoint, which sets an
 * HttpOnly first-party cookie and forwards the data to GA4 Measurement Protocol.
 * The Worker re-checks consent server-side from the consent cookie.
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

    var startedAt = Date.now();
    var pageViewSent = false;

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
                engagement_time_msec: Math.max(1, Date.now() - startedAt),
                params: params || {}
            })
        }).catch(function () { /* analytics must never break the page */ });
    }

    function pageView() {
        if (pageViewSent || !hasAnalyticsConsent()) return;
        pageViewSent = true;
        trackEvent('page_view');
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
