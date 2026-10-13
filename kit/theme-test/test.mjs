#!/usr/bin/env node
// Tries the kit's theme (kit/theme/) on the throwaway Ghost in compose.yaml, in a muted Chromium:
// - sets the site up (owner account, theme `kit`, a Live stream URL, a SoundCloud link in the footer's navigation,
//   a published post with a link to another site and a draft)
// - the LIVE NOW bar: hidden while the status says nothing's streaming, shown when it is, a play sends kind=play
// - a link to another site sends kind=out; the draft's preview gets the Social preview button; the footer's
//   SoundCloud link gets its icon, and the footer has the kit's credit line
// The stream and its status are faked in the browser, and the click beacons caught there (no bridge here).
// It replaces all posts on that Ghost, so it refuses anything but localhost.
//
//   docker compose -f kit/theme-test/compose.yaml up -d && node kit/theme-test/test.mjs

import { chromium } from 'playwright';

const BASE = process.env.GHOST_URL || 'http://localhost:2398';
const API = `${BASE}/ghost/api/admin`;
const ADMIN = { name: 'Kit Test', email: 'kit@example.com', password: 'kit-theme-test-1!' };

if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
    console.error(`Refusing to run against ${BASE}: this test replaces posts and is for the local test Ghost only.`);
    process.exit(1);
}

let cookie = '';
async function call(method, url, body) {
    const headers = { Origin: BASE, 'Accept-Version': 'v6.0' };
    if (cookie) headers.Cookie = cookie;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(API + url, { method, headers, body: body && JSON.stringify(body) });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${text.slice(0, 300)}`);
    try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

async function waitForGhost() {
    for (let i = 0; i < 60; i++) {
        try { if ((await fetch(`${API}/site/`)).ok) return; } catch {}
        await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error(`Ghost didn't come up at ${BASE}. Is it running? (see the top of this file)`);
}

// ---- The site
await waitForGhost();
const setup = await call('GET', '/authentication/setup/');
if (!setup.setup[0].status) {
    await call('POST', '/authentication/setup/', { setup: [{ ...ADMIN, blogTitle: 'Kit Test' }] });
}
await call('POST', '/session/', { username: ADMIN.email, password: ADMIN.password });
await call('PUT', '/themes/kit/activate/');
await call('PUT', '/settings/', { settings: [
    { key: 'secondary_navigation', value: JSON.stringify([
        { label: 'SoundCloud', url: 'https://soundcloud.com/kit-test' },
        { label: 'Patreon', url: 'https://www.patreon.com/kit-test' },
        { label: 'Sign up', url: '#/portal/' },
    ]) },
] });
const themeSettings = await call('GET', '/custom_theme_settings/');
await call('PUT', '/custom_theme_settings/', {
    custom_theme_settings: themeSettings.custom_theme_settings.map(s =>
        ({ key: s.key, value: s.key === 'live_stream_url' ? `${BASE}/stream-mp3` : s.value })),
});
for (const p of (await call('GET', '/posts/?limit=all&fields=id')).posts) await call('DELETE', `/posts/${p.id}/`);
const lexical = text => JSON.stringify({ root: { type: 'root', version: 1, direction: null, format: '', indent: 0,
    children: [{ type: 'paragraph', version: 1, direction: null, format: '', indent: 0, children: [
        { type: 'text', version: 1, text, detail: 0, format: 0, mode: 'normal', style: '' },
        { type: 'link', version: 1, url: 'https://example.org/elsewhere', rel: null, target: null, title: null,
          direction: null, format: '', indent: 0,
          children: [{ type: 'text', version: 1, text: 'a link elsewhere', detail: 0, format: 0, mode: 'normal', style: '' }] },
    ] }] } });
const published = (await call('POST', '/posts/', { posts: [
    { title: 'A published post', status: 'published', lexical: lexical('Read this, then follow ') }] })).posts[0];
const draft = (await call('POST', '/posts/', { posts: [
    { title: 'A draft', status: 'draft', lexical: lexical('Not out yet. ') }] })).posts[0];

// ---- The browser
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };

// One second of silence as a WAV: the fake live stream
const rate = 8000, wav = Buffer.alloc(44 + rate);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + rate, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate, 28);
wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write('data', 36); wav.writeUInt32LE(rate, 40);
wav.fill(128, 44);

const browser = await chromium.launch({ args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
try {
    const context = await browser.newContext();
    let live = false, djMount = '/stream-ogg';
    const beacons = [];
    // As TinyIce lists them: its own /_pcm and the mp3 always, the source mount while live
    await context.route('**/live-status.json*', route => route.fulfill({ contentType: 'application/json',
        body: JSON.stringify({ icestats: { source: [{ listenurl: `${BASE}/_pcm` }, { listenurl: `${BASE}/stream-mp3` }]
            .concat(live ? [{ listenurl: `${BASE}${djMount}`, artist: 'Kit Test', title: 'First Track' }] : []) } }) }));
    await context.route('**/stream-mp3*', route => route.fulfill({ contentType: 'audio/wav', body: wav }));
    await context.route('**/.site/click*', route => { beacons.push(new URL(route.request().url())); route.fulfill({ status: 204 }); });
    await context.route('https://example.org/**', route => route.fulfill({ contentType: 'text/html', body: '<p>elsewhere</p>' }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    // Not live: the bar stays hidden
    await page.goto(`${BASE}/`);
    await page.waitForTimeout(1500);
    check(await page.locator('#live-now').count() === 1, 'the LIVE NOW bar is on the page (Live stream URL set)');
    check(await page.locator('#live-now').isHidden(), 'the bar is hidden while nothing is streaming');

    // Live: shown, with the track; play sends kind=play
    live = true;
    await page.reload();
    await page.locator('#live-now').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    check(await page.locator('#live-now').isVisible(), 'the bar shows while the live mount is connected');
    check((await page.locator('.live-bar__track').textContent()) === 'Kit Test – First Track', 'the bar shows the track');
    await page.locator('.live-bar__play').click();
    await page.waitForTimeout(1500);
    const play = beacons.find(u => u.searchParams.get('kind') === 'play');
    check(!!play && play.searchParams.get('from') === '/', 'play sends a kind=play beacon from /');

    // The source mount renamed in TinyIce: the bar still knows it's live (anything but the mp3 it plays and /_...)
    djMount = '/dj-input.ogg';
    await page.reload();
    await page.locator('#live-now').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    check(await page.locator('#live-now').isVisible(), 'the bar shows with the source mount renamed');

    // The footer's SoundCloud and Patreon links get their icons
    check(await page.locator('.gh-footer-menu a.kit-platform-link use[href="#kit-i-soundcloud"]').count() === 1,
        "the footer's SoundCloud link has its icon");
    check(await page.locator('.gh-footer-menu a.kit-platform-link use[href="#kit-i-patreon"]').count() === 1,
        "the footer's Patreon link has its icon");
    check(await page.locator('#kit-i-soundcloud').count() === 1, 'the icon sprite is on the page');
    check((await page.locator('.gh-footer-copyright .kit-credit').textContent()) === "Theme: Puppi3's Creator Kit by DJ Puppi3",
        "the footer has the kit's credit line");

    // A link elsewhere sends kind=out (Ghost adds ?ref=<site> to links out, Settings → Analytics → Outbound link tagging)
    await page.goto(`${BASE}/${published.slug}/`);
    await page.locator('a[href^="https://example.org/elsewhere"]').click();
    await page.waitForTimeout(1000);
    const out = beacons.find(u => u.searchParams.get('kind') === 'out');
    check(!!out && out.searchParams.get('to').startsWith('https://example.org/elsewhere') &&
        out.searchParams.get('from') === `/${published.slug}/`, 'a link to another site sends kind=out with to and from');
    check(!beacons.some(u => u.searchParams.get('kind') === 'out' && new URL(u.searchParams.get('to')).host === new URL(BASE).host),
        'links within the site send nothing');

    // The draft's preview gets the Social preview button; a published post doesn't
    await page.goto(`${BASE}/p/${draft.uuid}/`);
    const button = page.locator('a.kit-preview-button');
    check(await button.count() === 1 && (await button.getAttribute('href')) === `/ghost/social-preview/${draft.uuid}/`,
        "the draft's preview has the Social preview button");
    await page.goto(`${BASE}/${published.slug}/`);
    check(await page.locator('a.kit-preview-button').count() === 0, 'a published post has no Social preview button');

    // Turned off: no Live stream URL, no bar
    await call('PUT', '/custom_theme_settings/', {
        custom_theme_settings: themeSettings.custom_theme_settings.map(s =>
            ({ key: s.key, value: s.key === 'live_stream_url' ? '' : s.value })),
    });
    await page.goto(`${BASE}/`);
    check(await page.locator('#live-now').count() === 0, 'no bar when the Live stream URL is empty');

    check(errors.length === 0, `no script errors${errors.length ? ': ' + errors.join('; ') : ''}`);
} finally {
    await browser.close();
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
