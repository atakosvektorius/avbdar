/**
 * avbdar: lazy loader for CookieConsent
 * Copyright (c) 2026 MB Atakos vektorius
 * Released under the MIT License
 *
 * Loads cookieconsent.css, cookieconsent.js and cookieconsent-config.js on the first user
 * interaction (scroll, key, touch, pointer) or when a [data-cc="c-settings"] element is clicked.
 * Keeps the consent library off the critical rendering path.
 *
 * Usage (files resolved next to this script by default):
 *   <script defer src="/avbdar/cookieconsent-loader.js"></script>
 *
 * Optional data attributes: data-css, data-lib, data-config (explicit URLs).
 */
(function () {
    'use strict';

    var script = document.currentScript;
    var data = (script && script.dataset) || {};
    var base = script && script.src ? script.src.replace(/[^/]*$/, '') : '/';

    var cssUrl = data.css || base + 'cookieconsent.css';
    var libUrl = data.lib || base + 'cookieconsent.js';
    var configUrl = data.config || base + 'cookieconsent-config.js';

    var loaded = false;
    var queueOpenSettings = false;
    var interactionEvents = ['scroll', 'keydown', 'touchstart', 'pointerdown', 'mousemove'];

    function openSettingsIfQueued() {
        if (queueOpenSettings && typeof initCookieConsent === 'function') {
            var cc = initCookieConsent();
            if (cc && typeof cc.showSettings === 'function') {
                cc.showSettings(0);
                queueOpenSettings = false;
            }
        }
    }

    function loadCookieConsent(openSettings) {
        if (openSettings) queueOpenSettings = true;

        if (loaded) {
            openSettingsIfQueued();
            return;
        }
        loaded = true;

        interactionEvents.forEach(function (evt) {
            window.removeEventListener(evt, onUserInteraction, { passive: true });
        });

        if (!document.getElementById('cc-styles')) {
            var link = document.createElement('link');
            link.id = 'cc-styles';
            link.rel = 'stylesheet';
            link.href = cssUrl;
            document.head.appendChild(link);
        }

        var scriptCore = document.createElement('script');
        scriptCore.src = libUrl;
        scriptCore.onload = function () {
            var scriptConfig = document.createElement('script');
            scriptConfig.src = configUrl;
            scriptConfig.onload = openSettingsIfQueued;
            document.body.appendChild(scriptConfig);
        };
        document.body.appendChild(scriptCore);
    }

    function onUserInteraction() {
        loadCookieConsent(false);
    }

    interactionEvents.forEach(function (evt) {
        window.addEventListener(evt, onUserInteraction, { passive: true, once: true });
    });

    document.addEventListener('click', function (e) {
        var trigger = e.target && e.target.closest && e.target.closest('[data-cc="c-settings"], [data-cc="open-settings"]');
        if (trigger) {
            e.preventDefault();
            loadCookieConsent(true);
        }
    });

    window.loadCookieConsent = loadCookieConsent;
})();
