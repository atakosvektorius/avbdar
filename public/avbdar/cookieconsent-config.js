/**
 * avbdar: CookieConsent v2 configuration (EN + LT)
 * Copyright (c) 2026 MB Atakos vektorius
 * Released under the MIT License
 *
 * Integrates CookieConsent v2.8.9 with avbdar/analytics.js:
 * - on consent: sends the page_view (idempotent, so repeated onAccept calls do not duplicate it)
 * - on withdrawal / "Clear": calls avAnalytics.forget() so the Worker clears the HttpOnly cookies
 *
 * Adapt: PRIVACY_URL, texts, and the cookie table if you renamed the cookies in the Worker.
 */
(function () {
    'use strict';

    var PRIVACY_URL = '/privacy-policy/';
    var DOMAIN = location.hostname.replace(/^www\./, '');

    // Cookies left by gtag.js / Microsoft Clarity before the migration are erased too.
    // __av_cid / __av_sid are HttpOnly: only the server can clear them (avAnalytics.forget()).
    var ERASE_COOKIES = ['cc_cookie', '_ga', '_ga_*', '_gid', '_clck', '_clsk', 'CLID', 'ANONCHK', 'MR', 'MUID', 'SM'];

    function analyticsPageView() {
        if (window.avAnalytics) window.avAnalytics.pageView();
    }

    function analyticsForget() {
        return window.avAnalytics ? window.avAnalytics.forget() : Promise.resolve();
    }

    // cc.eraseCookies() only takes exact names, so "prefix*" entries are expanded from document.cookie
    function eraseCookies(cc) {
        var present = document.cookie ? document.cookie.split(';').map(function (c) { return c.split('=')[0].trim(); }) : [];
        var names = [];
        ERASE_COOKIES.forEach(function (pattern) {
            if (pattern.slice(-1) !== '*') {
                names.push(pattern);
                return;
            }
            var prefix = pattern.slice(0, -1);
            present.forEach(function (name) {
                if (name.indexOf(prefix) === 0) names.push(name);
            });
        });
        cc.eraseCookies(names);
    }

    function cookieTable(lang) {
        var lt = lang === 'lt';
        return [
            {
                col1: '__av_cid',
                col2: DOMAIN,
                col3: lt ? '400 dienų' : '400 days',
                col4: lt ? 'Atsitiktinis lankytojo ID (HttpOnly, nustato serveris)' : 'Random visitor ID (HttpOnly, set by the server)'
            },
            {
                col1: '__av_sid',
                col2: DOMAIN,
                col3: lt ? '30 min.' : '30 min',
                col4: lt ? 'Sesijos ID (HttpOnly, nustato serveris)' : 'Session ID (HttpOnly, set by the server)'
            }
        ];
    }

    var languages = {
        en: {
            consent_modal: {
                title: 'We value your privacy',
                description: 'We would like to measure visits with Google Analytics. No Google script runs in your browser: ' +
                    'data goes only to our own server, which forwards it without your IP address. ' +
                    '<a href="' + PRIVACY_URL + '" class="cc-link">Privacy policy</a>',
                primary_btn: { text: 'Accept', role: 'accept_all' },
                secondary_btn: { text: 'Reject', role: 'accept_necessary' }
            },
            settings_modal: {
                title: 'Privacy settings',
                save_settings_btn: 'Save settings',
                accept_all_btn: 'Accept all',
                reject_all_btn: 'Clear',
                close_btn_label: 'Close',
                cookie_table_headers: [
                    { col1: 'Name' },
                    { col2: 'Domain' },
                    { col3: 'Expiration' },
                    { col4: 'Description' }
                ],
                blocks: [
                    {
                        title: 'Cookie usage',
                        description: 'This site uses server-side Google Analytics. Page views (page, title, referrer) are sent to our ' +
                            'server on Cloudflare, which forwards them to Google Analytics 4 without your IP address ' +
                            '(only an approximate location: country, region, city). Nothing is collected without your consent.'
                    }, {
                        title: 'Strictly necessary cookies',
                        description: 'cc_cookie stores your consent choice so the banner is not shown again.',
                        toggle: { value: 'necessary', enabled: true, readonly: true }
                    }, {
                        title: 'Analytics cookies',
                        description: 'Set by our server as HttpOnly cookies (no script can read them). They distinguish ' +
                            'returning visits and group page views into sessions.',
                        toggle: { value: 'analytics', enabled: false, readonly: false, reload: 'on_disable' },
                        cookie_table: cookieTable('en')
                    }, {
                        title: 'Remove cookies',
                        description: 'Press “Clear” to withdraw consent and remove the analytics cookies.'
                    }
                ]
            }
        },
        lt: {
            consent_modal: {
                title: 'Gerbiame Jūsų privatumą',
                description: 'Norime matuoti lankomumą su „Google Analytics“. Jūsų naršyklėje nekraunamas joks „Google“ skriptas: ' +
                    'duomenys siunčiami tik į mūsų serverį, kuris juos perduoda be Jūsų IP adreso. ' +
                    '<a href="' + PRIVACY_URL + '" class="cc-link">Privatumo politika</a>',
                primary_btn: { text: 'Sutinku', role: 'accept_all' },
                secondary_btn: { text: 'Nesutinku', role: 'accept_necessary' }
            },
            settings_modal: {
                title: 'Privatumo nustatymai',
                save_settings_btn: 'Išsaugoti pakeitimus',
                accept_all_btn: 'Priimti visus',
                reject_all_btn: 'Išvalyti',
                close_btn_label: 'Uždaryti',
                cookie_table_headers: [
                    { col1: 'Pavadinimas' },
                    { col2: 'Domenas' },
                    { col3: 'Galiojimas' },
                    { col4: 'Paskirtis' }
                ],
                blocks: [
                    {
                        title: 'Slapukų naudojimas',
                        description: 'Svetainė naudoja serverinę „Google Analytics“. Puslapių peržiūros (puslapis, pavadinimas, iš kur atvykote) ' +
                            'siunčiamos į mūsų serverį „Cloudflare“, kuris jas perduoda „Google Analytics 4“ be Jūsų IP adreso ' +
                            '(tik apytikslė vieta: šalis, regionas, miestas). Be sutikimo niekas nerenkama.'
                    }, {
                        title: 'Būtini slapukai',
                        description: 'cc_cookie išsaugo Jūsų sutikimo pasirinkimą, kad pranešimas nebūtų rodomas pakartotinai.',
                        toggle: { value: 'necessary', enabled: true, readonly: true }
                    }, {
                        title: 'Analitikos slapukai',
                        description: 'Juos nustato mūsų serveris kaip HttpOnly slapukus (jų negali skaityti joks skriptas). ' +
                            'Jie atskiria pakartotinius apsilankymus ir sujungia peržiūras į sesijas.',
                        toggle: { value: 'analytics', enabled: false, readonly: false, reload: 'on_disable' },
                        cookie_table: cookieTable('lt')
                    }, {
                        title: 'Pašalinti slapukus',
                        description: 'Spauskite „Išvalyti“, kad atšauktumėte sutikimą ir pašalintumėte analitikos slapukus.'
                    }
                ]
            }
        }
    };

    function start() {
        if (typeof initCookieConsent !== 'function') return;
        var cc = initCookieConsent();

        cc.run({
            current_lang: 'en',
            auto_language: 'document', // uses <html lang="...">; falls back to current_lang
            autoclear_cookies: true,
            page_scripts: false,

            onAccept: function () {
                if (cc.allowedCategory('analytics')) analyticsPageView();
            },

            onChange: function () {
                if (cc.allowedCategory('analytics')) {
                    analyticsPageView();
                } else {
                    analyticsForget();
                    eraseCookies(cc);
                }
            },

            languages: languages
        });

        // "Clear" button: the library does not fire onChange when the state does not change,
        // so withdraw explicitly, then reload.
        document.addEventListener('click', function (e) {
            if (!e.target.closest || !e.target.closest('#s-rall-bn')) return;
            setTimeout(function () {
                analyticsForget().finally(function () {
                    eraseCookies(cc);
                    location.reload();
                });
            }, 200);
        });
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        start();
    } else {
        window.addEventListener('load', start);
    }
})();
