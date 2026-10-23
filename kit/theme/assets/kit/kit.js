/* Puppi3's Creator Kit theme: what ties a page to the rest of the kit, as window.site. Loaded on every page
   (default.hbs), before live-bar.js.
   - Click beacons: links followed to other sites (kind=out), and the LIVE NOW bar's plays and hiccups (live-bar.js),
     counted by the kit's bridge at POST /.site/click (which page and which link, nothing about the visitor).
   - The Social preview button on Ghost's draft previews (/p/<uuid>/): opens the bridge's preview of what publishing
     would post, for staff signed in to Ghost Admin. In Ghost Admin's View site, a Shared posts button: the bridge's
     list of posts shared, where one can be shared again.
   - Icons beside links to the other platforms a creator is on (SoundCloud, Patreon, Substack, Vimeo…) in the footer's
     secondary navigation: Ghost's own social accounts don't cover them, so a site adds them as navigation links and the kit recognises the address. */
(function () {
    'use strict';

    var SVG_NS = 'http://www.w3.org/2000/svg';

    function beacon(url) {   /* a POST that still goes out when the page is left */
        if (navigator.sendBeacon && navigator.sendBeacon(url)) return;
        if (window.fetch) fetch(url, { method: 'POST', keepalive: true }).catch(function () {});
    }

    /* A click beacon: `query` plus the page it's from */
    function sendClick(query) { beacon('/.site/click?' + query + '&from=' + encodeURIComponent(location.pathname)); }

    var site = window.site = window.site || {};
    site.beacon = beacon;
    site.sendClick = sendClick;

    /* Links followed to other sites. A middle click opens the link in a new tab, so it counts too. */
    function linkOut(e) {
        if (e.type === 'auxclick' && e.button !== 1) return;
        var a = e.target.closest && e.target.closest('a[href]');
        if (!a || !/^https?:$/.test(a.protocol) || a.host === location.host) return;
        sendClick('kind=out&to=' + encodeURIComponent(a.href));
    }
    document.addEventListener('click', linkOut, true);
    document.addEventListener('auxclick', linkOut, true);

    /* The Social preview button: only on a draft's preview page */
    var preview = location.pathname.match(/^\/p\/([0-9a-f-]{36})\/?$/);
    if (preview) {
        var button = document.createElement('a');
        button.className = 'kit-preview-button';
        button.href = '/ghost/social-preview/' + preview[1] + '/';
        button.target = '_blank';
        button.rel = 'noopener';
        button.textContent = 'Social preview';
        document.body.appendChild(button);
    }

    /* The Shared posts button: only inside Ghost Admin's View site (the site in a frame on /ghost/; Settings' design
       previews are /ghost/ pages or about:srcdoc themselves, so they don't get it) */
    var inAdmin = false;
    try {
        inAdmin = window.parent !== window && window.parent.location.pathname.indexOf('/ghost') === 0
            && /^https?:$/.test(location.protocol) && location.pathname.indexOf('/ghost') !== 0;
    } catch (e) { /* framed by another site */ }
    if (inAdmin) {
        var shared = document.createElement('a');
        shared.className = 'kit-preview-button';
        shared.href = '/ghost/social-preview/';
        shared.target = '_blank';
        shared.rel = 'noopener';
        shared.textContent = 'Shared posts';
        document.body.appendChild(shared);
    }

    /* Links to other platforms in the footer's navigation get their service's icon (partials/kit/icons.hbs) */
    var SERVICES = [
        [/(^|\.)soundcloud\.com$/, 'soundcloud'], [/(^|\.)mixcloud\.com$/, 'mixcloud'], [/(^|\.)bandcamp\.com$/, 'bandcamp'],
        [/(^|\.)spotify\.com$/, 'spotify'], [/(^|\.)twitch\.tv$/, 'twitch'], [/(^|\.)beatport\.com$/, 'beatport'],
        [/^ra\.co$/, 'ra'], [/(^|\.)vimeo\.com$/, 'vimeo'], [/^podcasts\.apple\.com$/, 'podcasts'],
        [/(^|\.)patreon\.com$/, 'patreon'], [/(^|\.)ko-fi\.com$/, 'kofi'], [/(^|\.)substack\.com$/, 'substack'],
        [/(^|\.)etsy\.com$/, 'etsy'], [/(^|\.)behance\.net$/, 'behance'], [/(^|\.)discord\.(gg|com)$/, 'discord']
    ];
    var links = document.querySelectorAll('.gh-footer-menu a[href]');
    for (var i = 0; i < links.length; i++) {
        var host = links[i].hostname.replace(/^www\./, '');
        for (var j = 0; j < SERVICES.length; j++) {
            if (!SERVICES[j][0].test(host)) continue;
            var svg = document.createElementNS(SVG_NS, 'svg');
            var use = document.createElementNS(SVG_NS, 'use');
            use.setAttribute('href', '#kit-i-' + SERVICES[j][1]);
            svg.setAttribute('aria-hidden', 'true');
            svg.appendChild(use);
            links[i].classList.add('kit-platform-link');
            links[i].insertBefore(svg, links[i].firstChild);
            break;
        }
    }
})();
